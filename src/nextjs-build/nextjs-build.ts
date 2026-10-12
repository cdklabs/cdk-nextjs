import { execFileSync, execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  Dirent,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  cpSync,
  openSync,
  readSync,
  renameSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { join as joinPosix } from "node:path/posix";
import { Annotations } from "aws-cdk-lib";
import { Architecture } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
// eslint-disable-next-line import/no-extraneous-dependencies
import getDebug from "debug";
import {
  DEFAULT_FUNCTION_GROUP,
  FUNCTION_GROUPS_ENV_VAR,
  FunctionGroupSpec,
  validateFunctionGroups,
} from "../adapter/function-groups";
import { CDK_NEXTJS_VERSION } from "../cdk-nextjs-version";
import { LOG_PREFIX, NextjsType } from "../constants";
import { NextjsBaseProps } from "../root-constructs/nextjs-base-construct";
import {
  ADAPTER_DIR_NAME,
  AdapterManifest,
  MANIFEST_FILE_NAME,
  PUBLIC_FILES_FILE_NAME,
  RUNTIME_DIR_NAME,
  groupStagingDirName,
} from "../runtime/manifest";
import { readPublicFiles } from "../runtime/public-files";
import {
  assetPrefixPath,
  normalizeBasePath,
  relativeAssetPrefix,
} from "../utils/base-path";
import { deploymentBuildId } from "../utils/deployment-build-id";
import {
  getLambdaArchitecture,
  toNodeArchitecture,
} from "../utils/get-architecture";

/**
 * Lambda's hard limit on the unzipped size of a function's code, which
 * CloudFormation only enforces at deploy time. Measured at synth instead, so the
 * error names the group and arrives in seconds rather than minutes.
 * @see https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
 */
const LAMBDA_UNZIPPED_LIMIT_BYTES = 250 * 1024 * 1024;

/**
 * Opens the patch `patchFetchInClientJs` prepends to a client chunk, followed by
 * a hash of the patch itself, so a second synth over the same `.next` is a no-op
 * while one by a cdk-nextjs with a different `patch-fetch.js` replaces it.
 */
const PATCH_FETCH_MARKER = "/* cdk-nextjs:patch-fetch";
/** Closes the prepended patch; the chunk's own content starts after it. */
const PATCH_FETCH_END_MARKER = "/* cdk-nextjs:patch-fetch:end */";

const debug = getDebug("cdk-nextjs:nextjs-build");

export interface NextjsBuildProps {
  /**
   * @see {@link NextjsBaseProps["buildCommand"]}
   */
  readonly buildCommand: NextjsBaseProps["buildCommand"];
  /**
   * Directory where the Next.js application is located for local builds.
   * This should contain the package.json and Next.js application files.
   */
  readonly buildDirectory: string;
  readonly nextjsType: NextjsType;
  /**
   * @see {@link NextjsBaseProps.skipBuild}
   */
  readonly skipBuild?: boolean;
  /**
   * Route groups to package into separate Lambda functions. Only the two
   * Functions `NextjsType`s pass this; see `NextjsFunctionGroup`.
   */
  readonly functionGroups?: NextjsFunctionGroupRoutes[];
  /**
   * Lambda architecture the Functions types deploy, which decides the `sharp`
   * binaries staged into the deployment roots. Ignored by the Containers
   * types, whose image is built for the synth machine.
   * @default - the architecture of the machine running synth
   */
  readonly architecture?: Architecture;
}

/**
 * The part of a function group `NextjsBuild` needs: which routes it owns. The
 * per-group Lambda `overrides` are `NextjsFunctions`' business.
 */
export interface NextjsFunctionGroupRoutes {
  readonly name: string;
  readonly routes: string[];
}

/** One staged deployment root, and the function group it belongs to. */
export interface NextjsDeploymentRoot {
  /**
   * Group name, `default` for the implicit group that owns every unassigned
   * route. The only entry is `default` when `functionGroups` is not used.
   */
  readonly name: string;
  /** Absolute path to the deployment root: the Lambda zip asset's source. */
  readonly path: string;
  /**
   * Route templates this root's package holds, as the adapter assigned them.
   * Empty is legal: the default group still serves `/_next/image`, the static
   * files the runtime reads off disk, and anything the catch-all routes to it.
   */
  readonly routes: string[];
}

/**
 * One behavior that routes a function group's URLs to it, as the adapter
 * checked them against what each group was packaged with.
 */
export interface NextjsFunctionGroupBehavior {
  /** The function group the behavior routes to. */
  readonly group: string;
  /**
   * The group pattern it came from (`/blog/**`), or the parent of an optional
   * catch-all a subtree pattern moved into the group (`/blog` for
   * `/blog/[[...slug]]`), which that subtree's behavior does not match.
   */
  readonly route: string;
  /**
   * The CloudFront path pattern, before basePath and without a leading slash:
   * `blog/*`, `pricing`, `pricing/` for a `trailingSlash` app, and
   * `_next/data/<buildId>/blog/*` for a group owning a Pages Router page.
   */
  readonly pattern: string;
}

/**
 * What every deployment root is staged for: the build's `architecture`, else
 * the synth machine's. Containers ignore it: Docker builds their image
 * natively, so it can only match the synth machine.
 */
export function deploymentArchitecture(props: NextjsBuildProps): Architecture {
  const isFunctions =
    props.nextjsType === NextjsType.GLOBAL_FUNCTIONS ||
    props.nextjsType === NextjsType.REGIONAL_FUNCTIONS;
  return (isFunctions && props.architecture) || getLambdaArchitecture();
}

export interface PublicDirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

/**
 * Builds Next.js assets.
 * @link https://nextjs.org/docs/pages/api-reference/next-config-js/output
 */
export class NextjsBuild extends Construct {
  /**
   * Unique id for this deployment. Used to partition cache storage and as
   * metadata for static assets in S3 bucket.
   *
   * Next.js's build ID, suffixed with the app's `deploymentId` when it sets
   * one. The build ID alone is not unique per deployment: setting
   * `deploymentId` (or building with `NEXT_DEPLOYMENT_ID`) turns on skew
   * protection, and next.js then *pins* the build ID to the constant
   * `build-TfctsWXpff2fKS` — see `getBuildId` in `next/dist/build/index.js`,
   * which does that deliberately so that tooling doing
   * `.replace(escapedBuildId, …)` still has something to replace. Two
   * successive deployments of such an app would share one cache prefix and one
   * revalidation-table partition, and the new one would read the previous
   * one's prerenders. Appending the deployment ID restores the "one
   * deployment, one partition" invariant that ID exists to carry.
   *
   * Nothing routes on this value — the `/_next/data/<buildId>/…` URL space is
   * routed on Next.js's own build ID, which is what the app's client bundles
   * carry — so it is free to be longer than next.js's own.
   */
  buildId: string;
  /**
   * Absolute path to the init cache directory
   * @example "/Users/john/myapp/.next/cdk-nextjs-init-cache"
   */
  initCacheDir: string;
  /**
   * Absolute path to public. Use by CloudFront/ALB to create behaviors/rules
   * @example "/Users/john/myapp/public"
   */
  publicDirEntries: PublicDirEntry[];
  /**
   * The JavaScript file Node.js runs to serve requests, relative to the
   * deployment root. cdk-nextjs's own container shell, not `next build` output,
   * so it is the same path for every app.
   * @example "cdk-nextjs-runtime/server.mjs"
   */
  relativePathToEntrypoint: string;
  /**
   * Absolute path to the .next directory containing Next.js build artifacts
   */
  dotNextPath: string;
  /**
   * The Next.js app's own `basePath` — the URL prefix it generates its links and
   * asset hrefs under — as the adapter manifest recorded it. Normalized to a bare path segment, empty when the app sets none. Exposed so
   * root constructs can reconcile it with the CDK `basePath` prop, which is a
   * distinct thing; see `resolveBasePath`.
   */
  nextConfigBasePath: string;
  /**
   * The Next.js app's own `assetPrefix`, as a path with a leading slash and no
   * trailing one, empty when the app sets none or sets an absolute URL (which
   * names an origin cdk-nextjs does not serve).
   *
   * Exposed because it is the shape of `assetPrefix` the regional
   * `NextjsType`s cannot serve — see `warnUnservedAssetPrefix`. What the
   * distribution has to answer on is {@link nextConfigAssetPrefixPath}, which
   * also covers the path an absolute prefix carries.
   */
  nextConfigAssetPrefix: string;
  /**
   * The path portion of the app's `assetPrefix`, whichever form it takes: "/cdn"
   * for both `assetPrefix: "/cdn"` and `assetPrefix:
   * "https://cdn.example.com/cdn"`, empty when there is no path to answer on.
   *
   * Exposed because it is a URL prefix the distribution has to answer on: Next.js
   * emits `<assetPrefix>/_next/static/...` for every bundle and compiles a rewrite
   * that serves those URLs' paths itself, while the objects live in S3 under
   * `<basePath>/_next/static/...`.
   */
  nextConfigAssetPrefixPath: string;
  /**
   * Every staged deployment root, one per function group, `default` first: the
   * staged union of each group's shipped outputs and their traced assets,
   * written by the adapter's `onBuildComplete`. Exactly one entry (named
   * `default`, at `.next/cdk-nextjs-adapter/app`) unless `functionGroups`
   * splits the app. The Lambda zip assets; Containers `COPY` the `default` one.
   */
  deploymentRoots: NextjsDeploymentRoot[];
  /**
   * What routes each non-default function group's URLs to it, most specific
   * first — the order CloudFront has to see them in, since it stops at the
   * first match. Empty unless `functionGroups` splits the app.
   */
  functionGroupBehaviors: NextjsFunctionGroupBehavior[];
  /**
   * From the deployment root to the Next.js project dir, POSIX, `""` when
   * the app is at the repo root. The runtime `chdir`s here; Containers pass it to
   * their Dockerfile so `.next/static` and `public` land in the same place.
   * @see AdapterManifest.relativeProjectDir
   */
  relativeProjectDir: string;
  /**
   * The architecture every deployment root's native dependencies (`sharp`)
   * were staged for. The Lambdas deploying them must use the same one.
   */
  architecture: Architecture;

  private props: NextjsBuildProps;
  private buildCommand: string;

  constructor(scope: Construct, id: string, props: NextjsBuildProps) {
    super(scope, id);
    this.props = props;
    this.dotNextPath = join(props.buildDirectory, ".next");

    this.buildCommand = props.buildCommand || "npm run build";

    // Set init cache directory path
    this.initCacheDir = join(
      props.buildDirectory,
      ".next",
      "cdk-nextjs-init-cache",
    );

    // Before the build, not after it: the build is minutes long, and the env var
    // it passes groups through is only set for a non-empty array — so an invalid
    // `functionGroups` (an empty array, a reserved name, a group owning no
    // routes) would otherwise be reported as "the build staged the wrong
    // groups", after paying for the build, instead of as the prop error it is.
    if (props.functionGroups) {
      validateFunctionGroups(props.functionGroups as FunctionGroupSpec[]);
    }

    // Execute local build process
    if (props.skipBuild !== true) {
      this.runNextBuild();
    } else {
      debug(`${LOG_PREFIX} Skipping: ${this.buildCommand}`);
    }

    // First, before anything else reads `.next`: a missing manifest is the one
    // error that names the cause (no build, or one without the adapter), where
    // every later read fails with a bare ENOENT.
    const manifest = this.readAdapterManifest();

    // Deliberately outside the `skipBuild` gate. The patch is a property of
    // *serving* through CloudFront, not of who ran `next build`: without it
    // every POST with a body is rejected by the Lambda Function URL before it
    // reaches the app (see `patchFetchInClientJs`). Running it only inside
    // `runNextBuild` meant `skipBuild: true` silently shipped an app whose
    // server actions and POST route handlers all returned 403.
    if (props.nextjsType === NextjsType.GLOBAL_FUNCTIONS) {
      this.patchFetchInClientJs();
    }

    this.buildId = deploymentBuildId(manifest);
    this.publicDirEntries = this.getLocalPublicDirEntries();
    // Next.js's resolved config, the same one it writes into
    // `required-server-files.json`.
    this.nextConfigBasePath = normalizeBasePath(manifest.config.basePath);
    this.nextConfigAssetPrefix = relativeAssetPrefix(
      manifest.config.assetPrefix,
    );
    this.nextConfigAssetPrefixPath = assetPrefixPath(
      manifest.config.assetPrefix,
    );

    const isFunctions =
      props.nextjsType === NextjsType.GLOBAL_FUNCTIONS ||
      props.nextjsType === NextjsType.REGIONAL_FUNCTIONS;

    this.relativeProjectDir = manifest.relativeProjectDir;
    this.relativePathToEntrypoint = joinPosix(RUNTIME_DIR_NAME, "server.mjs");
    this.architecture = deploymentArchitecture(props);
    this.deploymentRoots = this.resolveDeploymentRoots(manifest);
    this.functionGroupBehaviors = manifest.behaviors ?? [];

    // Only the RegionalContainers image carries `public/`: nothing is in front
    // of it to answer those paths from S3. Every other type lists it here and
    // reads a file the edge didn't route to S3 (a rewrite onto it) from there.
    const publicOnDisk = props.nextjsType === NextjsType.REGIONAL_CONTAINERS;
    if (publicOnDisk) {
      // Its generated Dockerfile `COPY`s `public`, which fails the image build
      // when the app has none. An empty directory is what `next start` sees
      // for an app without one anyway, and git doesn't track it.
      mkdirSync(join(props.buildDirectory, "public"), { recursive: true });
    }

    for (const root of this.deploymentRoots) {
      this.stageRuntime(root.path, isFunctions, publicOnDisk);
      // Functions run on the Lambda managed runtime (Amazon Linux 2023, glibc),
      // for the architecture their Lambda deploys, whatever this machine is;
      // Containers run on node:24-alpine (musl).
      this.stageSharpForTarget(
        root,
        join(root.path, this.relativeProjectDir),
        `${isFunctions ? "linux" : "linuxmusl"}-${toNodeArchitecture(this.architecture)}`,
      );
      this.warnOnForeignNativeBinaries(
        root,
        `linux-${toNodeArchitecture(this.architecture)}`,
      );

      if (isFunctions) {
        this.assertUnderLambdaLimit(root);
      }
    }
  }

  /**
   * Line up the groups the props asked for with the roots the build actually
   * staged, and fail loudly when they disagree.
   *
   * They can disagree in both directions, and both mean the same thing — the
   * `.next` on disk came from a build that did not see this `functionGroups` —
   * but the causes differ: `skipBuild: true` with a build run by hand, or a
   * stale `.next` from before the prop changed. Either way every later symptom
   * (a Lambda missing an entrypoint, a CloudFront behavior pointing at a
   * function that cannot serve it) is this, several steps downstream.
   */
  private resolveDeploymentRoots(
    manifest: AdapterManifest,
  ): NextjsDeploymentRoot[] {
    const staged = manifest.groups;

    // Names *and* routes: moving `/reports/**` into an existing group keeps the
    // names and still leaves that group's zip without the reports entrypoints.
    // Order is not: assignment and CloudFront behaviors both go most specific
    // first, and no two distinct patterns tie on a URL (`function-groups.ts`),
    // so reordering groups or routes is the same split.
    // Already validated in the constructor, so this is absent or non-empty.
    const wanted = this.props.functionGroups?.length
      ? toFunctionGroupSpecs(this.props.functionGroups)
      : undefined;
    const got = manifest.functionGroups;

    if (
      JSON.stringify(sortedGroupSpecs(wanted)) !==
      JSON.stringify(sortedGroupSpecs(got))
    ) {
      throw new Error(
        `${LOG_PREFIX} \`functionGroups\` asks for ` +
          `${wanted ? JSON.stringify(wanted) : "no splitting"} but the build ` +
          `in ${this.dotNextPath} was split into ` +
          `${got ? JSON.stringify(got) : "a single deployment root"}. ` +
          `Groups are resolved during \`next build\` (cdk-nextjs passes them in ` +
          `via ${FUNCTION_GROUPS_ENV_VAR}), so this means the build output is ` +
          `stale, or \`skipBuild: true\` and the build was run without that ` +
          `variable set.`,
      );
    }

    const names = staged ? Object.keys(staged) : [DEFAULT_FUNCTION_GROUP];
    const roots = names.map((name) => ({
      name,
      path: join(
        this.dotNextPath,
        ADAPTER_DIR_NAME,
        ...groupStagingDirName(staged ? name : undefined).split("/"),
      ),
      routes: staged?.[name] ?? [],
    }));

    // `default` first, so any "the root" caller gets the group that owns
    // everything unassigned.
    roots.sort((a, b) =>
      a.name === DEFAULT_FUNCTION_GROUP
        ? -1
        : b.name === DEFAULT_FUNCTION_GROUP
          ? 1
          : a.name.localeCompare(b.name),
    );

    for (const root of roots) {
      if (!existsSync(root.path)) {
        throw new Error(
          `${LOG_PREFIX} The deployment root for function group ` +
            `"${root.name}" is missing from ${root.path}, though the adapter ` +
            `manifest lists it. The \`.next\` directory has been modified since ` +
            `\`next build\` ran.`,
        );
      }
    }
    return roots;
  }

  /**
   * `next build` traces native addons from the machine it runs on, and only
   * `sharp` is swapped for the target. Anything else built for another platform
   * fails with MODULE_NOT_FOUND or ERR_DLOPEN_FAILED on the first request that
   * loads it, so say which package at synth. A warning, not an error: some
   * addons are optional (`ws`'s `bufferutil`, `fsevents`) and fall back to JS.
   *
   * Only the OS and CPU are checked: glibc and musl builds share a header.
   */
  private warnOnForeignNativeBinaries(
    root: NextjsDeploymentRoot,
    target: string,
  ): void {
    const foreign = findForeignNativePackages(root.path, target);
    if (!foreign.length) {
      return;
    }
    Annotations.of(this).addWarningV2(
      "cdk-nextjs:foreignNativeBinaries",
      `${LOG_PREFIX} Deployment root "${root.name}" has native binaries ` +
        `built for a platform other than ${target}, which it runs on: ` +
        `${foreign.join(", ")}. \`next build\` traced them from this machine, ` +
        `so they fail on the first request that loads them unless the package ` +
        `falls back without them. Build on ${target}, or replace each with ` +
        `the ${target} variant after \`next build\` (e.g. \`npm pack\` it in ` +
        `your \`buildCommand\`). See https://github.com/cdklabs/cdk-nextjs/` +
        `blob/main/docs/native-dependencies-guide.md`,
    );
  }

  /**
   * Lambda enforces 250 MB unzipped at CloudFormation time, which is minutes
   * into a deploy and reports only a size. Splitting exists to stay under that
   * cap, so the error that tells you to split further has to name the group, its
   * size, and what to do — and arrive at synth.
   */
  private assertUnderLambdaLimit(root: NextjsDeploymentRoot): void {
    const bytes = storedSize(root.path);
    debug(
      `${LOG_PREFIX} Deployment root "${root.name}" is ${(bytes / 1e6).toFixed(1)} MB unzipped`,
    );
    if (bytes <= LAMBDA_UNZIPPED_LIMIT_BYTES) {
      return;
    }
    const mb = (value: number) => `${(value / 1024 / 1024).toFixed(0)} MB`;
    const isSplit = this.deploymentRoots.length > 1;
    throw new Error(
      `${LOG_PREFIX} Function group "${root.name}" is ${mb(bytes)} unzipped, ` +
        `over Lambda's ${mb(LAMBDA_UNZIPPED_LIMIT_BYTES)} limit. ` +
        (isSplit
          ? `Split its routes further, or move some of them into another group: ` +
            `the cap is per function, so the shared \`next\` closure every group ` +
            `duplicates costs nothing against any single budget.`
          : `Use the \`functionGroups\` prop to package routes into separate ` +
            `functions. Note that splitting only removes route-local code — ` +
            `anything reachable from a shared layout or the \`next\` runtime is ` +
            `in every group.`),
    );
  }

  /**
   * Read the manifest the adapter's `onBuildComplete` wrote.
   *
   * Its absence means `next build` ran without cdk-nextjs's adapter registered
   * (or with a stale `next.config`), which is worth saying plainly here: every
   * later failure — a Lambda that cannot find `manifest.json`, an empty asset —
   * is the same cause several steps downstream.
   */
  private readAdapterManifest(): AdapterManifest {
    const manifestPath = join(
      this.dotNextPath,
      ADAPTER_DIR_NAME,
      MANIFEST_FILE_NAME,
    );
    if (!existsSync(manifestPath)) {
      throw new Error(
        `cdk-nextjs adapter manifest not found at ${manifestPath}. ` +
          `"${this.buildCommand}" must run a Next.js build with cdk-nextjs's ` +
          `adapter registered. cdk-nextjs sets \`NEXT_ADAPTER_PATH\` on the ` +
          `build it runs itself, so this usually means either the build command ` +
          `does not reach \`next build\` (a wrapper that drops the environment, ` +
          `or a cached build that did not re-run), or \`skipBuild: true\` and ` +
          `the build happened outside CDK. For the latter, set ` +
          `\`adapterPath: require.resolve("cdk-nextjs/adapter")\` in ` +
          `next.config. A custom \`distDir\` is not supported either: ` +
          `cdk-nextjs reads the build from \`.next\`.`,
      );
    }
    const manifest: AdapterManifest = JSON.parse(
      readFileSync(manifestPath, "utf-8"),
    );
    if (manifest.cdkNextjsVersion !== CDK_NEXTJS_VERSION) {
      throw new Error(
        `The cdk-nextjs adapter manifest at ${manifestPath} was written by ` +
          `cdk-nextjs ${manifest.cdkNextjsVersion ?? "(unknown)"}, but this is ` +
          `cdk-nextjs ${CDK_NEXTJS_VERSION}. The adapter that wrote it and the ` +
          `constructs reading it come from the same package, so this means two ` +
          `cdk-nextjs versions are installed, or the build output is stale.`,
      );
    }
    return manifest;
  }

  /**
   * Copy cdk-nextjs's own bundled request-handling shell and the manifest into
   * `<deploymentRoot>/cdk-nextjs-runtime/`, which is where
   * `deploymentRootOf`/`deployedManifestPath` expect to find them.
   *
   * Only the shell the deployment type actually runs is copied — the Lambda
   * handler for Functions, the `node:http` server for Containers — so nothing
   * ships ~1.5 MB of dead code and the tree says which type produced it. Both
   * are copied from this package's `lib/`, next to the compiled construct.
   *
   * Every group gets the same shell *and the same manifest*: a function only
   * knows which routes it owns so it can say so when misrouted, and that comes
   * from {@link FUNCTION_GROUP_ENV_VAR}, not from a per-group manifest.
   */
  private stageRuntime(
    deploymentRoot: string,
    isFunctions: boolean,
    publicOnDisk: boolean,
  ): void {
    const shell = isFunctions ? "lambda.mjs" : "server.mjs";
    const source = join(__dirname, "..", "runtime", shell);

    const runtimeDir = join(deploymentRoot, RUNTIME_DIR_NAME);
    // Removed rather than merged: a stale shell from the other deployment type
    // would otherwise sit in the asset and change its hash for no reason.
    rmSync(runtimeDir, { recursive: true, force: true });
    mkdirSync(runtimeDir, { recursive: true });
    cpSync(source, join(runtimeDir, shell));
    cpSync(
      join(this.dotNextPath, ADAPTER_DIR_NAME, MANIFEST_FILE_NAME),
      join(runtimeDir, MANIFEST_FILE_NAME),
    );
    if (!publicOnDisk) {
      // The Lambda zips and the GlobalContainers image don't carry `public/`
      // (its bytes are in S3), so the runtime can't list it at start the way
      // the RegionalContainers image does.
      // Listed here, after the build command, so `postbuild` output is in it:
      // a rewrite onto a listed file is then served from S3 rather than 404ing.
      writePublicFileList(
        runtimeDir,
        join(this.props.buildDirectory, "public"),
      );
    }
    debug(
      `${LOG_PREFIX} Staged ${shell} and ${MANIFEST_FILE_NAME} in ${runtimeDir}`,
    );
  }

  /**
   * `NEXT_ADAPTER_PATH` for the build, so `adapterPath` in `next.config` is
   * optional.
   *
   * Next.js reads the variable as the *default* value of `adapterPath`
   * (`next/dist/server/config-shared.js`, `defaultConfig`), so an app that does
   * set `adapterPath` still wins and nothing existing changes.
   *
   * Resolved from the Next.js app, not from cdk-nextjs's own `__dirname` and not
   * left as a bare specifier. Both alternatives were tried and both are wrong:
   *
   * - cdk-nextjs's own location loses because the adapter resolves its sibling
   *   cache handler relative to wherever *it* was loaded from. An adapter loaded
   *   from outside the app's tree hands Next.js a `cacheHandler` outside
   *   `turbopack.root`, which Turbopack rejects outright ("leaves the filesystem
   *   root").
   * - A bare specifier loses because Next.js resolves `adapterPath` from inside
   *   its own config loader, i.e. from `next`'s realpath. Under pnpm that is the
   *   virtual store (`node_modules/.pnpm/next@…/node_modules/next/`), and the
   *   walk up from there never reaches the app's own `node_modules`.
   *
   * Unset when `cdk-nextjs` is not resolvable from the app, which is legitimate:
   * the Next.js app and the CDK app can be separate packages, and only the CDK one
   * necessarily depends on cdk-nextjs. {@link readAdapterManifest} reports the
   * resulting failure and names this case.
   *
   * One setup this cannot serve, and the reason this repo's own examples still set
   * `adapterPath`: a `link:`/`file:` dependency on a cdk-nextjs checkout *outside*
   * the app's project root. The symlink resolves out of the project, so the
   * `cacheHandler` escape above applies. Set `adapterPath` in `next.config` there
   * — it is resolved by the build, after whatever put the adapter in place.
   */
  private adapterPathEnv(): Record<string, string> {
    try {
      return {
        NEXT_ADAPTER_PATH: require.resolve("cdk-nextjs/adapter", {
          paths: [this.props.buildDirectory],
        }),
      };
    } catch {
      debug(
        `${LOG_PREFIX} Could not resolve "cdk-nextjs/adapter" from ` +
          `${this.props.buildDirectory}; leaving NEXT_ADAPTER_PATH unset, so ` +
          `next.config must set \`adapterPath\`.`,
      );
      return {};
    }
  }

  /**
   * Execute local build command in the specified directory
   */
  private runNextBuild() {
    console.log(
      `${LOG_PREFIX} Running: "${this.buildCommand}" in directory: ${this.props.buildDirectory}`,
    );

    // Clean existing cache directory to avoid stale data from previous builds
    if (existsSync(this.initCacheDir)) {
      rmSync(this.initCacheDir, { recursive: true, force: true });
      debug(`Cleaned existing cache directory: ${this.initCacheDir}`);
    }

    try {
      execSync(this.buildCommand, {
        stdio: "inherit",
        cwd: this.props.buildDirectory,
        env: {
          ...process.env,
          CDK_NEXTJS_INIT_CACHE_DIR: this.initCacheDir,
          ...this.adapterPathEnv(),
          // `onBuildComplete` runs inside this process and cannot read CDK
          // props, so the resolved groups travel as JSON. Absent when not
          // splitting, which the adapter reads as "one deployment root".
          ...(this.props.functionGroups?.length
            ? {
                [FUNCTION_GROUPS_ENV_VAR]: JSON.stringify(
                  toFunctionGroupSpecs(this.props.functionGroups),
                ),
              }
            : {}),
        },
      });
    } catch (error) {
      throw new Error(`Local build failed: ${error}`);
    }
  }

  /**
   * Prepend `patch-fetch.js` to the client entrypoint chunks, for
   * `NextjsGlobalFunctions` only.
   *
   * This is what makes POST work at all on that type. CloudFront reaches the
   * server through a Lambda Function URL with `AuthType: AWS_IAM`, signed by an
   * origin access control, and AWS documents the consequence: "If you use PUT or
   * POST methods with your Lambda function URL, your users must compute the
   * SHA256 of the body and include the payload hash value of the request body in
   * the `x-amz-content-sha256` header when sending the request to CloudFront.
   * Lambda doesn't support unsigned payloads."
   *
   * CloudFront signs GETs itself (empty-body hash) but will not hash a body, and
   * a browser has no way to add that header on its own, so an unpatched app
   * answers every server action, form submission and POST route handler with
   * `403 InvalidSignatureException` before the request reaches Next.js. The
   * patch installs `fetch`/`XMLHttpRequest` wrappers that compute the hash.
   *
   * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html
   */
  private patchFetchInClientJs() {
    const staticChunksPath = join(this.dotNextPath, "static", "chunks");
    const chunkFiles = readdirSync(staticChunksPath).filter(
      (file: string) =>
        // main-app- for webpack, turbopack- for turbo
        file.startsWith("main-app-") ||
        (file.startsWith("turbopack-") && file.endsWith(".js")),
    );

    if (chunkFiles.length === 0) {
      throw new Error("No client side js entrypoint files found");
    }

    // Read the patch-fetch.js content
    const patchFetchPath = join(__dirname, "patch-fetch.js");
    const patchFetchContent = readFileSync(patchFetchPath, "utf-8");

    // Prepend patch-fetch logic to each entrypoint, once. Now that this runs
    // outside `runNextBuild`, the same `.next` can be synthesized more than
    // once (`skipBuild: true`, `cdk synth` then `cdk deploy`, a retried
    // deploy), and prepending twice would re-wrap the wrappers.
    for (const chunkFile of chunkFiles) {
      const chunkFilePath = join(staticChunksPath, chunkFile);
      const patchedContent = patchClientChunk(
        readFileSync(chunkFilePath, "utf-8"),
        patchFetchContent,
        chunkFilePath,
      );
      if (patchedContent === undefined) {
        debug(`${LOG_PREFIX} Already patched, skipping: ${chunkFilePath}`);
        continue;
      }
      writeFileSync(chunkFilePath, patchedContent);
    }
  }

  /**
   * Get public directory entries from local filesystem
   */
  private getLocalPublicDirEntries(): PublicDirEntry[] {
    const publicDirPath = join(this.props.buildDirectory, "public");
    if (!existsSync(publicDirPath)) {
      return [];
    }

    return readdirSync(publicDirPath, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
  }

  /**
   * Strip whatever platform-specific Sharp binaries `next build`'s output file
   * tracing staged, since they're the host's (e.g. macOS/glibc) rather than the
   * deployment target's, then install the target's. Skipping this is silent:
   * `imageOptimizer` catches the load failure internally and returns the
   * unoptimized original with an HTTP 200.
   *
   * Only a root with `sharp` staged gets the binaries: the image optimizer
   * brings it into `default`, which serves every `/_next/image`, and another
   * group has it only if its own routes use it. So only `default` warns when
   * it's missing.
   */
  private stageSharpForTarget(
    root: NextjsDeploymentRoot,
    projectDir: string,
    platform: string,
  ) {
    const sharpSource = this.removeExistingSharpBinaries(root.path, projectDir);
    if (!sharpSource) {
      if (root.name === DEFAULT_FUNCTION_GROUP) {
        console.warn(
          `${LOG_PREFIX} "sharp" not found in the staged build output. Add "sharp" as a dependency of your Next.js app to enable image optimization.`,
        );
      }
      return;
    }
    this.installSharpPackages(
      sharpBinaryDir(root.path),
      this.getSharpBinaryPackages(sharpSource, platform),
    );
  }

  /**
   * Recursively find and remove existing Sharp platform binaries.
   *
   * `root` is walked whole rather than just its `node_modules`: the staged tree
   * is keyed by repo-root-relative path, so in a monorepo the `node_modules`
   * holding `sharp` is several directories down. {@link isSharpBinaryPackage} is
   * what keeps that from reaching the app's own output — the staged root holds
   * the compiled `.next` as well as the dependencies.
   *
   * @param projectDir the app's directory inside `root`, which `next` is
   * resolved from.
   * @returns the staged `sharp` JS wrapper to install next to, found in the same
   * walk: a root can be hundreds of megabytes, and each group has one.
   */
  private removeExistingSharpBinaries(
    root: string,
    projectDir: string,
  ): string | undefined {
    const sharpCandidates: string[] = [];

    // Links are listed, not followed: every link in a staged root points
    // inside it (`stageFiles` copies the ones that don't), so its target is
    // walked at its own path anyway, and following them is what let a
    // workspace cycle hang the synth.
    const allEntries = listTree(root);

    // Symlinks are unlinked, not `rmSync`ed, and they go first. pnpm points
    // several links at one store directory, and `rmSync(…, { recursive: true,
    // force: true })` *silently no-ops* on a symlink whose target is already
    // gone — `force` swallows the ENOENT its `rmdir` gets. Removing a store
    // directory before its links therefore left dangling
    // `@img/sharp-darwin-arm64` entries in the asset, which is a latent ENOENT
    // in whatever next follows them (`sharp` does, when it looks for binaries).
    const symlinks: string[] = [];
    const directories: string[] = [];

    for (const entry of allEntries) {
      if (entry.isDirectory() && entry.name === "sharp") {
        const path = join(entry.parentPath, entry.name);
        if (existsSync(join(path, "package.json"))) {
          sharpCandidates.push(path);
        }
        continue;
      }
      if (!isSharpBinaryPackage(entry.parentPath, entry.name)) continue;
      const fullPath = join(entry.parentPath, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push(fullPath);
      } else if (entry.isDirectory()) {
        directories.push(fullPath);
      }
    }

    debug(
      `${LOG_PREFIX} Removing ${symlinks.length} Sharp binary symlinks and ${directories.length} directories`,
    );

    for (const path of symlinks) {
      unlinkSync(path);
      debug(`${LOG_PREFIX} Unlinked: ${path}`);
    }
    for (const path of directories) {
      rmSync(path, { recursive: true, force: true });
      debug(`${LOG_PREFIX} Removed: ${path}`);
    }
    return pickStagedSharpPackage(
      sharpCandidates,
      resolveNextSharp(projectDir),
    );
  }

  /**
   * Resolve the `@img/sharp-<platform>` and `@img/sharp-libvips-<platform>`
   * versions to install for a given platform.
   *
   * These must match the `sharp` JS wrapper that output file tracing staged:
   * `sharp`'s `lib/libvips.js` compares the binary's
   * reported libvips version against its own `minimumLibvipsVersion` and
   * throws at load when they disagree. `sharp` pins both in its
   * `optionalDependencies`, so that manifest is the authoritative source.
   */
  private getSharpBinaryPackages(
    sharpSource: string,
    platform: string,
  ): { name: string; version: string }[] {
    // Only for a binary the staged `sharp` does not pin.
    const fallback = [
      { name: `sharp-libvips-${platform}`, version: "1.2.4" },
      { name: `sharp-${platform}`, version: "0.34.5" },
    ];

    const manifest = JSON.parse(
      readFileSync(join(sharpSource, "package.json"), "utf-8"),
    );
    const optionalDependencies: Record<string, string> =
      manifest.optionalDependencies ?? {};

    return fallback.map((pkg) => {
      const version = optionalDependencies[`@img/${pkg.name}`];
      if (!version) {
        console.warn(
          `${LOG_PREFIX} sharp@${manifest.version} does not pin "@img/${pkg.name}"; falling back to ${pkg.version}.`,
        );
        return pkg;
      }
      return { name: pkg.name, version };
    });
  }

  /**
   * Download (with caching) and extract Sharp's platform-specific binary
   * packages into `imgPath`.
   */
  private installSharpPackages(
    imgPath: string,
    packages: { name: string; version: string }[],
  ): void {
    const cacheDir = join(tmpdir(), "cdk-nextjs-sharp-cache");
    mkdirSync(cacheDir, { recursive: true });

    for (const pkg of packages) {
      const targetDir = join(imgPath, pkg.name);
      const url = `https://registry.npmjs.org/@img/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`;

      // Create a consistent filename based on package name and version
      const cacheFileName = `${pkg.name}-${pkg.version}.tgz`;
      const cachedFile = join(cacheDir, cacheFileName);

      // Check if we already have a valid package cached; re-download if
      // a previous run left behind a truncated/corrupt download
      if (existsSync(cachedFile) && this.isCachedFileValid(cachedFile)) {
        debug(
          `${LOG_PREFIX} Using cached ${pkg.name}@${pkg.version} from ${cachedFile}`,
        );
      } else {
        debug(`${LOG_PREFIX} Downloading ${pkg.name}@${pkg.version}...`);

        // Download to a process-unique temp file in the same directory,
        // then atomically rename it onto the shared cache path. Concurrent
        // synth processes (e.g. Turborepo running multiple `cdk` commands)
        // share this cache dir, so writing directly to `cachedFile` risks
        // another process extracting a half-written file. Renaming within
        // the same filesystem is atomic, so readers only ever see a
        // complete file, whichever process wins the race.
        const tempFile = join(
          cacheDir,
          `${cacheFileName}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
        );
        try {
          // --fail makes curl exit non-zero on HTTP errors and --retry
          // handles transient connection drops so a partial transfer
          // isn't cached as valid.
          execFileSync(
            "curl",
            [
              "-L",
              "--fail",
              "--retry",
              "3",
              "--retry-delay",
              "1",
              "-o",
              tempFile,
              url,
            ],
            { stdio: "pipe" },
          );

          if (!this.isCachedFileValid(tempFile)) {
            throw new Error(
              `Downloaded file for ${pkg.name}@${pkg.version} is empty or missing: ${tempFile}`,
            );
          }

          renameSync(tempFile, cachedFile);
        } finally {
          rmSync(tempFile, { force: true });
        }

        debug(
          `${LOG_PREFIX} Cached ${pkg.name}@${pkg.version} to ${cachedFile}`,
        );
      }

      mkdirSync(targetDir, { recursive: true });
      execFileSync(
        "tar",
        ["-xzf", cachedFile, "-C", targetDir, "--strip-components=1"],
        { stdio: "pipe" },
      );

      debug(`${LOG_PREFIX} Installed ${pkg.name}@${pkg.version}`);
    }
  }

  /**
   * Checks that a cached Sharp binary archive is non-empty. Guards against
   * a truncated/corrupt download (e.g. from a dropped connection) being
   * reused across synth operations.
   */
  private isCachedFileValid(filePath: string): boolean {
    try {
      return statSync(filePath).size > 0;
    } catch {
      return false;
    }
  }
}

/**
 * What travels to the adapter in {@link FUNCTION_GROUPS_ENV_VAR}, and what it
 * records back as `AdapterManifest.functionGroups`.
 */
function toFunctionGroupSpecs(
  groups: NextjsFunctionGroupRoutes[],
): FunctionGroupSpec[] {
  return groups.map(({ name, routes }) => ({ name, routes }));
}

/** `groups` in a canonical order, for comparing two of them. */
function sortedGroupSpecs(
  groups: readonly FunctionGroupSpec[] | undefined,
): FunctionGroupSpec[] | undefined {
  return groups
    ?.map(({ name, routes }) => ({ name, routes: [...routes].sort() }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Pick the staged `sharp` JS wrapper out of every copy found in the tree.
 *
 * Unlike a standalone build there is no single `node_modules` to look in: the
 * tree mirrors repo-root-relative paths, so the search is by directory name.
 *
 * An app can have two `sharp` copies at different versions (its own, hoisted,
 * and next's, nested under `next/node_modules`), and every binary goes into the
 * one root `@img`, so the copy pinning them has to be the one `next`'s image
 * optimizer loads: `nextSharp`, when {@link resolveNextSharp} found it. Otherwise
 * shortest path wins as the closest to a hoisted install, sorted for
 * determinism.
 */
export function pickStagedSharpPackage(
  candidates: string[],
  nextSharp?: string,
): string | undefined {
  const used =
    nextSharp &&
    candidates.find((candidate) =>
      nextSharp.startsWith(realpathSync(candidate) + sep),
    );
  if (used) {
    return used;
  }
  candidates.sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (candidates.length > 1) {
    debug(
      `${LOG_PREFIX} Multiple staged "sharp" copies; using ${candidates[0]}`,
    );
  }
  return candidates[0];
}

/**
 * The real path of the `sharp` entry point the staged `next` resolves from
 * `projectDir`, `undefined` when either does not resolve.
 */
export function resolveNextSharp(projectDir: string): string | undefined {
  try {
    // The anchor file needn't exist; `createRequire` only reads its directory.
    const nextPackage = createRequire(
      join(projectDir, "cdk-nextjs-next-resolver.cjs"),
    ).resolve("next/package.json");
    return createRequire(nextPackage).resolve("sharp");
  } catch {
    return undefined;
  }
}

/**
 * Whether the entry `name` in `parentPath` is an `@img/sharp-*` platform binary
 * package, or pnpm's store entry for one.
 *
 * The name alone is not enough to delete a directory by. A route segment called
 * `sharp-edges` stages `.next/server/app/sharp-edges/`, and removing it left the
 * manifest listing an entrypoint that is no longer on disk — every request to
 * that route 500ing with "Could not load the entrypoint". Nor is "a `sharp-`
 * package": `sharp-ico` and `sharp-phash` are unrelated dependencies, and
 * removing them failed the app at runtime with MODULE_NOT_FOUND. So both the
 * scope and the place have to match:
 *
 * - `node_modules/@img/sharp-…`, where every platform binary actually lives
 * - `node_modules/.pnpm/@img+sharp-…@0.35.4`, pnpm's store, whose entries are
 *   also what the `@img` links point at (`sharp-libvips-…` matches the same way)
 *
 * The `node_modules` segment is required as well, so an app directory that
 * happens to be called `@img` or `.pnpm` is still left alone.
 */
export function isSharpBinaryPackage(
  parentPath: string,
  name: string,
): boolean {
  const segments = parentPath.split(sep);
  const parent = segments[segments.length - 1];
  const scoped =
    (parent === "@img" && name.startsWith("sharp-")) ||
    (parent === ".pnpm" && name.startsWith("@img+sharp-"));
  return scoped && segments.includes("node_modules");
}

/**
 * Where the target's `@img/sharp-*` binaries go: `<root>/node_modules/@img`.
 *
 * Not next to the staged `sharp` package. Under pnpm that is
 * `node_modules/.pnpm/sharp@x/node_modules/@img`, which only the store copy of
 * `sharp` resolves from: a dereferenced link to `sharp` (a copy at
 * `app/node_modules/sharp`, say) looks for `@img` from its own path and walks
 * up, never into the store. Both the Functions zip (`zipDirectory`) and the
 * Containers `COPY` keep the links, so it is the store copy that loads, and its
 * walk up reaches the root `node_modules` too, so it serves either layout. It
 * is also where main installed them.
 */
export function sharpBinaryDir(root: string): string {
  return join(root, "node_modules", "@img");
}

/**
 * Every entry under `root`, links listed but not followed.
 *
 * An explicit walk rather than `readdirSync({ recursive: true })`, which on
 * Node 24 descends into symlinked directories itself and so never returns on a
 * cycle — two workspace packages that link each other, which is how pnpm wires a
 * monorepo.
 */
export function listTree(root: string): Dirent[] {
  const entries: Dirent[] = [];
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      entries.push(entry);
      if (entry.isDirectory()) {
        pending.push(join(dir, entry.name));
      }
    }
  }
  return entries;
}

const ELF_MACHINES: Record<number, string> = { 62: "x64", 183: "arm64" };
const MACH_O_MAGICS = [
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe,
];

/**
 * The platform a native addon was compiled for, read from its header:
 * `linux-<arch>`, `darwin` or `win32`, or `undefined` for a file that is none
 * of those.
 */
export function nativeBinaryPlatform(file: string): string | undefined {
  const header = Buffer.alloc(20);
  const fd = openSync(file, "r");
  try {
    readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  const magic = header.readUInt32BE(0);
  if (magic === 0x7f454c46) {
    // e_machine, in the byte order EI_DATA names (2 is big-endian).
    const machine =
      header[5] === 2 ? header.readUInt16BE(18) : header.readUInt16LE(18);
    return `linux-${ELF_MACHINES[machine] ?? `machine-${machine}`}`;
  }
  if (MACH_O_MAGICS.includes(magic)) {
    return "darwin";
  }
  if (header.toString("latin1", 0, 2) === "MZ") {
    return "win32";
  }
  return undefined;
}

/**
 * The packages under `root` that have `.node` addons but none built for
 * `target`, so they'd fail to load there. Returned as `root`-relative paths.
 *
 * A package with addons for several platforms is fine as long as one of them
 * is `target`: packages like `bufferutil` bundle a `darwin` and a
 * `linux-x64` addon and load whichever matches the machine.
 */
export function findForeignNativePackages(
  root: string,
  target: string,
): string[] {
  const packages = new Map<string, { matches: boolean; foreign: boolean }>();
  for (const entry of listTree(root)) {
    if (!entry.isFile() || !entry.name.endsWith(".node")) continue;
    const platform = nativeBinaryPlatform(join(entry.parentPath, entry.name));
    if (!platform) continue;
    const pkg = packageDirOf(root, entry.parentPath);
    const seen = packages.get(pkg) ?? { matches: false, foreign: false };
    if (platform === target) {
      seen.matches = true;
    } else {
      seen.foreign = true;
    }
    packages.set(pkg, seen);
  }
  return [...packages]
    .filter(([, seen]) => seen.foreign && !seen.matches)
    .map(([pkg]) => relative(root, pkg))
    .sort();
}

/** The nearest directory from `dir` up to `root` with a `package.json`. */
function packageDirOf(root: string, dir: string): string {
  for (
    let current = dir;
    current.startsWith(root);
    current = dirname(current)
  ) {
    if (existsSync(join(current, "package.json"))) {
      return current;
    }
    if (current === root) break;
  }
  return dir;
}

/**
 * Write {@link PUBLIC_FILES_FILE_NAME} into a deployment root's runtime
 * directory: every file under `publicDir`, listed the way the runtime would
 * list it off disk (`readPublicFiles`: symlinks followed, `/`-separated,
 * sorted). An app without `public/` gets `[]`.
 */
export function writePublicFileList(runtimeDir: string, publicDir: string) {
  writeFileSync(
    join(runtimeDir, PUBLIC_FILES_FILE_NAME),
    JSON.stringify(readPublicFiles(publicDir)),
  );
}

/**
 * Total bytes of a tree as its deployment zip stores it. `zipDirectory` keeps
 * links as links, so each counts as its target path, not as the target, which
 * is walked at its own path anyway (every link in a staged root points inside
 * it).
 */
export function storedSize(root: string): number {
  let bytes = 0;
  for (const entry of listTree(root)) {
    if (!entry.isDirectory()) {
      bytes += lstatSync(join(entry.parentPath, entry.name)).size;
    }
  }
  return bytes;
}

/**
 * `chunk` with `patch` prepended between `PATCH_FETCH_MARKER` and
 * `PATCH_FETCH_END_MARKER`, or `undefined` when it already carries this exact
 * patch.
 *
 * The opening marker carries a hash of the patch, so a chunk patched by a
 * cdk-nextjs whose `patch-fetch.js` differs (an upgrade, over a `.next` reused
 * with `skipBuild: true`) is not mistaken for current: the old patch is cut off
 * at its end marker and this one put in its place, rather than the old one
 * shipping or both stacking up.
 */
export function patchClientChunk(
  chunk: string,
  patch: string,
  chunkPath: string,
): string | undefined {
  const hash = createHash("sha256").update(patch).digest("hex").slice(0, 16);
  const open = `${PATCH_FETCH_MARKER} ${hash} */`;
  if (chunk.startsWith(`${open}\n`)) {
    return undefined;
  }
  let original = chunk;
  if (chunk.startsWith(PATCH_FETCH_MARKER)) {
    const end = chunk.indexOf(`\n${PATCH_FETCH_END_MARKER}\n`);
    if (end === -1) {
      // Only a pre-release cdk-nextjs wrote the marker without an end, and
      // where its patch stops cannot be told from the chunk's own code.
      throw new Error(
        `${LOG_PREFIX} ${chunkPath} carries a cdk-nextjs fetch patch this ` +
          `version cannot replace. Re-run \`next build\` to regenerate it.`,
      );
    }
    original = chunk.slice(end + PATCH_FETCH_END_MARKER.length + 2);
  }
  return `${open}\n${patch}\n${PATCH_FETCH_END_MARKER}\n${original}`;
}

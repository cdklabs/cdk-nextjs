import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  cpSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { join as joinPosix } from "node:path/posix";
import { Construct } from "constructs";
// eslint-disable-next-line import/no-extraneous-dependencies
import getDebug from "debug";
import {
  DEFAULT_FUNCTION_GROUP,
  FUNCTION_GROUPS_ENV_VAR,
  FunctionGroupSpec,
  validateFunctionGroups,
} from "../adapter/function-groups";
import { LOG_PREFIX, NextjsType } from "../constants";
import { NextjsBaseProps } from "../root-constructs/nextjs-base-construct";
import {
  ADAPTER_DIR_NAME,
  ADAPTER_MANIFEST_VERSION,
  AdapterManifest,
  MANIFEST_FILE_NAME,
  RUNTIME_DIR_NAME,
  groupStagingDirName,
} from "../runtime/manifest";
import { readNextConfigBasePath } from "../utils/base-path";
import { getNodeArchitecture } from "../utils/get-architecture";

/**
 * Lambda's hard limit on the unzipped size of a function's code, which
 * CloudFormation only enforces at deploy time. Measured at synth instead, so the
 * error names the group and arrives in seconds rather than minutes.
 * @see https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
 */
const LAMBDA_UNZIPPED_LIMIT_BYTES = 250 * 1024 * 1024;

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
   * Unique id for Next.js build. Used to partition cache storage and as
   * metadata for static assets in S3 bucket.
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
   * asset hrefs under — read out of the build's `required-server-files.json`.
   * Normalized to a bare path segment, empty when the app sets none. Exposed so
   * root constructs can reconcile it with the CDK `basePath` prop, which is a
   * distinct thing; see `resolveBasePath`.
   */
  nextConfigBasePath: string;
  /**
   * Absolute path to the deployment root: the staged union of every shipped
   * output's traced assets, written by the adapter's `onBuildComplete`. This is
   * the Lambda zip asset and the Docker `COPY` source.
   *
   * With `functionGroups` there is no single root — this is the `default`
   * group's, which exists in every build. Use {@link deploymentRoots} to reach
   * them all.
   * @example "/Users/john/myapp/.next/cdk-nextjs-adapter/app"
   */
  deploymentRootPath: string;
  /**
   * Every staged deployment root, one per function group. Exactly one entry
   * (named `default`) unless `functionGroups` splits the app.
   */
  deploymentRoots: NextjsDeploymentRoot[];
  /**
   * From {@link deploymentRootPath} to the Next.js project dir, POSIX, `""` when
   * the app is at the repo root. The runtime `chdir`s here; Containers pass it to
   * their Dockerfile so `.next/static` and `public` land in the same place.
   * @see AdapterManifest.relativeProjectDir
   */
  relativeProjectDir: string;
  /**
   * Whether the app has any Pages Router route, and therefore a second URL space
   * (`/_next/data/<buildId>/<route>.json`) that carries the same routes. Only
   * `functionGroups` cares: a group's routes have to be reachable in both.
   */
  hasDataRoutes: boolean;

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

    // Execute local build process
    if (props.skipBuild !== true) {
      this.runNextBuild();
    } else {
      debug(`${LOG_PREFIX} Skipping: ${this.buildCommand}`);
    }

    this.buildId = this.getBuildId();
    this.publicDirEntries = this.getLocalPublicDirEntries();
    this.nextConfigBasePath = readNextConfigBasePath(this.dotNextPath);

    const isFunctions =
      props.nextjsType === NextjsType.GLOBAL_FUNCTIONS ||
      props.nextjsType === NextjsType.REGIONAL_FUNCTIONS;

    const manifest = this.readAdapterManifest();
    this.relativeProjectDir = manifest.relativeProjectDir;
    this.relativePathToEntrypoint = joinPosix(RUNTIME_DIR_NAME, "server.mjs");
    this.hasDataRoutes = Object.values(manifest.entrypoints).some(
      (entrypoint) => entrypoint.type === "page",
    );
    this.deploymentRoots = this.resolveDeploymentRoots(manifest);
    this.deploymentRootPath = this.deploymentRoots[0].path;

    for (const root of this.deploymentRoots) {
      this.stageRuntime(root.path, isFunctions);

      // Strip whatever platform-specific Sharp binaries `next build`'s output
      // file tracing staged, since they're the host's (e.g. macOS/glibc) rather
      // than the deployment target's, then install the target's. Skipping this
      // is silent: `imageOptimizer` catches the load failure internally and
      // returns the unoptimized original with an HTTP 200.
      //
      // Functions run on the Lambda managed runtime (Amazon Linux 2023, glibc);
      // Containers run on node:24-alpine (musl). Every group optimizes images,
      // so every root gets the binaries.
      this.removeExistingSharpBinaries(root.path);
      this.installSharpBinariesForTarget(
        root.path,
        isFunctions ? "linux" : "linuxmusl",
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
    const requested = this.props.functionGroups;
    const staged = manifest.groups;

    if (requested && requested.length > 0) {
      validateFunctionGroups(requested as FunctionGroupSpec[]);
    }
    const wanted = requested?.length
      ? [DEFAULT_FUNCTION_GROUP, ...requested.map((group) => group.name)].sort()
      : undefined;
    const got = staged ? Object.keys(staged).sort() : undefined;

    if (JSON.stringify(wanted) !== JSON.stringify(got)) {
      throw new Error(
        `${LOG_PREFIX} \`functionGroups\` asks for ` +
          `${wanted ? `[${wanted.join(", ")}]` : "no splitting"} but the build ` +
          `in ${this.dotNextPath} staged ` +
          `${got ? `[${got.join(", ")}]` : "a single deployment root"}. ` +
          `Groups are resolved during \`next build\` (cdk-nextjs passes them in ` +
          `via ${FUNCTION_GROUPS_ENV_VAR}), so this means the build output is ` +
          `stale, or \`skipBuild: true\` and the build was run without that ` +
          `variable set.`,
      );
    }

    const names = got ?? [DEFAULT_FUNCTION_GROUP];
    const roots = names.map((name) => ({
      name,
      path: join(
        this.dotNextPath,
        ADAPTER_DIR_NAME,
        ...groupStagingDirName(staged ? name : undefined).split("/"),
      ),
      routes: staged?.[name] ?? [],
    }));

    // `default` first, so `deploymentRootPath` and any other "the root" caller
    // gets the group that owns everything unassigned.
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
   * Lambda enforces 250 MB unzipped at CloudFormation time, which is minutes
   * into a deploy and reports only a size. Splitting exists to stay under that
   * cap, so the error that tells you to split further has to name the group, its
   * size, and what to do — and arrive at synth.
   *
   * Symlinks are followed because `cdk-assets` dereferences them when it zips:
   * the tree on disk is smaller than the function Lambda unpacks.
   */
  private assertUnderLambdaLimit(root: NextjsDeploymentRoot): void {
    const bytes = this.dereferencedSize(root.path);
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

  /** Total bytes of a tree with symlinks followed, as zipping it would see it. */
  private dereferencedSize(path: string): number {
    let bytes = 0;
    for (const entry of readdirSync(path, {
      recursive: true,
      withFileTypes: true,
    })) {
      const full = join(entry.parentPath, entry.name);
      if (entry.isDirectory()) {
        continue;
      }
      try {
        // `statSync` follows links, which is the point; a dangling one is
        // skipped rather than thrown on, since it contributes nothing to the zip.
        const stats = statSync(full);
        bytes += stats.isDirectory() ? this.dereferencedSize(full) : stats.size;
      } catch {
        continue;
      }
    }
    return bytes;
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
          `adapter registered in next.config: ` +
          `\`adapter: "cdk-nextjs/lib/adapter/adapter.mjs"\`.`,
      );
    }
    const manifest: AdapterManifest = JSON.parse(
      readFileSync(manifestPath, "utf-8"),
    );
    if (manifest.version !== ADAPTER_MANIFEST_VERSION) {
      throw new Error(
        `The cdk-nextjs adapter manifest at ${manifestPath} is version ` +
          `${manifest.version}, but this version of cdk-nextjs reads version ` +
          `${ADAPTER_MANIFEST_VERSION}. The adapter that wrote it and the ` +
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
  private stageRuntime(deploymentRoot: string, isFunctions: boolean): void {
    const shell = isFunctions ? "lambda.mjs" : "server.mjs";
    const source = join(__dirname, "..", "runtime", shell);
    if (!existsSync(source)) {
      throw new Error(
        `cdk-nextjs's bundled runtime shell not found at ${source}. Ensure the ` +
          `cdk-nextjs package is properly built.`,
      );
    }

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
    debug(
      `${LOG_PREFIX} Staged ${shell} and ${MANIFEST_FILE_NAME} in ${runtimeDir}`,
    );
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
          // `onBuildComplete` runs inside this process and cannot read CDK
          // props, so the resolved groups travel as JSON. Absent when not
          // splitting, which the adapter reads as "one deployment root".
          ...(this.props.functionGroups?.length
            ? {
                [FUNCTION_GROUPS_ENV_VAR]: JSON.stringify(
                  this.props.functionGroups.map((group) => ({
                    name: group.name,
                    routes: group.routes,
                  })),
                ),
              }
            : {}),
        },
      });

      // Copy patch-fetch.js into client JS bundle after build only for NextjsGlobalFunctions
      if (this.props.nextjsType === NextjsType.GLOBAL_FUNCTIONS) {
        this.patchFetchInClientJs();
      }
    } catch (error) {
      throw new Error(`Local build failed: ${error}`);
    }
  }

  /**
   * Find entrypoint client side js files to patch `fetch` only for NextjsGlobalFunctions
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
    if (!existsSync(patchFetchPath)) {
      throw new Error("patch-fetch.js not found");
    }

    const patchFetchContent = readFileSync(patchFetchPath, "utf-8");

    // Prepend patch-fetch logic to each entrypoint
    for (const chunkFile of chunkFiles) {
      const chunkFilePath = join(staticChunksPath, chunkFile);
      const originalContent = readFileSync(chunkFilePath, "utf-8");
      const patchedContent = patchFetchContent + "\n" + originalContent;
      writeFileSync(chunkFilePath, patchedContent);
    }
  }

  /**
   * Get build ID from .next directory
   */
  private getBuildId(): string {
    const buildIdPath = join(this.dotNextPath, "BUILD_ID");
    // Verify BUILD_ID exists (needed for cache partitioning)
    if (!existsSync(buildIdPath)) {
      throw new Error(
        `BUILD_ID file not found at ${buildIdPath}. ` +
          `Ensure Next.js build completed successfully.`,
      );
    }
    return readFileSync(buildIdPath, "utf-8").trim();
  }

  /**
   * Get public directory entries from local filesystem
   */
  private getLocalPublicDirEntries(): PublicDirEntry[] {
    const publicDirPath = join(this.props.buildDirectory, "public");
    if (!existsSync(publicDirPath)) {
      return [];
    }

    try {
      return readdirSync(publicDirPath, { withFileTypes: true }).map(
        (entry: any) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
        }),
      );
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to read public directory: ${error}`);
      return [];
    }
  }

  /**
   * Recursively find and remove existing Sharp platform binaries.
   *
   * `root` is walked whole rather than just its `node_modules`: the staged tree
   * is keyed by repo-root-relative path, so in a monorepo the `node_modules`
   * holding `sharp` is several directories down.
   */
  private removeExistingSharpBinaries(root: string): void {
    if (!existsSync(root)) {
      return;
    }

    try {
      // Use recursive readdirSync to find all Sharp binary directories and symlinks
      const allEntries = readdirSync(root, {
        recursive: true,
        withFileTypes: true,
      });

      // Symlinks are unlinked, not `rmSync`ed, and they go first. pnpm points
      // several links at one store directory, and `rmSync(…, { recursive: true,
      // force: true })` *silently no-ops* on a symlink whose target is already
      // gone — `force` swallows the ENOENT its `rmdir` gets. Removing a store
      // directory before its links therefore left dangling
      // `@img/sharp-darwin-arm64` entries in the asset, which is a latent ENOENT
      // in whatever next dereferences the tree (`cdk-assets` does, when it zips).
      const symlinks: string[] = [];
      const directories: string[] = [];

      for (const entry of allEntries) {
        // `sharp-libvips-<platform>` is covered by `sharp-`; the store keys
        // (`@img+sharp-darwin-arm64@0.35.4`) match on the same substring.
        if (!entry.name.includes("sharp-")) continue;
        // For recursive readdirSync, parentPath contains the full absolute path
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
        try {
          unlinkSync(path);
          debug(`${LOG_PREFIX} Unlinked: ${path}`);
        } catch (error) {
          console.warn(
            `${LOG_PREFIX} Warning: Could not unlink ${path}: ${error}`,
          );
        }
      }
      for (const path of directories) {
        try {
          rmSync(path, { recursive: true, force: true });
          debug(`${LOG_PREFIX} Removed: ${path}`);
        } catch (error) {
          console.warn(
            `${LOG_PREFIX} Warning: Could not remove ${path}: ${error}`,
          );
        }
      }
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} Warning: Could not read node_modules directory: ${error}`,
      );
    }
  }

  /**
   * Install the `sharp` platform binaries the deployment target needs into the
   * staged tree.
   *
   * They go next to the staged `sharp` package rather than at the top of the
   * tree, because that is the first place Node looks from `sharp`'s own
   * `require("@img/sharp-<platform>")` under every installer layout: a sibling
   * `@img` inside `node_modules/.pnpm/sharp@x/node_modules/` for pnpm, and
   * `node_modules/@img/` for a hoisted install.
   *
   * @param libc `"linux"` (glibc, the Lambda managed runtime) or `"linuxmusl"`
   * (Alpine, the container images).
   */
  private installSharpBinariesForTarget(
    deploymentRoot: string,
    libc: "linux" | "linuxmusl",
  ): void {
    const sharpSource = this.findStagedSharpPackage(deploymentRoot);
    if (!sharpSource) {
      console.warn(
        `${LOG_PREFIX} "sharp" not found in the staged build output. Add "sharp" as a dependency of your Next.js app to enable image optimization.`,
      );
      return;
    }

    this.installSharpPackages(
      join(sharpSource, "..", "@img"),
      this.getSharpBinaryPackages(
        sharpSource,
        `${libc}-${getNodeArchitecture()}`,
      ),
    );
  }

  /**
   * Locate `sharp`'s JS wrapper anywhere in the staged tree.
   *
   * Unlike a standalone build there is no single `node_modules` to look in: the
   * tree mirrors repo-root-relative paths, so the search is by directory name.
   */
  private findStagedSharpPackage(deploymentRoot: string): string | undefined {
    const entries = readdirSync(deploymentRoot, {
      recursive: true,
      withFileTypes: true,
    });
    const candidates: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name === "sharp") {
        const path = join(entry.parentPath, entry.name);
        if (existsSync(join(path, "package.json"))) {
          candidates.push(path);
        }
      }
    }
    // Sorted for determinism: an app could have two `sharp` copies at different
    // versions, and which one the *server's* `next` resolves is not knowable
    // from here. Shortest path wins as the closest to a hoisted install.
    candidates.sort((a, b) => a.length - b.length || a.localeCompare(b));
    if (candidates.length > 1) {
      debug(
        `${LOG_PREFIX} Multiple staged "sharp" copies; using ${candidates[0]}`,
      );
    }
    return candidates[0];
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
    sharpSource: string | undefined,
    platform: string,
  ): { name: string; version: string }[] {
    const fallback = [
      { name: `sharp-libvips-${platform}`, version: "1.2.4" },
      { name: `sharp-${platform}`, version: "0.34.5" },
    ];

    if (!sharpSource) {
      return fallback;
    }

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
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }

    for (const pkg of packages) {
      try {
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
            execSync(
              `curl -L --fail --retry 3 --retry-delay 1 -o "${tempFile}" "${url}"`,
              { stdio: "pipe" },
            );

            if (!this.isCachedFileValid(tempFile)) {
              throw new Error(
                `Downloaded file for ${pkg.name}@${pkg.version} is empty or missing: ${tempFile}`,
              );
            }

            renameSync(tempFile, cachedFile);
          } finally {
            if (existsSync(tempFile)) {
              rmSync(tempFile, { force: true });
            }
          }

          debug(
            `${LOG_PREFIX} Cached ${pkg.name}@${pkg.version} to ${cachedFile}`,
          );
        }

        mkdirSync(targetDir, { recursive: true });
        execSync(
          `tar -xzf "${cachedFile}" -C "${targetDir}" --strip-components=1`,
          { stdio: "pipe" },
        );

        debug(`${LOG_PREFIX} Installed ${pkg.name}@${pkg.version}`);
      } catch (error) {
        console.error(`${LOG_PREFIX} Failed to install ${pkg.name}: ${error}`);
        throw error;
      }
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

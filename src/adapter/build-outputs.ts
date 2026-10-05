/* eslint-disable import/no-extraneous-dependencies */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { NextAdapter } from "next";
import { MAX_BUILD_PREFIX_BYTES } from "./cache-utils";
import {
  DEFAULT_FUNCTION_GROUP,
  FUNCTION_GROUPS_ENV_VAR,
  FunctionGroupSpec,
  assertNoI18nSplitting,
  assignRoutesToGroups,
  parseFunctionGroupsEnv,
} from "./function-groups";
import { LOG_PREFIX } from "../constants";
import {
  ADAPTER_DIR_NAME,
  ADAPTER_MANIFEST_VERSION,
  AdapterEntrypoint,
  AdapterEntrypointType,
  AdapterManifest,
  AdapterMiddleware,
  ERROR_PAGE_SUFFIXES,
  MANIFEST_FILE_NAME,
  RUNTIME_DIR_NAME,
  groupStagingDirName,
} from "../runtime/manifest";

/**
 * The `onBuildComplete` argument. Derived from the `next` typings rather than
 * restated so a `next` bump surfaces as a compile error here.
 */
export type BuildCompleteContext = Parameters<
  NonNullable<NextAdapter["onBuildComplete"]>
>[0];

type AdapterOutputs = BuildCompleteContext["outputs"];
/** Any output that we invoke at request time, i.e. not a prerender/static file. */
type InvocableOutput =
  | AdapterOutputs["pages"][number]
  | AdapterOutputs["pagesApi"][number]
  | AdapterOutputs["appPages"][number]
  | AdapterOutputs["appRoutes"][number]
  | NonNullable<AdapterOutputs["middleware"]>;

/**
 * Env files `writeStandaloneDirectory` copies into the standalone tree and that
 * `onBuildComplete` has no equivalent for. Dropping `output: "standalone"`
 * silently drops these unless we stage them ourselves.
 * @see https://nextjs.org/docs/app/api-reference/config/next-config-js/output
 */
const ENV_FILES = [".env", ".env.production"];

/**
 * `next` submodules the *runtime* requires that no app ever reaches, so
 * `next build`'s own trace never covers them. They are required from the app's
 * `next` rather than bundled, deliberately — see `src/runtime/next-modules.ts`
 * — which makes staging their closure this module's job.
 *
 * `serve-static` is in every group: `serveStaticFile`
 * (`src/runtime/static-files.ts`) serves prerendered and static results with it
 * wherever they land. `instrumentation-globals` is required by `loadRuntime`
 * on every cold start (`registerInstrumentation`), so it is staged here rather
 * than trusted to each group's entrypoint trace.
 */
const RUNTIME_NEXT_MODULES = [
  "next/dist/server/serve-static.js",
  "next/dist/server/lib/router-utils/instrumentation-globals.external.js",
];

/**
 * next's image optimizer and the config helpers around it
 * (`src/runtime/image.ts`), whose closure is what brings `sharp` in. Only the
 * `default` group gets them: the edge sends every `/_next/image` request there.
 */
const IMAGE_NEXT_MODULES = [
  "next/dist/server/config-shared.js",
  "next/dist/shared/lib/image-config.js",
  "next/dist/server/image-optimizer.js",
];

/**
 * The file tracer `next build` itself uses, reached through the app's own `next`
 * so that it is the version that matches the files being traced. Not a
 * dependency of cdk-nextjs: bundling a second copy of `@vercel/nft` into the
 * published adapter would add megabytes to every install to do the same job.
 */
const NEXT_FILE_TRACER = "next/dist/compiled/@vercel/nft";

/** The subset of `nodeFileTrace` this module uses. */
type NodeFileTrace = (
  files: string[],
  options: { base: string },
) => Promise<{ fileList: Set<string> }>;

/**
 * Staging key (repo-root-relative POSIX) → absolute source path on the build
 * machine. The deduped union that replaces the standalone tree.
 */
export type StagingPlan = ReadonlyMap<string, string>;

export interface BuildOutputsOptions {
  /**
   * The directory `next build` was invoked from. Defaults to `process.cwd()`,
   * which is the real answer inside `onBuildComplete`; a parameter only so the
   * unit tests can drive the fixtures' synthetic project dirs.
   */
  readonly buildCwd?: string;
  /**
   * Resolved `functionGroups`. Defaults to {@link FUNCTION_GROUPS_ENV_VAR},
   * which is how the constructs get them here: `onBuildComplete` runs inside
   * `next build` and cannot read CDK props.
   *
   * `undefined` means one deployment root holding every route, which is the
   * default and the only thing the Containers types ever do.
   */
  readonly functionGroups?: FunctionGroupSpec[];
}

/** One deployment root: the staging plan for it, and where it goes. */
export interface StagedGroup {
  /**
   * Group name, `default` for the implicit group. Always present — a build with
   * no `functionGroups` produces exactly one {@link StagedGroup} named `default`,
   * so callers never branch on "is this split".
   */
  readonly name: string;
  /**
   * Directory inside `cdk-nextjs-adapter`, POSIX: `app` when not splitting,
   * `groups/<name>` when splitting.
   */
  readonly dirName: string;
  readonly staging: StagingPlan;
}

export interface BuildAdapterManifestResult {
  readonly manifest: AdapterManifest;
  /** One entry per deployment root to stage. Length 1 unless splitting. */
  readonly groups: StagedGroup[];
}

/** A staged deployment root on disk. */
export interface StagedGroupResult {
  readonly name: string;
  /** Absolute path to the deployment root. */
  readonly path: string;
  readonly fileCount: number;
}

export interface WriteBuildOutputsResult extends BuildAdapterManifestResult {
  /** Absolute path to `<distDir>/cdk-nextjs-adapter`. */
  readonly adapterDir: string;
  /** Absolute path to the written manifest. */
  readonly manifestPath: string;
  /** One per deployment root, in the order they were staged. */
  readonly stagedGroups: StagedGroupResult[];
}

/**
 * Build the manifest and staging plan, stage the files, and write the manifest.
 * Called from `onBuildComplete`, which is the only place that holds the build
 * outputs.
 */
export async function writeBuildOutputs(
  ctx: BuildCompleteContext,
  options: BuildOutputsOptions = {},
): Promise<WriteBuildOutputsResult> {
  const adapterDir = join(ctx.distDir, ADAPTER_DIR_NAME);
  const manifestPath = join(adapterDir, MANIFEST_FILE_NAME);

  const { manifest, groups } = buildAdapterManifest(ctx, options);

  // Traced once, here: the trace is async, which is why it cannot happen inside
  // `buildAdapterManifest`. `runtimeClosure` is merged into every group, and
  // `imageClosure` into `default` only, the one group `/_next/image` reaches.
  const runtimeClosure = new Map<string, string>();
  const imageClosure = new Map<string, string>();
  await addRuntimeNextClosure(ctx, runtimeClosure, imageClosure);
  addRequiredServerFiles(ctx, runtimeClosure);

  // A previous build's tree is never additive with this one's: a removed route
  // leaves behind an entrypoint the manifest no longer mentions, a renamed chunk
  // leaves dead bytes inside the 250 MB budget, and a regrouped build leaves a
  // whole deployment root nothing deploys.
  await rm(adapterDir, { recursive: true, force: true });

  const stagedGroups: StagedGroupResult[] = [];
  for (const group of groups) {
    const groupStaging = merged(
      merged(group.staging, runtimeClosure),
      group.name === DEFAULT_FUNCTION_GROUP ? imageClosure : new Map(),
    );
    const path = join(adapterDir, ...group.dirName.split("/"));
    await mkdir(path, { recursive: true });
    await stageFiles(groupStaging, path);
    stagedGroups.push({ name: group.name, path, fileCount: groupStaging.size });
  }

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    manifest,
    groups,
    adapterDir,
    manifestPath,
    stagedGroups,
  };
}

/** Left wins, as everywhere else in this module: first writer of a key keeps it. */
function merged(
  base: StagingPlan,
  additions: ReadonlyMap<string, string>,
): Map<string, string> {
  const result = new Map(base);
  for (const [key, source] of additions) {
    if (!result.has(key)) {
      result.set(key, source);
    }
  }
  return result;
}

/**
 * The pure half of {@link writeBuildOutputs}: everything derived from the build
 * outputs, with no writes. Split out so it can be unit tested against committed
 * `onBuildComplete` fixtures.
 *
 * Throws on any non-Node output and on any staging key two outputs map to
 * different content.
 */
export function buildAdapterManifest(
  ctx: BuildCompleteContext,
  options: BuildOutputsOptions = {},
): BuildAdapterManifestResult {
  const { outputs, repoRoot } = ctx;
  const basePath = ctx.config.basePath || "";
  assertBuildCwd(ctx, options.buildCwd ?? process.cwd());
  const invocable: InvocableOutput[] = [
    ...outputs.pages,
    ...outputs.pagesApi,
    ...outputs.appPages,
    ...outputs.appRoutes,
    ...(outputs.middleware ? [outputs.middleware] : []),
  ];

  assertNodeRuntimes(invocable, outputs.middleware);
  warnOnDroppedRouteConfig(invocable);

  const staticFiles = collectStaticFiles(ctx);

  const entrypoints: Record<string, AdapterEntrypoint> = {};
  for (const { outputs: group, type } of [
    { outputs: outputs.pages, type: "page" as const },
    { outputs: outputs.pagesApi, type: "page-api" as const },
    { outputs: outputs.appPages, type: "app-page" as const },
    { outputs: outputs.appRoutes, type: "app-route" as const },
  ]) {
    for (const output of group) {
      addEntrypoint(entrypoints, repoRoot, output, type, basePath);
    }
  }

  addPrerenderPathnames(
    entrypoints,
    outputs.prerenders,
    ctx.routing.dynamicRoutes,
    basePath,
    `${basePath}/_next/data/${ctx.buildId}/`,
  );

  const pathnames = sortedUnique([
    ...Object.keys(entrypoints),
    ...Object.keys(staticFiles),
  ]);

  const functionGroups =
    options.functionGroups ??
    parseFunctionGroupsEnv(process.env[FUNCTION_GROUPS_ENV_VAR]);
  // i18n is checked first: it rejects the combination outright, and running it
  // after the assignment meant an i18n app got the assignment's "pattern matches
  // no route" error instead — true, but about the wrong thing, since a localized
  // template never matches an unlocalized pattern.
  if (functionGroups) {
    assertNoI18nSplitting(ctx.config.i18n ?? null);
  }
  const assignment = functionGroups
    ? assignRoutesToGroups(
        functionGroups,
        // Keyed on the file, not the output `id`: a Pages Router page and its
        // `/_next/data/<buildId>/<page>.json` route are separate outputs with
        // separate ids backed by one file, and only the page's template matches
        // a group pattern.
        Object.entries(entrypoints).map(([template, entrypoint]) => ({
          template,
          entrypointId: entrypoint.filePath,
          type: entrypoint.type,
        })),
        {
          basePath: ctx.config.basePath || "",
          buildId: ctx.buildId,
          trailingSlash: ctx.config.trailingSlash === true,
          routing: ctx.routing,
        },
      )
    : undefined;

  const manifest: AdapterManifest = {
    version: ADAPTER_MANIFEST_VERSION as 1,
    buildId: ctx.buildId,
    relativeProjectDir: toPosix(relative(repoRoot, ctx.projectDir)),
    config: {
      basePath: ctx.config.basePath || "",
      trailingSlash: ctx.config.trailingSlash === true,
      assetPrefix: ctx.config.assetPrefix || "",
      distDir: toPosix(relative(ctx.projectDir, ctx.distDir)),
      compress: ctx.config.compress !== false,
      generateEtags: ctx.config.generateEtags !== false,
      i18n: ctx.config.i18n ?? null,
      deploymentId: (ctx.config.deploymentId ?? "").replace(
        /[^A-Za-z0-9_-]/g,
        "-",
      ),
    },
    routing: ctx.routing,
    pathnames,
    entrypoints,
    middleware: buildMiddleware(repoRoot, outputs.middleware),
    staticFiles,
    ...(assignment
      ? {
          groups: assignment.templates,
          behaviors: assignment.behaviors,
          functionGroups: functionGroups!.map(({ name, routes }) => ({
            name,
            routes,
          })),
        }
      : {}),
  };
  assertBuildPrefixFits(manifest);

  const groups: StagedGroup[] = assignment
    ? Object.entries(assignment.templates).map(([name, templates]) => ({
        name,
        dirName: groupStagingDirName(name),
        staging: collectGroupStagingPlan(
          ctx,
          invocable,
          entrypoints,
          templates,
        ),
      }))
    : [
        {
          name: DEFAULT_FUNCTION_GROUP,
          dirName: groupStagingDirName(),
          staging: servedStagingPlan(ctx, invocable),
        },
      ];

  return { manifest, groups };
}

/**
 * Fails the build when the `{buildId}/` prefix every cache object is stored
 * under is longer than {@link MAX_BUILD_PREFIX_BYTES}, the room
 * `cacheObjectName` leaves it. Past that, an entry with a long enough name would
 * be rejected by S3 and never cached, with nothing to say why.
 */
function assertBuildPrefixFits(manifest: AdapterManifest): void {
  const { buildId, config } = manifest;
  // `deploymentBuildId`'s, restated: it lives with the constructs.
  const prefix = `${config.deploymentId ? `${buildId}-${config.deploymentId}` : buildId}/`;
  if (Buffer.byteLength(prefix) > MAX_BUILD_PREFIX_BYTES) {
    throw new Error(
      `${LOG_PREFIX} The build ID and deploymentId together are ` +
        `${Buffer.byteLength(prefix) - 1} bytes; cdk-nextjs stores cache ` +
        `entries under them and allows at most ${MAX_BUILD_PREFIX_BYTES - 1}. ` +
        `Use a shorter deploymentId.`,
    );
  }
}

/**
 * One group's slice of the staging plan: the assets of the outputs it owns, and
 * nothing else.
 *
 * Middleware is in every group, not just the default one — it runs on every
 * request wherever that request lands, so it is duplicated by design, as is the
 * `next` closure the entrypoints share. The same goes for the static files the
 * runtime serves itself (`404.html`, `favicon.ico.body`): any group can be asked
 * for them. And so are the not-found and error pages: the runtime renders a
 * 404 or a 500 with whichever of them the shared manifest names
 * (`statusTargets` in `runtime/dispatch.ts`), in whichever group the
 * request reached, so a group without them answered a URL under its own
 * pattern that matches no route with "the deployment package is incomplete".
 *
 * Ownership is matched on the entrypoint's `filePath`, not its `id` or
 * pathname: the manifest's entrypoints are keyed by *template*, an output may
 * back several templates, and {@link addPrerenderPathnames} synthesizes
 * entrypoints that carry the *prerender's* id, which no invocable output has (the
 * root-params app: entrypoint `/en` with `id: "/en"` backed by the output
 * `/[locale]`). The synthesized entrypoint's `filePath` is the owning output's.
 */
function collectGroupStagingPlan(
  ctx: BuildCompleteContext,
  invocable: InvocableOutput[],
  entrypoints: Record<string, AdapterEntrypoint>,
  templates: string[],
): Map<string, string> {
  const basePath = ctx.config.basePath || "";
  const ownedEntrypoints = [
    ...templates,
    ...ERROR_PAGE_SUFFIXES.map((suffix) => `${basePath}${suffix}`),
  ]
    .map((template) => entrypoints[template])
    .filter((entry): entry is AdapterEntrypoint => entry !== undefined);
  const ownedFiles = new Set(ownedEntrypoints.map((entry) => entry.filePath));
  const middleware = ctx.outputs.middleware;
  const owned = invocable.filter(
    (output) =>
      ownedFiles.has(toPosix(relative(ctx.repoRoot, output.filePath))) ||
      output === middleware,
  );
  return servedStagingPlan(ctx, owned);
}

/** {@link collectStagingPlan} for `outputs`, plus the files the runtime serves. */
function servedStagingPlan(
  ctx: BuildCompleteContext,
  outputs: InvocableOutput[],
): Map<string, string> {
  const staging = collectStagingPlan(ctx, outputs);
  stageServedStaticFiles(ctx, staging);
  return staging;
}

/**
 * Job 1: reject non-Node outputs, everywhere.
 *
 * `export const runtime = 'edge'` on a page or route handler lands in
 * `appPages`/`appRoutes`/`pages`/`pagesApi` with `runtime: 'edge'`,
 * `assets: {}`, and an `edgeRuntime` descriptor needing `globalThis._ENTRIES`
 * and a sandbox. Guarding middleware alone would leave a silent failure mode
 * for edge pages: an entrypoint we can't invoke and no assets to invoke it
 * with.
 */
function assertNodeRuntimes(
  invocable: InvocableOutput[],
  middleware: AdapterOutputs["middleware"],
): void {
  const offending = invocable.filter((output) => output.runtime !== "nodejs");
  if (offending.length === 0) {
    return;
  }

  // Middleware is reported separately from routes. Its `sourcePage` is `/`, so
  // folding it in with the routes produces the actively misleading advice to
  // remove `export const runtime = "edge"` from the home page - which is where
  // the edge runtime is not, and may not even exist.
  const offendingMiddleware = middleware && offending.includes(middleware);
  // `.rsc` variants share a `sourcePage` with their HTML sibling, so dedupe.
  const routes = sortedUnique(
    offending
      .filter((output) => output !== middleware)
      .map((output) => `${output.sourcePage} (runtime: "${output.runtime}")`),
  );

  const reasons: string[] = [];
  if (routes.length > 0) {
    reasons.push(
      `cdk-nextjs cannot deploy routes built for the edge runtime. ` +
        `Remove \`export const runtime = "edge"\` from:\n` +
        routes.map((route) => `  - ${route}`).join("\n"),
    );
  }
  if (offendingMiddleware) {
    reasons.push(
      `cdk-nextjs cannot deploy middleware built for the edge runtime ` +
        `(${middleware.filePath}, runtime: "${middleware.runtime}"). ` +
        `Rename it to \`proxy.ts\` (Next.js 16 runs proxy on the Node ` +
        `runtime), or keep \`middleware.ts\` and add ` +
        `\`export const config = { runtime: "nodejs" }\` to it — ` +
        `\`middleware.ts\` defaults to the edge runtime, but does not require it.`,
    );
  }

  throw new Error(
    `${LOG_PREFIX} ${reasons.join("\n")}\n` +
      `The edge runtime is deprecated in Next.js: ` +
      `https://nextjs.org/docs/messages/edge-runtime-deprecated`,
  );
}

/**
 * Warn on route config cdk-nextjs does not honor. An author who set these asked
 * for something explicitly, so say so rather than ignoring it silently; never
 * throw, because route-level `maxDuration` is valid Next.js.
 *
 * `NextjsBuild` runs `next build` with `stdio: "inherit"`, so this reaches the
 * user's terminal. See the plan's "Decisions" for why neither is honored.
 */
function warnOnDroppedRouteConfig(invocable: InvocableOutput[]): void {
  const dropped: Record<"maxDuration" | "preferredRegion", string[]> = {
    maxDuration: [],
    preferredRegion: [],
  };
  for (const output of invocable) {
    if (output.config?.maxDuration !== undefined) {
      dropped.maxDuration.push(output.sourcePage);
    }
    if (output.config?.preferredRegion !== undefined) {
      dropped.preferredRegion.push(output.sourcePage);
    }
  }

  const remedy: Record<"maxDuration" | "preferredRegion", string> = {
    maxDuration:
      "Set the function timeout with the construct's `overrides` prop instead (e.g. `overrides: { nextjsFunctions: { functionProps: { timeout: Duration.seconds(30) } } }`); a Lambda timeout is per-function while `maxDuration` is per-route.",
    preferredRegion:
      "Honoring it would require a multi-region deployment, which this construct does not model.",
  };

  for (const key of ["maxDuration", "preferredRegion"] as const) {
    const routes = sortedUnique(dropped[key]);
    if (routes.length === 0) {
      continue;
    }
    console.warn(
      `${LOG_PREFIX} \`${key}\` is not honored by cdk-nextjs. ` +
        `${routes.length} route(s) set it, including: ${routes.slice(0, 5).join(", ")}` +
        `${routes.length > 5 ? `, and ${routes.length - 5} more` : ""}. ` +
        remedy[key],
    );
  }
}

/**
 * Jobs 2, 3 and 6: the deduped union of every shipped output's traced `assets`,
 * plus each entrypoint file itself, plus the env files, with `assetsHashes` used
 * as a conflict check.
 *
 * Dedup is by key: the traced `next` closure is merged into every output's
 * `assets` (`getSharedNodeAssets` → `sharedNodeAssets`), so N outputs
 * overwhelmingly repeat keys. What the hashes buy is detecting two outputs
 * mapping the **same key to different content**, which is unpackageable into
 * one Lambda — fail the build loudly rather than letting last-write-wins pick.
 */
function collectStagingPlan(
  ctx: BuildCompleteContext,
  invocable: InvocableOutput[],
): Map<string, string> {
  const { repoRoot } = ctx;
  const staging = new Map<string, string>();
  const hashes = new Map<string, string>();

  const add = (key: string, source: string, hash?: string) => {
    assertStagingKey(key, source);
    const existingHash = hashes.get(key);
    if (
      hash !== undefined &&
      existingHash !== undefined &&
      existingHash !== hash
    ) {
      throw new Error(
        `${LOG_PREFIX} Two build outputs map "${key}" to different content ` +
          `(hashes ${existingHash} and ${hash}). One deployment package cannot ` +
          `hold both. This usually means two Next.js projects in the same repo ` +
          `write the same repo-root-relative path.`,
      );
    }
    if (hash !== undefined) {
      hashes.set(key, hash);
    }
    if (!staging.has(key)) {
      staging.set(key, source);
    }
  };

  for (const output of invocable) {
    for (const [key, source] of Object.entries(output.assets)) {
      add(key, source, output.assetsHashes[key]);
    }
    // The entrypoint's own file is deliberately absent from its `assets` — the
    // NFT trace covers the closure it requires, not itself. `assetsHashes` does
    // carry it (keyed the same way), which is also what pins the key format.
    const entryKey = toPosix(relative(repoRoot, output.filePath));
    add(entryKey, output.filePath, output.assetsHashes[entryKey]);
  }

  // Job 2, second half: `writeStandaloneDirectory` filters `loadedEnvFiles` to
  // exactly these two and copies them; `build-complete.js` has no env-file
  // handling at all, so they are not in any `assets` map.
  for (const envFile of ENV_FILES) {
    const source = join(ctx.projectDir, envFile);
    if (existsSync(source)) {
      add(toPosix(relative(repoRoot, source)), source);
    }
  }

  return staging;
}

/**
 * Job 2, third part: the static files the *runtime* has to serve, and their
 * sources.
 *
 * `outputs.staticFiles` mixes two populations with the same `STATIC_FILE` type:
 *
 * - **`<distDir>/static/**` and `public/**`** — uploaded to S3 by
 *   `NextjsStaticAssets`, and CloudFront / API Gateway answer them before the
 *   request ever reaches the compute. Not staged: `public/` alone can be
 *   hundreds of megabytes against a 250 MB unzipped Lambda cap, and it would be
 *   a second copy of bytes already in S3. `public/` is not in
 *   `outputs.staticFiles` at all — Next.js lists it only for `output: "export"`
 *   — and it is deliberately not added here: the container runtime lists it off
 *   disk at cold start instead, as `next start` does (`readPublicFiles` in
 *   `src/runtime/public-files.ts`), because only the disk knows what an app's
 *   `postbuild` wrote into it after this hook ran.
 * - **everything else**, all of it under `<distDir>/server/` — `404.html`,
 *   `500.html`, `favicon.ico.body`, and fully-static Pages Router HTML. Nothing
 *   in front of the compute serves these, so they are staged. Bounded by route
 *   count and small.
 *
 * The pathname → key map is returned for *all* of them, because dispatch has to
 * resolve a pathname to "static file, not a 404" either way; the runtime 404s if
 * the file turns out not to be in the package, which is only reachable when the
 * distribution is misrouted.
 *
 * Staging is {@link stageServedStaticFiles}, applied once per deployment root.
 */
function collectStaticFiles(ctx: BuildCompleteContext): Record<string, string> {
  const { repoRoot } = ctx;
  const basePath = ctx.config.basePath || "";
  const staticFiles = new Map<string, string>();
  const pagesDir = join(ctx.distDir, "server", "pages") + sep;

  for (const output of ctx.outputs.staticFiles) {
    const key = toPosix(relative(repoRoot, output.filePath));
    const pathnames = routablePathnames(
      output.pathname,
      basePath,
      output.filePath.startsWith(pagesDir),
    );
    for (const pathname of pathnames) {
      const existing = staticFiles.get(pathname);
      if (existing !== undefined && existing !== key) {
        throw new Error(
          `${LOG_PREFIX} Two static files claim the pathname ` +
            `"${pathname}" ("${existing}" and "${key}"). Dispatch cannot ` +
            `choose between them.`,
        );
      }
      staticFiles.set(pathname, key);
    }
  }

  // Sorted because object keys keep insertion order, and a byte-stable
  // `manifest.json` is what keeps it diffable and the CDK asset hash from
  // churning.
  return Object.fromEntries(
    [...staticFiles].sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/**
 * The pathnames an output answers, which for one shape is not the pathname
 * `next build` reported.
 *
 * **A Pages Router home page arrives as `/index`.** The adapter hook derives every
 * Pages pathname with `normalizePagePath(page)`, and `normalizePagePath("/")` is
 * `"/index"` (`next/dist/shared/lib/page-path/normalize-page-path.js`) — for the
 * `PAGES` output of an SSG or SSR home page and for the `STATIC_FILE` of a
 * fully-static one alike. `/index` is not a URL anyone requests, and nothing else
 * in the outputs carries `/` for that page, so without this the home page is in
 * neither `manifest.pathnames` nor `manifest.entrypoints`/`staticFiles`, and every
 * request to `/` 404s while every other page of the same app serves. Measured
 * against next.js's `test/e2e/new-link-behavior` (`/` returned the built-in 404,
 * the six other pages were fine) and `test/e2e/prerender-preview` (the one case
 * that fetches `/` got the 404 page's HTML, the eight that hit API routes passed).
 *
 * Pages Router outputs only, which is what `fromPagesRouter` says. App Router
 * reports its home page as `/` and only the RSC sibling as `/index.rsc`, so an
 * App Router `/index` is `app/index/page.tsx` — a real route at `/index`, and
 * mapping it to `/` made an app with both pages fail the build on a pathname
 * collision, and an app with only the second serve it at `/`. The same goes for
 * a `public/index` file.
 *
 * Both pathnames are registered. `/` because it is the real one; `/index` because
 * next's own minimal mode — the mode our runtime runs in — accepts it, rewriting
 * `req.url` and `x-matched-path` from `/index` to `/` before matching
 * (`base-server.ts`, "in minimal mode"), so dropping it would be a divergence in
 * the other direction.
 *
 * Unambiguous within the Pages Router despite the collision it looks like:
 * `normalizePagePath("/index")` is `"/index/index"`, so a reported `/index` can
 * only have come from the page `/`.
 * The data route of the same page, `/_next/data/<buildId>/index.json`, and an App
 * Router `/index.rsc` are both real URLs and are left alone by the exact match.
 */
function routablePathnames(
  pathname: string,
  basePath: string,
  fromPagesRouter: boolean,
): string[] {
  if (!fromPagesRouter || pathname !== `${basePath}/index`) {
    return [pathname];
  }
  // `basePath || "/"`, not `${basePath}/`: with `basePath: "/prod"` the home page
  // is `/prod`, which is how the App Router fixtures report theirs.
  return [basePath || "/", pathname];
}

/**
 * Add the static files the *runtime* serves to a staging plan — the "everything
 * else" population described on {@link collectStaticFiles}, all of it under
 * `<distDir>/server/`.
 *
 * Separate from building the manifest's `staticFiles` map because the map is the
 * same for every group while the staging is applied once per deployment root:
 * any group can be asked for `/404`, so every group ships these.
 */
function stageServedStaticFiles(
  ctx: BuildCompleteContext,
  staging: Map<string, string>,
): void {
  const { repoRoot, distDir } = ctx;
  const clientStaticDir = join(distDir, "static") + sep;

  for (const output of ctx.outputs.staticFiles) {
    const servedByS3 =
      output.filePath.startsWith(clientStaticDir) ||
      !output.filePath.startsWith(distDir + sep);
    if (servedByS3) {
      continue;
    }
    const key = toPosix(relative(repoRoot, output.filePath));
    assertStagingKey(key, output.filePath);
    staging.set(key, output.filePath);
  }
}

/**
 * The invariant behind `manifest.relativeProjectDir`: `next build` must run from
 * the project directory.
 *
 * Next inlines `relative(process.cwd(), projectDir)` into every entrypoint
 * (`define-env.js`) and the built code resolves it against the *runtime*
 * `process.cwd()`. Keeping build cwd and project dir equal makes that inlined
 * value `""`, so the runtime only has to `chdir` to the staged project dir. A
 * build run from elsewhere would inline a non-empty relative path — often one
 * pointing outside the staging tree — and every entrypoint would fail to find
 * `required-server-files.json` at runtime with no hint as to why.
 */
function assertBuildCwd(ctx: BuildCompleteContext, buildCwd: string): void {
  const cwd = resolve(buildCwd);
  if (cwd === resolve(ctx.projectDir)) {
    return;
  }
  throw new Error(
    `${LOG_PREFIX} \`next build\` must run from the Next.js project ` +
      `directory. It ran from "${cwd}" with the project at ` +
      `"${ctx.projectDir}". Next.js bakes the relative path between those two ` +
      `into every built entrypoint, and cdk-nextjs cannot reproduce that layout ` +
      `in the deployment package. Change directory first (\`cd ` +
      `${relative(cwd, ctx.projectDir) || "."} && next build\`) instead of ` +
      `passing the directory as an argument; in a monorepo, run the app's own ` +
      `build script from its directory (e.g. \`pnpm --filter <app> build\`, ` +
      `which runs in the package directory).`,
  );
}

function addEntrypoint(
  entrypoints: Record<string, AdapterEntrypoint>,
  repoRoot: string,
  output: { id: string; pathname: string; filePath: string },
  type: AdapterEntrypointType,
  basePath: string,
): void {
  const filePath = toPosix(relative(repoRoot, output.filePath));
  const pathnames = routablePathnames(
    output.pathname,
    basePath,
    type === "page",
  );
  for (const pathname of pathnames) {
    const existing = entrypoints[pathname];
    if (existing && existing.filePath !== filePath) {
      throw new Error(
        `${LOG_PREFIX} Two build outputs claim the pathname "${pathname}" ` +
          `("${existing.filePath}" and "${filePath}"). Dispatch cannot choose ` +
          `between them.`,
      );
    }
    entrypoints[pathname] = { id: output.id, filePath, type };
  }
}

/**
 * Add the *prerender* pathnames that no invocable output claims and that routing
 * cannot otherwise reach.
 *
 * `resolveRoutes` can only match a pathname present in `manifest.pathnames`, and
 * for a dynamic match it returns the **template** it matched. Routes and static
 * files cover most of that; two shapes they miss:
 *
 * 1. **Templates.** A request for `/_next/data/<buildId>/fr/blog/hello.json` only
 *    resolves if `/_next/data/<buildId>/fr/blog/[slug].json` is listed, and that
 *    pathname exists solely as a `prerenders` entry.
 * 1b. **A static `getStaticProps` page's data route.** `/_next/data/<buildId>/gsp.json`
 *    has no template to match and no rule of its own: `next build` only emits a
 *    `dynamicRoutes` rule for a data route when the page is dynamic *or* the app has
 *    middleware (`build-complete.ts`, `needsMiddlewareResolveRoutes`, which is also
 *    what `routing.shouldNormalizeNextData` reports). Without middleware Next.js
 *    expects the platform to serve the data route as an output, by pathname — so a
 *    concrete data-route prerender is registered whatever the rules say. Missing it
 *    turned every client-side navigation into such a page into a full page load,
 *    because the router's `.json` fetch 404'd: measured against
 *    `test/e2e/no-page-props`. Only when no *ungated* rule matches, for the reason
 *    below — a dynamic page's `/…/blog/hello.json` must keep resolving to its
 *    `[slug].json` template, which is where `nxtPslug` comes from.
 * 2. **Concrete pathnames whose dynamic route rule is gated.** A route whose params
 *    can never be filled at request time — root params are the case that produced
 *    this, `app/[locale]/page.tsx` with `generateStaticParams()` and no
 *    `app/layout.tsx` — gets its `dynamicRoutes` rule emitted with a draft-mode
 *    `has` on `__prerender_bypass`. Next.js is saying: invoke the function only in
 *    draft mode, and otherwise serve the prerender you were handed. Vercel's CDN
 *    does that from the output itself; we route the request to the owning
 *    entrypoint, which answers it out of the seeded cache. Without this, `/en` is a
 *    404 while `next start` renders it — and so is every `.rsc`/`.segments`
 *    variant, which is why a client-side navigation into such an app never
 *    completes.
 *
 * A concrete pathname is added only when a gated rule matches it and no ungated
 * one does — the set that would 404 today *and* that routing can still produce.
 * Adding them unconditionally was measured to be actively wrong twice over:
 * `/isr/1` resolves to itself rather than to `/isr/[id]`, losing the `nxtPid`
 * query param the route needs, and pathnames no rule matches at all (a static
 * route's `.segments/…` outputs, which `resolveRoutes` never asks for) are dead
 * manifest weight. Matching mirrors `resolveRoutes`, which is case-insensitive by
 * default.
 *
 * The owning entrypoint comes from `prerender.route`, which is the unprefixed and
 * unlocalized source route (`/blog/[slug]`), hence the basePath-then-bare ladder.
 * Locale variants of one page share a `filePath`, so any locale's entrypoint is
 * the right target. An RSC or segment-prefetch pathname prefers the route's `.rsc`
 * entrypoint, because that is the key `resolveRoutes` resolves such a request to.
 */
function addPrerenderPathnames(
  entrypoints: Record<string, AdapterEntrypoint>,
  prerenders: AdapterOutputs["prerenders"],
  dynamicRoutes: {
    sourceRegex: string;
    has?: unknown[];
    missing?: unknown[];
  }[],
  basePath: string,
  dataRoutePrefix: string,
): void {
  const matchers = dynamicRoutes.map((route) => ({
    regex: new RegExp(route.sourceRegex, "i"),
    gated: Boolean(route.has?.length || route.missing?.length),
  }));
  const matchingRules = (pathname: string) =>
    matchers.filter(({ regex }) => regex.test(pathname));
  const onlyGatedRulesMatch = (pathname: string): boolean => {
    const matched = matchingRules(pathname);
    return matched.length > 0 && matched.every(({ gated }) => gated);
  };
  /**
   * Nothing reaches this pathname at request time: either no rule matches it or
   * every rule that does is gated. The gated half is {@link onlyGatedRulesMatch};
   * the "no rule at all" half only ever holds for a data route, because a page's
   * own pathname is an output.
   */
  const nothingUngatedMatches = (pathname: string): boolean =>
    matchingRules(pathname).every(({ gated }) => gated);

  const orphans: string[] = [];
  for (const prerender of prerenders) {
    const { pathname } = prerender;
    if (entrypoints[pathname]) {
      continue;
    }
    const isTemplate = pathname.includes("[");
    const isDataRoute =
      pathname.startsWith(dataRoutePrefix) && pathname.endsWith(".json");
    const reachable = isDataRoute
      ? nothingUngatedMatches(pathname)
      : onlyGatedRulesMatch(pathname);
    if (!isTemplate && !reachable) {
      continue;
    }
    const suffixes = pathname.endsWith(".rsc") ? [".rsc", ""] : [""];
    const owner = suffixes
      .flatMap((suffix) => [
        `${basePath}${prerender.route}${suffix}`,
        `${prerender.route}${suffix}`,
      ])
      .map((key) => entrypoints[key])
      .find(Boolean);
    if (!owner) {
      orphans.push(`${pathname} (route: "${prerender.route}")`);
      continue;
    }
    entrypoints[pathname] = {
      id: prerender.id,
      filePath: owner.filePath,
      type: owner.type,
    };
  }

  if (orphans.length > 0) {
    // Warn rather than throw: an unmapped pathname degrades one URL shape to a
    // 404, which is what would happen without this function at all. A throw
    // would break the build outright on an output shape a future `next` minor
    // might introduce.
    console.warn(
      `${LOG_PREFIX} ${orphans.length} prerender pathname(s) have no ` +
        `matching route entrypoint and will 404: ` +
        `${orphans.slice(0, 5).join(", ")}` +
        `${orphans.length > 5 ? `, and ${orphans.length - 5} more` : ""}.`,
    );
  }
}

function buildMiddleware(
  repoRoot: string,
  middleware: AdapterOutputs["middleware"],
): AdapterMiddleware | null {
  if (!middleware) {
    return null;
  }
  // `config.matchers` is deliberately not copied here: it arrives inside
  // `ctx.routing.middlewareMatchers`, which `@next/routing` consumes directly.
  return {
    id: middleware.id,
    filePath: toPosix(relative(repoRoot, middleware.filePath)),
  };
}

/**
 * Copy the staging plan into `stagingDir`.
 *
 * **Symlinks are recreated as symlinks, not dereferenced**, which is what
 * Next.js's own `copyTracedFiles` does (`next/dist/build/utils.js`: `readlink`
 * then `symlink`, with a Windows junction fallback). Under pnpm a traced asset
 * key is frequently a *directory* symlink into the store
 * (`node_modules/.pnpm/next@…/node_modules/react` → `../../react@19.2.3/…`), so
 * `copyFile` fails outright with `ENOTSUP`. Dereferencing instead would triple
 * the tree — `examples/app-playground` measures 32 MB staged versus 96 MB with
 * `du -shL`, against a 250 MB unzipped Lambda cap — because whole packages are
 * reachable through several such links. The link targets are themselves staged
 * keys, so relative links resolve inside the deployment root.
 *
 * Regular files are staged first so that a symlink whose path was already
 * materialized as a real directory is skipped rather than clobbering it.
 *
 * Nothing may dereference them afterwards: the Functions zip keeps them as
 * links (`zipDirectory`), and the Containers `COPY` does too.
 */
/** Bounded so a large app doesn't exhaust file descriptors. */
const STAGING_CONCURRENCY = 32;

async function stageFiles(
  staging: StagingPlan,
  stagingDir: string,
): Promise<void> {
  const planned = [...staging];
  // Links land by plan index, so the pass below creates them in the plan's
  // order whatever order the workers finished in.
  const links: Array<[string, string, string] | undefined> = new Array(
    planned.length,
  );
  let nextEntry = 0;
  const worker = async () => {
    while (nextEntry < planned.length) {
      const index = nextEntry++;
      const [key, source] = planned[index];
      const linkTarget = await readlink(source).catch(() => null);
      if (linkTarget !== null) {
        links[index] = [key, source, linkTarget];
        continue;
      }
      const dest = join(stagingDir, key);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(source, dest);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(STAGING_CONCURRENCY, planned.length) },
      worker,
    ),
  );

  for (const link of links) {
    if (link === undefined) {
      continue;
    }
    const [key, source, linkTarget] = link;
    const dest = join(stagingDir, key);
    if (existsSync(dest)) {
      // Already staged as real content by the pool above; the link would add
      // nothing and would replace a directory we need.
      continue;
    }
    await mkdir(dirname(dest), { recursive: true });
    const resolved = resolve(dirname(dest), linkTarget);
    if (resolved === stagingDir || resolved.startsWith(stagingDir + sep)) {
      await symlink(linkTarget, dest);
    } else {
      // Points outside the deployment root, so the link would dangle in Lambda.
      // Absolute store paths are the realistic case here.
      await cp(source, dest, { recursive: true, dereference: true });
    }
  }
}

/**
 * Adds {@link RUNTIME_NEXT_MODULES}, `@next/env`, and everything they require to
 * `staging`, and {@link IMAGE_NEXT_MODULES} and theirs to `imageStaging`.
 *
 * Without this the deployment is complete for every route the app has and broken
 * for `/_next/image`: the traced `assets` of a build output cover what the *app*
 * reaches, and an app never reaches next's image optimizer, so
 * `next/dist/server/image-optimizer.js` and its closure are simply absent and
 * every image request 500s with a `MODULE_NOT_FOUND` from `nextModule`.
 *
 * Resolution is anchored inside `ctx.projectDir` for the same reason
 * `useNextFrom` anchors there at runtime: it is the directory whose
 * `node_modules` walk finds the app's `next`. A repo where that resolution fails
 * is not a real `next build` — nothing else would have run — so it warns and
 * continues rather than failing a build for a package it could not have needed.
 * A missing *tracer* is different: `next` is right there and image optimization
 * would silently 500 in production, so that throws.
 */
async function addRuntimeNextClosure(
  ctx: BuildCompleteContext,
  staging: Map<string, string>,
  imageStaging: Map<string, string>,
): Promise<void> {
  // The anchor file needn't exist; `createRequire` only reads its directory.
  const nextRequire = createRequire(
    join(ctx.projectDir, "cdk-nextjs-next-resolver.cjs"),
  );

  let entries: string[];
  let imageEntries: string[];
  try {
    entries = RUNTIME_NEXT_MODULES.map((specifier) =>
      nextRequire.resolve(specifier),
    );
    imageEntries = IMAGE_NEXT_MODULES.map((specifier) =>
      nextRequire.resolve(specifier),
    );
  } catch (cause) {
    console.warn(
      `${LOG_PREFIX} Could not resolve next's image optimizer from ` +
        `"${ctx.projectDir}" (${(cause as Error).message}). Requests to ` +
        `/_next/image will fail at runtime.`,
    );
    return;
  }
  // `loadEnvFiles` (runtime `next-modules.ts`) loads the staged env files with
  // `@next/env`, which is `next`'s dependency, so resolved from `next`'s dir.
  // An app never requires it, so no output's trace has it either.
  const nextPackage = nextRequire.resolve("next/package.json");
  try {
    entries.push(createRequire(nextPackage).resolve("@next/env"));
  } catch (cause) {
    throw new Error(
      `${LOG_PREFIX} Could not resolve "@next/env" from the app's \`next\`, ` +
        `which the cdk-nextjs runtime uses to load .env files.`,
      { cause },
    );
  }

  let nodeFileTrace: NodeFileTrace;
  try {
    ({ nodeFileTrace } = nextRequire(NEXT_FILE_TRACER));
  } catch (cause) {
    throw new Error(
      `${LOG_PREFIX} Could not load "${NEXT_FILE_TRACER}", which cdk-nextjs uses ` +
        `to stage the \`next\` files its image optimizer requires. This Next.js ` +
        `version may have moved it; please open an issue.`,
      { cause },
    );
  }

  const add = (fileList: Set<string>, target: Map<string, string>) => {
    for (const traced of fileList) {
      const key = toPosix(traced);
      if (target.has(key)) {
        continue;
      }
      const source = join(ctx.repoRoot, traced);
      assertStagingKey(key, source);
      target.set(key, source);
    }
  };
  add(
    (await nodeFileTrace(imageEntries, { base: ctx.repoRoot })).fileList,
    imageStaging,
  );
  const { fileList } = await nodeFileTrace(entries, { base: ctx.repoRoot });
  // The trace starts from `@next/env`'s real path, so under pnpm it never
  // passes through the `.pnpm/next@…/node_modules/@next/env` link that `next`
  // resolves it by. Without the link, every request fails at cold start with
  // "Cannot find module '@next/env'".
  const nextEnvLink = join(dirname(nextPackage), "..", "@next", "env");
  if (lstatSync(nextEnvLink, { throwIfNoEntry: false })?.isSymbolicLink()) {
    // `resolve` returns real paths, so relative to the real repo root.
    fileList.add(relative(realpathSync(ctx.repoRoot), nextEnvLink));
  }
  add(fileList, staging);
}

/**
 * Add `<distDir>/required-server-files.json` to a plan every group is merged with.
 *
 * It reaches a group otherwise only as a traced `asset` of some invocable output,
 * which is not a guarantee: a group whose templates are all assigned elsewhere
 * owns no outputs at all. That is reachable — a Pages-Router-only app whose every
 * page falls under the configured `functionGroups` leaves the *default* group
 * template-empty, and the default group is still what serves `/_next/image`, the
 * static files, and the distribution's catch-all.
 *
 * Its absence is not a partial failure: `loadRuntime` probes for exactly this file
 * before it will serve anything, and `image.ts` reads the image config out of it,
 * so the whole root answers "the deployment package is incomplete". Cheap to make
 * unconditional, so make it unconditional.
 *
 * Not traced like {@link RUNTIME_NEXT_MODULES}, because it is data rather than a
 * module: nothing `require`s it, so no file tracer can find it.
 *
 * Absence is left to `loadRuntime`, which names the file and the layout contract
 * it belongs to. `next build` always writes it, so there is no build-time error
 * worth inventing here for a file this step does not own.
 */
function addRequiredServerFiles(
  ctx: BuildCompleteContext,
  staging: Map<string, string>,
): void {
  const source = join(ctx.distDir, "required-server-files.json");
  const key = toPosix(relative(ctx.repoRoot, source));
  if (staging.has(key) || !existsSync(source)) {
    return;
  }
  assertStagingKey(key, source);
  staging.set(key, source);
}

/**
 * Every staged path must land inside the staging tree and must not shadow the
 * reserved directory cdk-nextjs copies its own runtime into at synth.
 */
function assertStagingKey(key: string, source: string): void {
  if (key === "" || key.startsWith("/") || key.startsWith("..")) {
    throw new Error(
      `${LOG_PREFIX} Build output asset "${source}" resolves to the staging key ` +
        `"${key}", which is outside the deployment root. Set ` +
        `\`outputFileTracingRoot\` so all traced files live under one root.`,
    );
  }
  if (key === RUNTIME_DIR_NAME || key.startsWith(`${RUNTIME_DIR_NAME}/`)) {
    throw new Error(
      `${LOG_PREFIX} Build output asset "${source}" resolves to the staging key ` +
        `"${key}", but "${RUNTIME_DIR_NAME}/" is reserved for cdk-nextjs's own ` +
        `runtime files.`,
    );
  }
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

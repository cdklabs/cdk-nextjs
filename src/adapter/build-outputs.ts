/* eslint-disable import/no-extraneous-dependencies */
import { existsSync, readdirSync } from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { NextAdapter } from "next";
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
 * `next build`'s own trace never covers them: next's image optimizer and the
 * config/`serve-static` helpers around it (`src/runtime/image.ts`). They are
 * required from the app's `next` rather than bundled, deliberately — see
 * `src/runtime/next-modules.ts` — which makes staging their closure this
 * module's job.
 */
const RUNTIME_NEXT_MODULES = [
  "next/dist/server/config-shared.js",
  "next/dist/shared/lib/image-config.js",
  "next/dist/server/image-optimizer.js",
  "next/dist/server/serve-static.js",
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
  /**
   * The union of every group's plan. One group's plan is a subset of this; with
   * no splitting it *is* this. Kept separately because the cross-output
   * `assetsHashes` conflict check is only meaningful across the whole build.
   */
  readonly staging: StagingPlan;
  /** One entry per deployment root to stage. Length 1 unless splitting. */
  readonly groups: StagedGroup[];
}

/** A staged deployment root on disk. */
export interface StagedGroupResult {
  readonly name: string;
  /** Absolute path to the deployment root. */
  readonly path: string;
  readonly fileCount: number;
  /** Bytes staged into this root. Recorded to keep the 250 MB cap honest. */
  readonly stagedBytes: number;
}

export interface WriteBuildOutputsResult extends BuildAdapterManifestResult {
  /** Absolute path to `<distDir>/cdk-nextjs-adapter`. */
  readonly adapterDir: string;
  /** Absolute path to the written manifest. */
  readonly manifestPath: string;
  /** One per deployment root, in the order they were staged. */
  readonly stagedGroups: StagedGroupResult[];
  /** Total bytes across every deployment root. */
  readonly stagedBytes: number;
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

  const {
    manifest,
    staging: planned,
    groups,
  } = buildAdapterManifest(ctx, options);

  // Traced once and merged into every group. The trace is async, which is why it
  // cannot happen inside `buildAdapterManifest`, and it is the same set of files
  // for every group: `/_next/image` is served by all of them.
  const runtimeClosure = new Map<string, string>();
  await addRuntimeNextClosure(ctx, runtimeClosure);
  addRequiredServerFiles(ctx, runtimeClosure);

  const staging = merged(planned, runtimeClosure);

  // A previous build's tree is never additive with this one's: a removed route
  // leaves behind an entrypoint the manifest no longer mentions, a renamed chunk
  // leaves dead bytes inside the 250 MB budget, and a regrouped build leaves a
  // whole deployment root nothing deploys.
  await rm(adapterDir, { recursive: true, force: true });

  const stagedGroups: StagedGroupResult[] = [];
  for (const group of groups) {
    const groupStaging = merged(group.staging, runtimeClosure);
    const path = join(adapterDir, ...group.dirName.split("/"));
    await mkdir(path, { recursive: true });
    const stagedBytes =
      (await stageFiles(groupStaging, path)) +
      (await hoistStoreOnlyPackages(groupStaging, path));
    stagedGroups.push({
      name: group.name,
      path,
      fileCount: groupStaging.size,
      stagedBytes,
    });
  }

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    manifest,
    staging,
    groups,
    adapterDir,
    manifestPath,
    stagedGroups,
    stagedBytes: stagedGroups.reduce((sum, g) => sum + g.stagedBytes, 0),
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

  const staging = collectStagingPlan(ctx, invocable);
  const staticFiles = collectStaticFiles(ctx);
  stageServedStaticFiles(ctx, staging);

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
        Object.entries(entrypoints).map(([template, entrypoint]) => ({
          template,
          entrypointId: entrypoint.id,
        })),
        { basePath: ctx.config.basePath || "" },
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
      i18n: ctx.config.i18n ?? null,
    },
    routing: ctx.routing,
    pathnames,
    entrypoints,
    middleware: buildMiddleware(repoRoot, outputs.middleware),
    staticFiles,
    ...(assignment ? { groups: assignment } : {}),
  };

  const groups: StagedGroup[] = assignment
    ? Object.entries(assignment).map(([name, templates]) => ({
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
          staging,
        },
      ];

  return { manifest, staging, groups };
}

/**
 * One group's slice of the staging plan: the assets of the outputs it owns, and
 * nothing else.
 *
 * Middleware is in every group, not just the default one — it runs on every
 * request wherever that request lands, so it is duplicated by design, as is the
 * `next` closure the entrypoints share. The same goes for the static files the
 * runtime serves itself (`404.html`, `favicon.ico.body`): any group can be asked
 * for them.
 *
 * Ownership is matched on `output.id` rather than on pathname because the manifest
 * is what decided the grouping, and its entrypoints are keyed by *template* while
 * an output may back several templates.
 *
 * And on `filePath` as well as `id`, because {@link addPrerenderPathnames}
 * synthesizes entrypoints that carry the *prerender's* id — which no invocable
 * output has. A group whose pattern matches only such a template (the root-params
 * app: entrypoint `/en` with `id: "/en"` backed by the output `/[locale]`) passed
 * `assignRoutesToGroups` validation and then staged no entrypoint at all, so every
 * request to its behavior answered 500 with "the deployment package is
 * incomplete". The synthesized entrypoint's `filePath` is the owning output's, so
 * that is the reliable key.
 */
function collectGroupStagingPlan(
  ctx: BuildCompleteContext,
  invocable: InvocableOutput[],
  entrypoints: Record<string, AdapterEntrypoint>,
  templates: string[],
): Map<string, string> {
  const ownedEntrypoints = templates.map((template) => entrypoints[template]);
  const ownedIds = new Set(ownedEntrypoints.map((entry) => entry.id));
  const ownedFiles = new Set(ownedEntrypoints.map((entry) => entry.filePath));
  const middleware = ctx.outputs.middleware;
  const owned = invocable.filter(
    (output) =>
      ownedIds.has(output.id) ||
      ownedFiles.has(toPosix(relative(ctx.repoRoot, output.filePath))) ||
      output === middleware,
  );
  const staging = collectStagingPlan(ctx, owned);
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
        `Next.js 16 runs \`proxy.ts\` on the Node runtime; the legacy ` +
        `\`middleware.ts\` entrypoint is edge-only.`,
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
 * `outputs.staticFiles` plus `public/`, which mixes two populations:
 *
 * - **`<distDir>/static/**` and `public/**`** — uploaded to S3 by
 *   `NextjsStaticAssets`, and CloudFront / API Gateway answer them before the
 *   request ever reaches the compute. Not staged: `public/` alone can be
 *   hundreds of megabytes against a 250 MB unzipped Lambda cap, and it would be
 *   a second copy of bytes already in S3. `NextjsRegionalContainers` has nothing
 *   in front of it, so its image copies both directories in and the runtime
 *   serves them off disk. `public/` is not in `outputs.staticFiles` at all —
 *   Next.js lists it only for `output: "export"` — so it is read from the
 *   project directory here; see {@link publicStaticFiles}.
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

  for (const output of ctx.outputs.staticFiles) {
    const key = toPosix(relative(repoRoot, output.filePath));
    for (const pathname of routablePathnames(output.pathname, basePath)) {
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
  for (const [pathname, key] of publicStaticFiles(ctx, basePath)) {
    // A build output wins over a `public/` file at the same pathname, as it does
    // in `next start`, whose filesystem router checks build outputs first.
    if (!staticFiles.has(pathname)) {
      staticFiles.set(pathname, key);
    }
  }

  // Sorted for the reason on `sortedByPathname`: object keys keep insertion
  // order, and a byte-stable `manifest.json` is what keeps the CDK asset hash
  // from churning.
  return Object.fromEntries(
    [...staticFiles].sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/**
 * `public/**` as `[pathname, key]` pairs: the pathname Next.js serves each file
 * at and its repo-root-relative key.
 *
 * The pathname is percent-encoded a segment at a time, because `@next/routing`
 * matches `pathnames` against the request path as it arrived: `public/hello
 * e2e.txt` is requested as `/hello%20e2e.txt`, and an unencoded key never
 * matches it. Build outputs never need this - Next.js names them - but a
 * `public/` file is named by whoever made it.
 *
 * Without these, a container deployment answered every `public/` request with
 * the app's 404 page even though its image carried the files: dispatch only
 * serves what the manifest lists. On the other three types the entries are
 * inert — the distribution routes `public/` to S3 before the compute sees it.
 */
function publicStaticFiles(
  ctx: BuildCompleteContext,
  basePath: string,
): Array<[string, string]> {
  const publicDir = join(ctx.projectDir, "public");
  if (!existsSync(publicDir)) {
    return [];
  }
  return readdirSync(publicDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry): [string, string] => {
      const file = join(entry.parentPath, entry.name);
      const segments = toPosix(relative(publicDir, file)).split("/");
      return [
        `${basePath}/${segments.map(encodeURIComponent).join("/")}`,
        toPosix(relative(ctx.repoRoot, file)),
      ];
    });
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
 * App Router is unaffected: it reports its home page as `/` and only the RSC
 * sibling as `/index.rsc`.
 *
 * Both pathnames are registered. `/` because it is the real one; `/index` because
 * next's own minimal mode — the mode our runtime runs in — accepts it, rewriting
 * `req.url` and `x-matched-path` from `/index` to `/` before matching
 * (`base-server.ts`, "in minimal mode"), so dropping it would be a divergence in
 * the other direction.
 *
 * Unambiguous despite the collision it looks like: `normalizePagePath("/index")`
 * is `"/index/index"`, so a reported `/index` can only have come from the page `/`.
 * The data route of the same page, `/_next/data/<buildId>/index.json`, and an App
 * Router `/index.rsc` are both real URLs and are left alone by the exact match.
 */
function routablePathnames(pathname: string, basePath: string): string[] {
  if (pathname !== `${basePath}/index`) {
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

  for (const output of sortedByPathname(ctx.outputs.staticFiles)) {
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
 * `sortedUnique` used to give the manifest's `staticFiles` a stable order. Object
 * keys preserve insertion order, so sorting the outputs keeps `manifest.json`
 * byte-stable across builds — which is what makes it diffable and keeps the CDK
 * asset hash from churning.
 */
function sortedByPathname<T extends { pathname: string }>(outputs: T[]): T[] {
  return [...outputs].sort((a, b) => (a.pathname < b.pathname ? -1 : 1));
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
      `passing the directory as an argument.`,
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
  for (const pathname of routablePathnames(output.pathname, basePath)) {
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
    env: middleware.config.env ?? {},
  };
}

/**
 * Copy the staging plan into `stagingDir`. Returns total bytes staged.
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
 * Preserved links are enough for Containers but not for the Functions zip; see
 * {@link hoistStoreOnlyPackages} for what makes the tree resolvable once
 * something dereferences them.
 */
async function stageFiles(
  staging: StagingPlan,
  stagingDir: string,
): Promise<number> {
  const files: Array<[string, string]> = [];
  const links: Array<[string, string, string]> = [];
  for (const [key, source] of staging) {
    const linkTarget = await readlink(source).catch(() => null);
    if (linkTarget === null) {
      files.push([key, source]);
    } else {
      links.push([key, source, linkTarget]);
    }
  }

  let bytes = 0;
  const makeParents = async (entries: Array<[string, string, ...string[]]>) => {
    for (const dir of sortedUnique(
      entries.map(([key]) => dirname(join(stagingDir, key))),
    )) {
      await mkdir(dir, { recursive: true });
    }
  };

  await makeParents(files);
  let cursor = 0;
  const copyWorker = async () => {
    while (cursor < files.length) {
      const [key, source] = files[cursor++];
      const dest = join(stagingDir, key);
      await copyFile(source, dest);
      // Read the size into a local first: `bytes += await …` reads `bytes`
      // *before* awaiting, so concurrent workers would clobber each other.
      const size = (await stat(dest)).size;
      bytes += size;
    }
  };
  // Bounded so a large app doesn't exhaust file descriptors.
  await Promise.all(
    Array.from({ length: Math.min(32, files.length) }, copyWorker),
  );

  await makeParents(links);
  for (const [key, source, linkTarget] of links) {
    const dest = join(stagingDir, key);
    if (existsSync(dest)) {
      // Already staged as real content by the loop above; the link would add
      // nothing and would replace a directory we need.
      continue;
    }
    const resolved = resolve(dirname(dest), linkTarget);
    if (resolved === stagingDir || resolved.startsWith(stagingDir + sep)) {
      await symlink(linkTarget, dest);
    } else {
      // Points outside the deployment root, so the link would dangle in Lambda.
      // Absolute store paths are the realistic case here.
      await cp(source, dest, { recursive: true, dereference: true });
      const size = await directorySize(dest);
      bytes += size;
    }
  }

  return bytes;
}

/**
 * Adds {@link RUNTIME_NEXT_MODULES} and everything they require to the staging
 * plan.
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
): Promise<void> {
  // The anchor file needn't exist; `createRequire` only reads its directory.
  const nextRequire = createRequire(
    join(ctx.projectDir, "cdk-nextjs-next-resolver.cjs"),
  );

  let entries: string[];
  try {
    entries = RUNTIME_NEXT_MODULES.map((specifier) =>
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

  const { fileList } = await nodeFileTrace(entries, { base: ctx.repoRoot });
  for (const traced of fileList) {
    const key = toPosix(traced);
    if (staging.has(key)) {
      continue;
    }
    const source = join(ctx.repoRoot, traced);
    assertStagingKey(key, source);
    staging.set(key, source);
  }
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

/** `node_modules/.pnpm/<pkg>/node_modules/<name>` — pnpm's virtual store. */
const PNPM_STORE_SEGMENT = "node_modules/.pnpm/";

/**
 * Copies every package that exists *only* inside pnpm's virtual store to
 * `<deploymentRoot>/node_modules/<name>`, where Node finds it from anywhere in
 * the tree as a last resort — the same job pnpm's own `.pnpm/node_modules`
 * hoisted directory does inside a workspace.
 *
 * Needed because the symlinks {@link stageFiles} preserves do not survive
 * zipping: `cdk-assets` dereferences them (verified 2026-09-21 — a published
 * Functions asset zip contains zero symlink entries), so a store package
 * materializes at its logical path (`app/node_modules/next/…`) while the
 * siblings it resolves its own dependencies through stay behind in the store.
 * The failure that motivated this was `next/dist/client/lib/console.js`
 * requiring `@swc/helpers`, which is in the store and nowhere else, so every
 * request 500ed with "Could not load middleware".
 *
 * Containers keep the symlinks (`COPY` preserves them) and so resolve through
 * the store as before; the hoisted copies are dead weight there, but the
 * store-only set is small — one traced package version each, and any package
 * with a logical path of its own is skipped.
 *
 * Two versions of the same store-only package can't both be hoisted, so the one
 * with the most staged code files wins and the other's consumers resolve it.
 * That is also what pnpm's hoisted directory does (modulo which version it
 * picks), and it only applies to a dependency no package depends on directly.
 *
 * Code files, rather than the first version by staging key, because a version
 * can be staged for its metadata alone: the trace reads `semver@6.3.1`'s
 * `package.json` and nothing else, and hoisting *that* left
 * `node_modules/semver` without a single module in it, so `sharp` failed to
 * load and every `/_next/image` request silently served the unoptimized
 * original — under next's misleading "Module `sharp` not found".
 */
async function hoistStoreOnlyPackages(
  staging: StagingPlan,
  stagingDir: string,
): Promise<number> {
  /** name → store directory → how many staged files other than metadata. */
  const storeRoots = new Map<string, Map<string, number>>();
  const hasLogicalPath = new Set<string>();
  for (const key of staging.keys()) {
    const root = packageRootOf(key);
    if (!root) continue;
    if (!root.path.includes(PNPM_STORE_SEGMENT)) {
      // Counts even when the key *is* the package root, i.e. a link: whatever
      // dereferences it materializes the package at this logical path.
      hasLogicalPath.add(root.name);
    } else if (key !== root.path) {
      // A key equal to the root is one store directory linking to another
      // (`.pnpm/next@…/node_modules/react` → `.pnpm/react@19…`); only the
      // directory holding the package's own files can be copied out.
      const versions = storeRoots.get(root.name) ?? new Map<string, number>();
      const weight = key === `${root.path}/package.json` ? 0 : 1;
      versions.set(root.path, (versions.get(root.path) ?? 0) + weight);
      storeRoots.set(root.name, versions);
    }
  }

  let bytes = 0;
  for (const [name, versions] of storeRoots) {
    if (hasLogicalPath.has(name)) continue;
    const [root] = [...versions].sort(
      // Path is the tiebreak so the choice doesn't ride on staging order.
      ([aPath, aModules], [bPath, bModules]) =>
        bModules - aModules || aPath.localeCompare(bPath),
    )[0];
    const source = join(stagingDir, root);
    const dest = join(stagingDir, "node_modules", name);
    if (existsSync(dest)) continue;
    await mkdir(dirname(dest), { recursive: true });
    await cp(source, dest, { recursive: true });
    bytes += await directorySize(dest);
  }
  return bytes;
}

/**
 * The package a staging key belongs to, or `undefined` if it isn't under a
 * `node_modules/` segment. Reads the *last* segment so that a nested
 * `node_modules/a/node_modules/b/index.js` is attributed to `b`.
 */
function packageRootOf(
  key: string,
): { name: string; path: string } | undefined {
  const marker = "node_modules/";
  const at = key.lastIndexOf(marker);
  if (at === -1) return;
  const after = key.slice(at + marker.length).split("/");
  const parts = after[0].startsWith("@")
    ? after.slice(0, 2)
    : after.slice(0, 1);
  // A key that *is* the `node_modules/<scope>` directory names no package.
  if (parts.length < (after[0].startsWith("@") ? 2 : 1)) return;
  const name = parts.join("/");
  return { name, path: key.slice(0, at + marker.length) + name };
}

async function directorySize(path: string): Promise<number> {
  const entry = await stat(path);
  if (!entry.isDirectory()) {
    return entry.size;
  }
  let total = 0;
  for (const child of await readdir(path)) {
    total += await directorySize(join(path, child));
  }
  return total;
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

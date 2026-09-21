/* eslint-disable import/no-extraneous-dependencies */
import { existsSync } from "node:fs";
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
import { dirname, join, relative, resolve, sep } from "node:path";
import { NextAdapter } from "next";
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
  STAGING_DIR_NAME,
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
 * Staging key (repo-root-relative POSIX) → absolute source path on the build
 * machine. The deduped union that replaces the standalone tree.
 */
export type StagingPlan = ReadonlyMap<string, string>;

export interface BuildAdapterManifestResult {
  readonly manifest: AdapterManifest;
  readonly staging: StagingPlan;
}

export interface WriteBuildOutputsResult extends BuildAdapterManifestResult {
  /** Absolute path to `<distDir>/cdk-nextjs-adapter`. */
  readonly adapterDir: string;
  /** Absolute path to `<distDir>/cdk-nextjs-adapter/app`, the deployment root. */
  readonly stagingDir: string;
  /** Absolute path to the written manifest. */
  readonly manifestPath: string;
  /** Total bytes staged. Recorded to keep the 250 MB zip budget honest. */
  readonly stagedBytes: number;
}

/**
 * Build the manifest and staging plan, stage the files, and write the manifest.
 * Called from `onBuildComplete`, which is the only place that holds the build
 * outputs.
 */
export async function writeBuildOutputs(
  ctx: BuildCompleteContext,
): Promise<WriteBuildOutputsResult> {
  const adapterDir = join(ctx.distDir, ADAPTER_DIR_NAME);
  const stagingDir = join(adapterDir, STAGING_DIR_NAME);
  const manifestPath = join(adapterDir, MANIFEST_FILE_NAME);

  const { manifest, staging } = buildAdapterManifest(ctx);

  // A previous build's tree is never additive with this one's: a removed route
  // leaves behind an entrypoint the manifest no longer mentions, and a renamed
  // chunk leaves dead bytes inside the 250 MB budget.
  await rm(adapterDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  const stagedBytes = await stageFiles(staging, stagingDir);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    manifest,
    staging,
    adapterDir,
    stagingDir,
    manifestPath,
    stagedBytes,
  };
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
): BuildAdapterManifestResult {
  const { outputs, repoRoot } = ctx;
  const invocable: InvocableOutput[] = [
    ...outputs.pages,
    ...outputs.pagesApi,
    ...outputs.appPages,
    ...outputs.appRoutes,
    ...(outputs.middleware ? [outputs.middleware] : []),
  ];

  assertNodeRuntimes(invocable);
  warnOnDroppedRouteConfig(invocable);

  const staging = collectStagingPlan(ctx, invocable);

  const entrypoints: Record<string, AdapterEntrypoint> = {};
  for (const { outputs: group, type } of [
    { outputs: outputs.pages, type: "page" as const },
    { outputs: outputs.pagesApi, type: "page-api" as const },
    { outputs: outputs.appPages, type: "app-page" as const },
    { outputs: outputs.appRoutes, type: "app-route" as const },
  ]) {
    for (const output of group) {
      addEntrypoint(entrypoints, repoRoot, output, type);
    }
  }

  const pathnames = sortedUnique([
    ...outputs.pages.map((o) => o.pathname),
    ...outputs.pagesApi.map((o) => o.pathname),
    ...outputs.appPages.map((o) => o.pathname),
    ...outputs.appRoutes.map((o) => o.pathname),
    ...outputs.staticFiles.map((o) => o.pathname),
  ]);

  const manifest: AdapterManifest = {
    version: ADAPTER_MANIFEST_VERSION as 1,
    buildId: ctx.buildId,
    relativeProjectDir: toPosix(relative(repoRoot, ctx.projectDir)),
    config: {
      basePath: ctx.config.basePath || "",
      trailingSlash: ctx.config.trailingSlash === true,
      assetPrefix: ctx.config.assetPrefix || "",
      i18n: ctx.config.i18n ?? null,
    },
    routing: ctx.routing,
    pathnames,
    entrypoints,
    middleware: buildMiddleware(repoRoot, outputs.middleware),
    staticFiles: sortedUnique(outputs.staticFiles.map((o) => o.pathname)),
  };

  return { manifest, staging };
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
function assertNodeRuntimes(invocable: InvocableOutput[]): void {
  // `.rsc` variants share a `sourcePage` with their HTML sibling, so dedupe.
  const offenders = sortedUnique(
    invocable
      .filter((output) => output.runtime !== "nodejs")
      .map((output) => `${output.sourcePage} (runtime: "${output.runtime}")`),
  );
  if (offenders.length === 0) {
    return;
  }
  throw new Error(
    `${LOG_PREFIX} cdk-nextjs cannot deploy routes built for the edge runtime. ` +
      `Remove \`export const runtime = "edge"\` from:\n` +
      offenders.map((o) => `  - ${o}`).join("\n") +
      `\nThe edge runtime is deprecated in Next.js: ` +
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
): StagingPlan {
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

function addEntrypoint(
  entrypoints: Record<string, AdapterEntrypoint>,
  repoRoot: string,
  output: { id: string; pathname: string; filePath: string },
  type: AdapterEntrypointType,
): void {
  const existing = entrypoints[output.pathname];
  const filePath = toPosix(relative(repoRoot, output.filePath));
  if (existing && existing.filePath !== filePath) {
    throw new Error(
      `${LOG_PREFIX} Two build outputs claim the pathname "${output.pathname}" ` +
        `("${existing.filePath}" and "${filePath}"). Dispatch cannot choose ` +
        `between them.`,
    );
  }
  entrypoints[output.pathname] = { id: output.id, filePath, type };
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

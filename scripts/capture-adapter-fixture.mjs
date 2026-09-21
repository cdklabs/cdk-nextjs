#!/usr/bin/env node
/**
 * Capture a real `onBuildComplete` context from an example app and write it to
 * `src/adapter/__fixtures__/<name>.json`, for the unit tests in
 * `src/adapter/build-outputs.test.ts`.
 *
 * Regenerate the fixtures whenever `next` is upgraded: the shape of
 * `ctx.routing` / `ctx.outputs` is Next.js's, not ours, and it changes between
 * minors (`routing.middlewareMatchers`, for one, did not exist in 16.2).
 *
 *   pnpm bundle
 *   node scripts/capture-adapter-fixture.mjs app-playground
 *   NEXTJS_BASE_PATH=/prod node scripts/capture-adapter-fixture.mjs \
 *     app-playground --name app-playground-base-path
 *
 * Pass `--reuse-capture` to re-trim the previous run's dump without rebuilding.
 *
 * How it captures: `examples/<app>`'s `prebuild` script copies this repo's
 * bundled adapter into its own `node_modules/cdk-nextjs`, and `next.config.ts`
 * resolves `adapterPath` to that copy. The copy is untracked build output, so we
 * append a wrapper to it that dumps `ctx` before delegating to the real hook,
 * then run `next build`. Nothing tracked is modified.
 *
 * How it trims: a raw capture of app-playground is ~9 MB, almost all of it
 * repeated `node_modules` paths in per-output `assets`/`assetsHashes` maps. The
 * fixture keeps a curated subset of outputs, and within each output keeps every
 * non-`node_modules` asset key plus a deterministic sample of the
 * `node_modules` ones. Absolute paths are rewritten to a `/repo` placeholder so
 * the fixture is machine-independent. The trim is recorded in `_meta`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLACEHOLDER_ROOT = "/repo";
/** Per kept output, how many `node_modules/` asset keys to retain. */
const NODE_MODULES_ASSET_SAMPLE = 8;
/** Cap on *concrete* prerenders. Dynamic templates are always kept in full. */
const MAX_PRERENDERS = 12;
const MAX_STATIC_FILES = 8;

/**
 * Which route templates to keep per example app. Chosen to cover: the root
 * page, a nested dynamic route, a multi-segment dynamic route, an ISR route, the
 * synthetic `_not-found` page, and both a static and a mutating route handler.
 * Each app-router page also has a sibling `.rsc` output, kept automatically.
 */
const KEEP_PATHNAMES = {
  "app-playground": [
    "/",
    "/_not-found",
    "/context/[categorySlug]",
    "/context/[categorySlug]/[subCategorySlug]",
    "/isr/[id]",
    "/api/health",
    "/api/revalidate",
  ],
  // Small enough to keep whole; `keep` being empty means "keep everything".
  "pages-i18n": [],
};

function main() {
  const args = process.argv.slice(2);
  const app = args[0];
  if (!app) {
    console.error(
      "usage: node scripts/capture-adapter-fixture.mjs <example-app> [--name <fixture-name>]",
    );
    process.exit(1);
  }
  const nameFlag = args.indexOf("--name");
  const name = nameFlag === -1 ? app : args[nameFlag + 1];
  // Re-trim the dump a previous run left behind instead of rebuilding. For when
  // the trim rules change but `next` has not; skips a ~2 minute `next build`.
  const reuse = args.includes("--reuse-capture");

  const appDir = join(repoRoot, "examples", app);
  const dumpPath = join(appDir, ".next", `adapter-ctx-capture.json`);
  const fixturePath = join(
    repoRoot,
    "src",
    "adapter",
    "__fixtures__",
    `${name}.json`,
  );

  if (!reuse) {
    // The example app's `prebuild` copies this repo's *bundled* adapter, so a
    // stale bundle would silently capture the previous implementation.
    run("pnpm", ["bundle"], repoRoot);
    run("pnpm", ["prebuild"], appDir);
    patchAdapterCopy(appDir);
    rmSync(dumpPath, { force: true });
    run("npx", ["next", "build"], appDir, {
      CDK_NEXTJS_DUMP_CTX: dumpPath,
    });
  }

  const raw = JSON.parse(readFileSync(dumpPath, "utf8"));
  const fixture = trim(raw, { app, name });
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(
    `wrote ${fixturePath} (${(readFileSync(fixturePath).length / 1024).toFixed(0)} KB)`,
  );
}

function run(cmd, args, cwd, env = {}) {
  console.error(`$ ${cmd} ${args.join(" ")}  (in ${cwd})`);
  execFileSync(cmd, args, {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...env },
  });
}

/**
 * Append a `ctx`-dumping wrapper to the untracked copy of the bundled adapter
 * that `prebuild` just made.
 */
function patchAdapterCopy(appDir) {
  const copy = join(
    appDir,
    "node_modules",
    "cdk-nextjs",
    "lib",
    "adapter",
    "adapter.mjs",
  );
  const needle = "export {\n  adapter_default as default\n};";
  const source = readFileSync(copy, "utf8");
  if (!source.includes(needle)) {
    throw new Error(
      `Could not find the default export in ${copy}. The esbuild output shape changed; update this script.`,
    );
  }
  writeFileSync(
    copy,
    source.replace(
      needle,
      `
const __captureAdapter = {
  ...adapter_default,
  async onBuildComplete(ctx) {
    const { writeFile } = await import("node:fs/promises");
    const { routing, outputs, projectDir, repoRoot, distDir, nextVersion, buildId, config } = ctx;
    await writeFile(
      process.env.CDK_NEXTJS_DUMP_CTX,
      JSON.stringify({
        routing,
        outputs,
        projectDir,
        repoRoot,
        distDir,
        nextVersion,
        buildId,
        config: {
          basePath: config.basePath,
          trailingSlash: config.trailingSlash,
          assetPrefix: config.assetPrefix,
          i18n: config.i18n,
        },
      }),
    );
    return adapter_default.onBuildComplete(ctx);
  },
};
export { __captureAdapter as default };`,
    ),
  );
}

function trim(raw, { app, name }) {
  const realRoot = raw.repoRoot;
  const rewrite = (value) =>
    typeof value === "string" && value.startsWith(realRoot)
      ? PLACEHOLDER_ROOT + value.slice(realRoot.length)
      : value;

  // Output `pathname`s carry `basePath` (`/prod/api/health`) while `id`,
  // `sourcePage` and `prerenders[].route` do not, so the allowlist matches on
  // the basePath-stripped pathname and `keptTemplates` holds stripped names.
  const basePath = raw.config.basePath || "";
  const normalize = (pathname) => {
    let p = pathname;
    if (basePath && (p === basePath || p.startsWith(`${basePath}/`))) {
      p = p.slice(basePath.length);
    }
    p = p.replace(/\.rsc$/, "");
    return p === "" || p === "/index" ? "/" : p;
  };

  const keep = new Set(KEEP_PATHNAMES[app] ?? []);
  const keptTemplates = new Set();
  const keepOutput = (output) => {
    const base = normalize(output.pathname);
    if (keep.size === 0 || keep.has(base)) {
      keptTemplates.add(base);
      return true;
    }
    return false;
  };

  const trimOutput = (output) => {
    const assetKeys = Object.keys(output.assets).sort();
    const local = assetKeys.filter((k) => !k.startsWith("node_modules/"));
    const vendored = assetKeys
      .filter((k) => k.startsWith("node_modules/"))
      .slice(0, NODE_MODULES_ASSET_SAMPLE);
    const kept = [...local, ...vendored];

    const assets = {};
    const assetsHashes = {};
    for (const key of kept) {
      assets[key] = rewrite(output.assets[key]);
      if (output.assetsHashes[key] !== undefined) {
        assetsHashes[key] = output.assetsHashes[key];
      }
    }
    // The entrypoint's own hash is keyed in `assetsHashes` but deliberately
    // absent from `assets`; keeping it is what lets the tests assert the
    // entrypoint gets staged from its hash-derived key.
    for (const [key, hash] of Object.entries(output.assetsHashes)) {
      if (!(key in output.assets)) {
        assetsHashes[key] = hash;
      }
    }
    return {
      ...output,
      filePath: rewrite(output.filePath),
      assets,
      assetsHashes,
    };
  };

  const outputs = {
    pages: raw.outputs.pages.filter(keepOutput).map(trimOutput),
    pagesApi: raw.outputs.pagesApi.filter(keepOutput).map(trimOutput),
    appPages: raw.outputs.appPages.filter(keepOutput).map(trimOutput),
    appRoutes: raw.outputs.appRoutes.filter(keepOutput).map(trimOutput),
    prerenders: [
      // Dynamic templates are never dropped: they are what
      // `buildAdapterManifest` turns into extra `entrypoints`/`pathnames`
      // entries (Pages Router `/_next/data/…/[slug].json` in particular), so a
      // fixture without them would not exercise that path at all.
      ...raw.outputs.prerenders.filter(
        (p) => keptTemplates.has(p.route) && p.pathname.includes("["),
      ),
      ...raw.outputs.prerenders
        .filter((p) => keptTemplates.has(p.route) && !p.pathname.includes("["))
        .slice(0, MAX_PRERENDERS),
    ]
      .map((p) => ({
        ...p,
        fallback: p.fallback
          ? { ...p.fallback, filePath: rewrite(p.fallback.filePath) }
          : p.fallback,
      })),
    staticFiles: [
      ...raw.outputs.staticFiles.filter(
        (f) => !normalize(f.pathname).startsWith("/_next/static"),
      ),
      ...raw.outputs.staticFiles.filter((f) =>
        normalize(f.pathname).startsWith("/_next/static"),
      ),
    ]
      .slice(0, MAX_STATIC_FILES)
      .map((f) => ({ ...f, filePath: rewrite(f.filePath) })),
    middleware: raw.outputs.middleware
      ? trimOutput(raw.outputs.middleware)
      : undefined,
  };

  return {
    _meta: {
      fixture: name,
      capturedFrom: `examples/${app}`,
      nextVersion: raw.nextVersion,
      generatedBy: "scripts/capture-adapter-fixture.mjs",
      trimmed: {
        repoRootRewrittenTo: PLACEHOLDER_ROOT,
        keptRouteTemplates: [...keptTemplates].sort(),
        nodeModulesAssetsPerOutput: NODE_MODULES_ASSET_SAMPLE,
        maxConcretePrerenders: MAX_PRERENDERS,
        maxStaticFiles: MAX_STATIC_FILES,
      },
    },
    routing: raw.routing,
    outputs,
    projectDir: rewrite(raw.projectDir),
    repoRoot: PLACEHOLDER_ROOT,
    distDir: rewrite(raw.distDir),
    nextVersion: raw.nextVersion,
    buildId: raw.buildId,
    config: raw.config,
  };
}

main();

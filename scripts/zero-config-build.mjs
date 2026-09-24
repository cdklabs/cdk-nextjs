#!/usr/bin/env node
/**
 * Build a throwaway Next.js app against a *packed and installed* cdk-nextjs, with
 * no `adapterPath` in `next.config` — the zero-config path the README recommends
 * (`NEXT_ADAPTER_PATH`), which nothing else in CI covers.
 *
 *   pnpm compile && pnpm bundle
 *   node scripts/zero-config-build.mjs
 *
 * Why a packed tarball and not `examples/`. Every example takes cdk-nextjs as
 * `link:../..`, and a link is exactly the setup zero-config cannot serve: the
 * symlink resolves out of the project root, the adapter derives its cache handler
 * path from its own location, and Turbopack rejects a `cacheHandler` outside
 * `turbopack.root`. So the examples all set `adapterPath` explicitly, and the
 * variable they would otherwise exercise goes untested. `npm install` of a `.tgz`
 * extracts a real directory into the app's own `node_modules`, which is what a
 * user's install looks like and the only shape under which
 * `require.resolve("cdk-nextjs/adapter", { paths: [appDir] })` — the resolution
 * `NextjsBuild.adapterPathEnv` performs — produces a usable path.
 *
 * Two cases, one install, because the second is nearly free:
 *
 * 1. `next.config.js`, the plain zero-config case.
 * 2. `next.config.ts` using top-level `await`, built with
 *    `--experimental-next-config-strip-types` so Node.js's native TypeScript
 *    resolution loads it instead of the default swc-to-CJS transpile. This is the
 *    whole of what vercel/next.js's 18-file `next-config-ts-native-ts` family
 *    would tell us about cdk-nextjs: that `modifyConfig` still applies when the
 *    config arrives through the native loader. See docs/harness-coverage.md.
 *
 * No AWS, no deploy, no credentials. Two `next build`s and an `npm install`.
 *
 * Flags: `--dir <path>` to build somewhere fixed instead of a fresh mkdtemp, and
 * `--keep` to leave the tree behind for inspection.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODIFY_CONFIG_LOG = "Applying modifyConfig from cdk-nextjs-adapter";
/** `next`'s own warning when the native TS loader is not actually in use. */
const LEGACY_CONFIG_FALLBACK = "Falling back to legacy resolution";
const REACT_VERSION = "19.2.3";

function main() {
  const args = process.argv.slice(2);
  const dirFlag = args.indexOf("--dir");
  const keep = args.includes("--keep");

  const appDir = realpathSync(
    dirFlag === -1
      ? mkdtempSync(join(tmpdir(), "cdk-nextjs-zero-config-"))
      : mkdirIfNeeded(resolve(args[dirFlag + 1])),
  );
  console.log(`zero-config: building in ${appDir}`);

  try {
    const tarball = pack(appDir);
    writeFixture(appDir, tarball);
    run("npm", ["install", "--no-audit", "--no-fund"], appDir);

    // The same resolution `NextjsBuild.adapterPathEnv()` does, for the same
    // reason: from the *app*, so the adapter and its sibling cache handler both
    // live inside the project root.
    const adapterPath = createRequire(join(appDir, "package.json")).resolve(
      "cdk-nextjs/adapter",
    );
    console.log(`zero-config: NEXT_ADAPTER_PATH=${adapterPath}`);
    assert(
      adapterPath.startsWith(join(appDir, "node_modules", "cdk-nextjs") + "/"),
      `the adapter resolved outside the app's node_modules: ${adapterPath}`,
    );

    writeConfigJs(appDir);
    check(appDir, adapterPath, {
      label: "next.config.js (default config loader)",
      distDir: ".next-cjs",
      buildArgs: [],
    });

    writeConfigTs(appDir);
    check(appDir, adapterPath, {
      label: "next.config.ts with top-level await (native TS loader)",
      distDir: ".next-ts",
      buildArgs: ["--experimental-next-config-strip-types"],
      // The default loader transpiles to CJS, which cannot express top-level
      // `await`; a silent fallback would surface as ERR_REQUIRE_ASYNC_MODULE
      // rather than a pass, but assert on the warning too so a future fallback
      // that *does* succeed cannot masquerade as native-loader coverage.
      forbid: LEGACY_CONFIG_FALLBACK,
    });

    console.log("\nzero-config: both cases passed");
  } finally {
    if (keep) {
      console.log(`zero-config: left ${appDir} in place (--keep)`);
    } else {
      rmSync(appDir, { recursive: true, force: true });
    }
  }
}

function mkdirIfNeeded(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * `npm pack` the working tree into `appDir`. Fails loudly if the bundled runtime
 * files are missing, because the tarball would otherwise be published-shaped but
 * adapter-less and every assertion below would be about nothing.
 */
function pack(appDir) {
  for (const file of [
    "lib/adapter/adapter.mjs",
    "lib/adapter/cache-handler.mjs",
    "lib/index.js",
  ]) {
    assert(
      existsSync(join(repoRoot, file)),
      `${file} is missing — run \`pnpm compile && pnpm bundle\` first.`,
    );
  }
  const out = execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", appDir],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const filename = JSON.parse(out)[0].filename;
  const tarball = join(appDir, filename);
  assert(existsSync(tarball), `npm pack reported ${filename}, which is absent`);
  console.log(`zero-config: packed ${filename}`);
  return tarball;
}

function writeFixture(appDir, tarball) {
  // The exact `next` this repo's own lockfile resolved, not its `^16.3.5` range:
  // a per-PR gate should fail on our changes, not on a patch release that landed
  // between two runs of the same commit.
  const nextVersion = JSON.parse(
    readFileSync(
      join(repoRoot, "node_modules", "next", "package.json"),
      "utf8",
    ),
  ).version;

  write(appDir, "package.json", {
    name: "cdk-nextjs-zero-config-fixture",
    version: "0.0.0",
    private: true,
    dependencies: {
      // `file:` on a tarball extracts; `file:` on a directory would symlink,
      // which is the case this fixture exists to avoid.
      "cdk-nextjs": `file:${tarball}`,
      next: nextVersion,
      // Pinned for the same reason, and to the `react` in
      // `examples/pnpm-workspace.yaml`'s catalog. Bump the two together.
      react: REACT_VERSION,
      "react-dom": REACT_VERSION,
    },
    devDependencies: {
      "@types/node": "^24",
      "@types/react": "^19",
      typescript: "^5",
    },
  });

  write(appDir, "tsconfig.json", {
    compilerOptions: {
      target: "ES2022",
      lib: ["dom", "dom.iterable", "esnext"],
      module: "esnext",
      moduleResolution: "bundler",
      jsx: "preserve",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      isolatedModules: true,
      incremental: true,
    },
    include: ["**/*.ts", "**/*.tsx", ".next-cjs/types/**/*.ts"],
    exclude: ["node_modules"],
  });

  write(
    appDir,
    "app/layout.tsx",
    `export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
  );

  write(
    appDir,
    "app/page.tsx",
    `export default function Page() {
  return <main>zero-config</main>;
}
`,
  );

  // An ISR route, so \`onBuildComplete\` has a prerender to seed and the init
  // cache is a real assertion rather than an empty directory.
  write(
    appDir,
    "app/isr/[id]/page.tsx",
    `export const revalidate = 60;

export function generateStaticParams() {
  return [{ id: "1" }];
}

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <main>isr {id}</main>;
}
`,
  );
}

/** Zero-config: `distDir` and nothing else. No `adapterPath`. */
function writeConfigJs(appDir) {
  rmSync(join(appDir, "next.config.ts"), { force: true });
  write(
    appDir,
    "next.config.js",
    `/** @type {import("next").NextConfig} */
module.exports = {
  distDir: ".next-cjs",
};
`,
  );
}

/**
 * Also zero-config, but reached through Node.js's native TypeScript resolution:
 * top-level `await` is what the default swc-to-CJS loader cannot express, so this
 * file only loads under `--experimental-next-config-strip-types`. `distDir` comes
 * *out* of the await, which makes every path assertion below evidence that the
 * awaited value reached Next.js.
 */
function writeConfigTs(appDir) {
  rmSync(join(appDir, "next.config.js"), { force: true });
  write(
    appDir,
    "next.config.ts",
    `import type { NextConfig } from "next";

const resolved = await Promise.resolve({ distDir: ".next-ts" });

const nextConfig: NextConfig = { ...resolved };

export default nextConfig;
`,
  );
}

function check(appDir, adapterPath, { label, distDir, buildArgs, forbid }) {
  console.log(`\nzero-config: === ${label} ===`);
  const dist = join(appDir, distDir);
  rmSync(dist, { recursive: true, force: true });

  const output = build(appDir, buildArgs, adapterPath);

  assert(
    output.includes(MODIFY_CONFIG_LOG),
    `"${MODIFY_CONFIG_LOG}" is absent from the build log — the adapter was not loaded, so NEXT_ADAPTER_PATH did not take effect.`,
  );
  if (forbid) {
    assert(!output.includes(forbid), `the build log contains "${forbid}"`);
  }

  // What `modifyConfig` returned, as the build recorded it. Covers the half of
  // zero-config that the log line does not: that the adapter injected a cache
  // handler resolved from its own installed location.
  const required = readJson(join(dist, "required-server-files.json"));
  assert(
    required.config.adapterPath === adapterPath,
    `required-server-files.json records adapterPath ${required.config.adapterPath}, expected ${adapterPath}`,
  );
  // Relative to `distDir`, which is how Next.js stores it.
  const cacheHandler = resolve(dist, required.config.cacheHandler);
  assert(
    cacheHandler ===
      join(
        appDir,
        "node_modules",
        "cdk-nextjs",
        "lib",
        "adapter",
        "cache-handler.mjs",
      ) && existsSync(cacheHandler),
    `cacheHandler resolved to ${cacheHandler}, which is not the installed package's`,
  );
  assert(
    required.config.images.customCacheHandler === true,
    "images.customCacheHandler was not set by modifyConfig",
  );

  // `onBuildComplete`: the manifest and the staging tree that replace
  // `output: "standalone"`.
  const adapterDir = join(dist, "cdk-nextjs-adapter");
  const manifest = readJson(join(adapterDir, "manifest.json"));
  assert(manifest.version === 1, `manifest version ${manifest.version}`);
  for (const route of ["/", "/isr/[id]"]) {
    assert(
      manifest.entrypoints[route],
      `manifest has no entrypoint for ${route}`,
    );
    const staged = join(
      adapterDir,
      "app",
      manifest.entrypoints[route].filePath,
    );
    assert(
      existsSync(staged),
      `${route}'s entrypoint is not staged: ${staged}`,
    );
  }

  const seeded = jsonFilesIn(join(dist, "cdk-nextjs-init-cache"));
  assert(seeded > 0, "the init cache holds no entries");

  console.log(
    `zero-config: ok — ${Object.keys(manifest.entrypoints).length} entrypoints, ${seeded} seeded cache entries`,
  );
}

function build(appDir, buildArgs, adapterPath) {
  const next = join(appDir, "node_modules", ".bin", "next");
  console.log(`$ next build ${buildArgs.join(" ")}  (in ${appDir})`);
  const result = spawnSync(next, ["build", ...buildArgs], {
    cwd: appDir,
    encoding: "utf8",
    env: {
      ...process.env,
      // The point of the exercise: no `adapterPath` in `next.config`.
      NEXT_ADAPTER_PATH: adapterPath,
      NEXT_TELEMETRY_DISABLED: "1",
      // Not set by CDK here, so the adapter defaults it inside `distDir` — which
      // is where the init-cache assertion looks.
      CDK_NEXTJS_INIT_CACHE_DIR: "",
    },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(output);
  if (result.error) throw result.error;
  assert(result.status === 0, `next build exited with ${result.status}`);
  return output;
}

function jsonFilesIn(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    count += entry.isDirectory()
      ? jsonFilesIn(join(dir, entry.name))
      : entry.name.endsWith(".json")
        ? 1
        : 0;
  }
  return count;
}

function readJson(path) {
  assert(existsSync(path), `${path} was not written`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function write(appDir, relative, contents) {
  const path = join(appDir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    typeof contents === "string"
      ? contents
      : `${JSON.stringify(contents, null, 2)}\n`,
  );
}

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(" ")}  (in ${cwd})`);
  execFileSync(cmd, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
}

function assert(condition, message) {
  if (!condition) throw new Error(`zero-config: ${message}`);
}

main();

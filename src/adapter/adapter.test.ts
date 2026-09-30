/* eslint-disable import/no-extraneous-dependencies */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";

// `adapter.mts` is ESM that calls `import.meta.resolve`, which ts-jest's
// CommonJS cannot run, so it is bundled the way `pnpm bundle` does and driven
// from a real `node`. Its `cdk-nextjs/…` specifiers resolve against a stand-in
// package carrying the real `exports`, so the test needs no prior bundle.
const repoRoot = join(__dirname, "..", "..");
let dir: string;
let pkgDir: string;

beforeAll(() => {
  // Real, since `import.meta.resolve` returns real paths (macOS's tmpdir is a link).
  dir = realpathSync(mkdtempSync(join(tmpdir(), "cdk-nextjs-adapter-")));
  pkgDir = join(dir, "node_modules", "cdk-nextjs");
  const { exports } = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf-8"),
  );
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "cdk-nextjs", exports }),
  );
  for (const target of Object.values(exports) as { import: string }[]) {
    mkdirSync(dirname(join(pkgDir, target.import)), { recursive: true });
    writeFileSync(join(pkgDir, target.import), "");
  }
  symlinkSync(
    join(repoRoot, "node_modules", "next"),
    join(dir, "node_modules", "next"),
  );
  buildSync({
    entryPoints: [join(repoRoot, "src/adapter/adapter.mts")],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    external: ["next"],
    outfile: join(dir, "adapter.mjs"),
    banner: {
      js: "import { createRequire as __cdkNextjsCreateRequire } from 'node:module'; const require = __cdkNextjsCreateRequire(import.meta.url);",
    },
    logLevel: "silent",
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** `adapter.modifyConfig(config, { phase, nextVersion })`, run by `node`. */
function modifyConfig(
  config: Record<string, unknown>,
  phase: string,
  nextVersion = "16.3.0",
): Record<string, any> {
  const script =
    `import adapter from ${JSON.stringify(join(dir, "adapter.mjs"))};` +
    `const out = await adapter.modifyConfig(${JSON.stringify(config)}, ` +
    `${JSON.stringify({ phase, nextVersion })});` +
    `process.stdout.write(JSON.stringify(out));`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

const handler = (path: string) => join(pkgDir, "lib/adapter", path);
const ours = () => ({
  default: handler("use-cache-default-handler.mjs"),
  remote: handler("use-cache-remote-handler.mjs"),
});

describe("modifyConfig", () => {
  it("wires cdk-nextjs's cache handlers into the build", () => {
    const out = modifyConfig({ images: {} }, "phase-production-build");
    expect(out.cacheHandler).toBe(handler("cache-handler.mjs"));
    expect(out.cacheHandlers).toEqual(ours());
    expect(out.images.customCacheHandler).toBe(true);
  });

  it("keeps the handlers the app configured, and adds the missing ones", () => {
    const out = modifyConfig(
      {
        cacheHandler: "/app/my-handler.js",
        cacheHandlers: { remote: "/app/remote.js", custom: "/app/custom.js" },
        images: { customCacheHandler: "/app/images.js" },
      },
      "phase-production-build",
    );
    expect(out.cacheHandler).toBe("/app/my-handler.js");
    expect(out.cacheHandlers).toEqual({
      default: ours().default,
      remote: "/app/remote.js",
      custom: "/app/custom.js",
    });
    expect(out.images.customCacheHandler).toBe("/app/images.js");
  });

  // `next start` registers `use cache` handlers from this config, once.
  it("registers the same `use cache` handlers for `next start`", () => {
    const out = modifyConfig(
      { cacheHandlers: { default: "/app/default.js" } },
      "phase-production-server",
    );
    expect(out.cacheHandlers).toEqual({
      default: "/app/default.js",
      remote: ours().remote,
    });
    expect(out.cacheHandler).toBeUndefined();
  });

  it("leaves other phases alone", () => {
    expect(modifyConfig({ images: {} }, "phase-development-server")).toEqual({
      images: {},
    });
  });
});

describe("assertSupportedNextVersion", () => {
  it.each(["16.2.9", "15.5.0"])(
    "rejects Next.js %s at build time",
    (version) => {
      expect(() =>
        modifyConfig({ images: {} }, "phase-production-build", version),
      ).toThrow(`Next.js ${version} is not supported`);
    },
  );

  it.each(["16.3.0", "17.0.0-canary.1"])("accepts Next.js %s", (version) => {
    expect(() =>
      modifyConfig({ images: {} }, "phase-production-build", version),
    ).not.toThrow();
  });
});

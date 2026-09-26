/* eslint-disable import/no-extraneous-dependencies */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import {
  NextjsBuild,
  dereferencedSize,
  listTree,
  patchClientChunk,
  sharpBinaryDir,
} from "./nextjs-build";
import { NextjsType } from "../constants";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nextjs-build-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/**
 * The layout pnpm stages: `sharp`'s files in the virtual store, reached through
 * links from the app and from `next`.
 */
function stagePnpmSharp(root: string) {
  const store = join(
    root,
    "node_modules/.pnpm/sharp@0.34.5/node_modules/sharp",
  );
  write(
    join(store, "package.json"),
    JSON.stringify({ name: "sharp", main: "index.js" }),
  );
  write(
    join(store, "index.js"),
    'module.exports = require("@img/sharp-linux-x64");',
  );
  mkdirSync(join(root, "node_modules/.pnpm/next@16/node_modules"), {
    recursive: true,
  });
  symlinkSync(
    "../../sharp@0.34.5/node_modules/sharp",
    join(root, "node_modules/.pnpm/next@16/node_modules/sharp"),
  );
  mkdirSync(join(root, "apps/web/node_modules"), { recursive: true });
  symlinkSync(
    "../../../node_modules/.pnpm/sharp@0.34.5/node_modules/sharp",
    join(root, "apps/web/node_modules/sharp"),
  );
}

describe("sharpBinaryDir", () => {
  it("is reachable from every copy of sharp once the tree is dereferenced", () => {
    // The Functions zip follows links, so each link to `sharp` becomes its own
    // copy that resolves `@img/...` from where it sits, never from the store.
    const staged = join(dir, "staged");
    stagePnpmSharp(staged);
    const binary = join(sharpBinaryDir(staged), "sharp-linux-x64");
    write(
      join(binary, "package.json"),
      JSON.stringify({ name: "@img/sharp-linux-x64", main: "index.js" }),
    );
    write(join(binary, "index.js"), 'module.exports = "loaded";');

    const zipped = join(dir, "zipped");
    // `cp -RL`, not `cpSync`'s `dereference`, which only resolves the top-level
    // source and re-links everything under it to the original.
    execFileSync("cp", ["-RL", staged, zipped]);

    for (const root of [staged, zipped]) {
      for (const copy of [
        "apps/web/node_modules/sharp",
        "node_modules/.pnpm/next@16/node_modules/sharp",
        "node_modules/.pnpm/sharp@0.34.5/node_modules/sharp",
      ]) {
        // A real `node`, not jest's `require`, whose resolver differs from
        // Node's in how it walks up from a module.
        expect(
          execFileSync(
            process.execPath,
            ["-p", `require(${JSON.stringify(join(root, copy))})`],
            { encoding: "utf-8" },
          ).trim(),
        ).toBe("loaded");
      }
    }
  });
});

describe("listTree", () => {
  it("lists links without descending into them, so a cycle ends", () => {
    write(join(dir, "packages/a/index.js"), "");
    write(join(dir, "packages/b/index.js"), "");
    mkdirSync(join(dir, "packages/a/node_modules/@org"), { recursive: true });
    mkdirSync(join(dir, "packages/b/node_modules/@org"), { recursive: true });
    symlinkSync("../../../b", join(dir, "packages/a/node_modules/@org/b"));
    symlinkSync("../../../a", join(dir, "packages/b/node_modules/@org/a"));

    const files = listTree(dir)
      .filter((entry) => entry.name === "index.js")
      .map((entry) => entry.parentPath);
    expect(files.sort()).toEqual([
      join(dir, "packages/a"),
      join(dir, "packages/b"),
    ]);
  });
});

describe("dereferencedSize", () => {
  it("counts a directory once per link to it, as the zip holds it", () => {
    write(join(dir, "store/pkg/file"), "x".repeat(100));
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "b"));
    symlinkSync("../store/pkg", join(dir, "a/pkg"));
    symlinkSync("../store/pkg", join(dir, "b/pkg"));

    expect(dereferencedSize(dir)).toBe(300);
  });

  it("counts a linked file at its target's size", () => {
    write(join(dir, "real"), "x".repeat(10));
    symlinkSync("real", join(dir, "link"));

    expect(dereferencedSize(dir)).toBe(20);
  });

  it("terminates on a cycle and skips a dangling link", () => {
    write(join(dir, "a/file"), "x".repeat(10));
    symlinkSync("..", join(dir, "a/up"));
    symlinkSync("missing", join(dir, "a/dangling"));

    expect(dereferencedSize(dir)).toBe(10);
  });
});

describe("patchClientChunk", () => {
  const chunk = "console.log('app');";

  it("prepends the patch once", () => {
    const patched = patchClientChunk(chunk, "PATCH_V1", "chunk.js")!;
    expect(patched).toMatch(/^\/\* cdk-nextjs:patch-fetch [0-9a-f]{16} \*\/\n/);
    expect(patched).toContain("PATCH_V1");
    expect(patched.endsWith(`\n${chunk}`)).toBe(true);
    expect(patchClientChunk(patched, "PATCH_V1", "chunk.js")).toBeUndefined();
  });

  it("replaces a patch from another cdk-nextjs version", () => {
    const old = patchClientChunk(chunk, "PATCH_V1", "chunk.js")!;
    const updated = patchClientChunk(old, "PATCH_V2", "chunk.js")!;

    expect(updated).toContain("PATCH_V2");
    expect(updated).not.toContain("PATCH_V1");
    expect(updated.endsWith(`\n${chunk}`)).toBe(true);
    expect(updated).toBe(patchClientChunk(chunk, "PATCH_V2", "chunk.js"));
  });

  it("refuses a patch without an end marker rather than stacking on it", () => {
    expect(() =>
      patchClientChunk(
        `/* cdk-nextjs:patch-fetch */\nOLD\n${chunk}`,
        "PATCH_V2",
        "chunk.js",
      ),
    ).toThrow(/Re-run `next build`/);
  });
});

describe("NextjsBuild with skipBuild and no build output", () => {
  it("reports the missing adapter manifest, not a bare ENOENT", () => {
    // `GLOBAL_FUNCTIONS` patches `.next/static/chunks`, which used to be read
    // first and fail on the missing directory.
    expect(
      () =>
        new NextjsBuild(new Stack(new App(), "Stack"), "Build", {
          buildCommand: "true",
          buildDirectory: dir,
          nextjsType: NextjsType.GLOBAL_FUNCTIONS,
          skipBuild: true,
        }),
    ).toThrow(/cdk-nextjs adapter manifest not found/);
  });
});

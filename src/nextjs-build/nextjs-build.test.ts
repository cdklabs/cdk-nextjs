/* eslint-disable import/no-extraneous-dependencies */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Architecture } from "aws-cdk-lib/aws-lambda";
import {
  deploymentArchitecture,
  deploymentBuildId,
  isSharpBinaryPackage,
  listTree,
  NextjsBuild,
  patchClientChunk,
  pickStagedSharpPackage,
  resolveNextSharp,
  sharpBinaryDir,
  storedSize,
  writePublicFileList,
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
  it("is reachable from every copy of sharp, links kept or dereferenced", () => {
    // The zip and the image keep links, so the store copy loads; a dereferenced
    // copy resolves `@img/...` from where it sits, never from the store.
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

describe("isSharpBinaryPackage", () => {
  it.each([
    ["node_modules/@img", "sharp-linux-x64", true],
    ["node_modules/@img", "sharp-linuxmusl-arm64", true],
    ["node_modules/@img", "sharp-libvips-darwin-arm64", true],
    ["apps/web/node_modules/@img", "sharp-darwin-arm64", true],
    ["node_modules/.pnpm", "@img+sharp-darwin-arm64@0.34.5", true],
    ["node_modules/.pnpm", "@img+sharp-libvips-darwin-arm64@1.2.4", true],
    [
      "node_modules/.pnpm/sharp@0.34.5/node_modules/@img",
      "sharp-linux-x64",
      true,
    ],
    // A route segment, not a package.
    [".next/server/app", "sharp-edges", false],
    // Unrelated `sharp-` dependencies.
    ["node_modules", "sharp-ico", false],
    ["node_modules/.pnpm", "sharp-phash@2.0.0", false],
    ["node_modules/.pnpm", "sharp@0.34.5", false],
    // `sharp` itself, the JS wrapper that loads the binary.
    ["node_modules", "sharp", false],
    ["node_modules/@img", "colour", false],
    // App directories that happen to share the names, outside `node_modules`.
    ["apps/web/@img", "sharp-linux-x64", false],
    ["apps/web/.pnpm", "@img+sharp-linux-x64@0.34.5", false],
  ])("%s/%s is %s", (parent, name, expected) => {
    expect(isSharpBinaryPackage(join(dir, parent), name)).toBe(expected);
  });
});

describe("pickStagedSharpPackage", () => {
  it("returns undefined when the tree has no sharp", () => {
    expect(pickStagedSharpPackage([])).toBeUndefined();
  });

  it("prefers the shortest path, the closest to a hoisted install", () => {
    expect(
      pickStagedSharpPackage([
        "/r/node_modules/.pnpm/sharp@0.34.5/node_modules/sharp",
        "/r/apps/web/node_modules/sharp",
        "/r/node_modules/sharp",
      ]),
    ).toBe("/r/node_modules/sharp");
  });

  it("breaks a length tie by name, whatever order the walk found them in", () => {
    const a = "/r/node_modules/.pnpm/sharp@0.34.4/node_modules/sharp";
    const b = "/r/node_modules/.pnpm/sharp@0.34.5/node_modules/sharp";
    expect(pickStagedSharpPackage([b, a])).toBe(a);
    expect(pickStagedSharpPackage([a, b])).toBe(a);
  });

  // npm nests next's own `sharp` when the app's hoisted one is another version;
  // the binaries have to match the copy the image optimizer loads.
  it("picks the copy the staged next resolves, over a shorter one", () => {
    const root = join(dir, "staged");
    const hoisted = join(root, "node_modules/sharp");
    const nested = join(root, "node_modules/next/node_modules/sharp");
    for (const sharp of [hoisted, nested]) {
      write(
        join(sharp, "package.json"),
        JSON.stringify({ name: "sharp", main: "index.js" }),
      );
      write(join(sharp, "index.js"), "");
    }
    write(
      join(root, "node_modules/next/package.json"),
      JSON.stringify({ name: "next" }),
    );
    const nextSharp = resolveNextSharp(join(root, "apps/web"));
    expect(nextSharp).toBe(join(realpathSync(nested), "index.js"));
    expect(pickStagedSharpPackage([hoisted, nested], nextSharp)).toBe(nested);
  });

  it("resolves nothing when the staged tree has no next", () => {
    expect(resolveNextSharp(join(dir, "apps/web"))).toBeUndefined();
  });
});

describe("Sharp staging for the deployment target", () => {
  // A version no real `sharp` pins, so the tarballs seeded into the shared
  // download cache below are never mistaken for (or clobber) real ones.
  const VERSION = "0.0.0-cdk-nextjs-test";
  const cacheDir = join(tmpdir(), "cdk-nextjs-sharp-cache");
  const seeded: string[] = [];

  afterAll(() => {
    for (const file of seeded) rmSync(file, { force: true });
  });

  /** Seed the download cache so the install runs without the registry. */
  function seedCache(name: string) {
    const pkg = join(dir, "tgz", name, "package");
    write(join(pkg, "package.json"), JSON.stringify({ name: `@img/${name}` }));
    mkdirSync(cacheDir, { recursive: true });
    const tgz = join(cacheDir, `${name}-${VERSION}.tgz`);
    execFileSync("tar", ["-czf", tgz, "-C", join(pkg, ".."), "package"]);
    seeded.push(tgz);
  }

  // Private: the methods `NextjsBuild` runs per deployment root, which only
  // touch the filesystem, so they run here without a construct.
  const build = NextjsBuild.prototype as unknown as {
    removeExistingSharpBinaries(
      root: string,
      projectDir: string,
    ): string | undefined;
    stageSharpForTarget(
      root: { name: string; path: string },
      projectDir: string,
      platform: string,
    ): void;
  };

  /** A staged pnpm `sharp` that pins test-version binaries for `platform`. */
  function stagePinnedSharp(root: string, platform: string) {
    stagePnpmSharp(root);
    write(
      join(
        root,
        "node_modules/.pnpm/sharp@0.34.5/node_modules/sharp/package.json",
      ),
      JSON.stringify({
        name: "sharp",
        version: "0.34.5",
        optionalDependencies: {
          [`@img/sharp-${platform}`]: VERSION,
          [`@img/sharp-libvips-${platform}`]: VERSION,
        },
      }),
    );
    for (const name of [`sharp-${platform}`, `sharp-libvips-${platform}`]) {
      seedCache(name);
    }
  }

  it.each([
    ["linux-x64", "darwin-arm64"],
    ["linux-arm64", "linux-x64"],
    ["linuxmusl-arm64", "linux-x64"],
  ])(
    "replaces the host's binaries with %s ones, leaving look-alikes",
    (platform, host) => {
      const root = join(dir, "staged");
      stagePnpmSharp(root);
      const store = join(
        root,
        "node_modules/.pnpm/sharp@0.34.5/node_modules/sharp",
      );
      write(
        join(store, "package.json"),
        JSON.stringify({
          name: "sharp",
          version: "0.34.5",
          optionalDependencies: {
            [`@img/sharp-${platform}`]: VERSION,
            [`@img/sharp-libvips-${platform}`]: VERSION,
          },
        }),
      );
      // The host's binaries as pnpm stages them: in the store, linked from
      // next to `sharp`, and (hoisted) at the root.
      for (const name of [`sharp-${host}`, `sharp-libvips-${host}`]) {
        write(
          join(
            root,
            `node_modules/.pnpm/@img+${name}@0.34.5/node_modules/@img/${name}/package.json`,
          ),
          "{}",
        );
        mkdirSync(
          join(root, "node_modules/.pnpm/sharp@0.34.5/node_modules/@img"),
          { recursive: true },
        );
        symlinkSync(
          `../../../@img+${name}@0.34.5/node_modules/@img/${name}`,
          join(
            root,
            `node_modules/.pnpm/sharp@0.34.5/node_modules/@img/${name}`,
          ),
        );
        write(join(root, `node_modules/@img/${name}/package.json`), "{}");
      }
      const lookalikes = [
        "apps/web/.next/server/app/sharp-edges/page.js",
        "node_modules/.pnpm/sharp-ico@0.1.5/node_modules/sharp-ico/package.json",
        "apps/web/node_modules/sharp-ico/package.json",
      ];
      for (const file of lookalikes) write(join(root, file), "");
      for (const name of [`sharp-${platform}`, `sharp-libvips-${platform}`]) {
        seedCache(name);
      }

      const source = build.removeExistingSharpBinaries(
        root,
        join(root, "apps/web"),
      );
      expect(source).toBe(store);
      build.stageSharpForTarget(
        { name: "default", path: root },
        join(root, "apps/web"),
        platform,
      );

      expect(readdirSync(sharpBinaryDir(root)).sort()).toEqual(
        [`sharp-${platform}`, `sharp-libvips-${platform}`].sort(),
      );
      expect(
        JSON.parse(
          readFileSync(
            join(sharpBinaryDir(root), `sharp-${platform}/package.json`),
            "utf-8",
          ),
        ).name,
      ).toBe(`@img/sharp-${platform}`);
      // No host binary survives, dangling link or otherwise.
      expect(
        listTree(root).filter((entry) => entry.name.includes(host)),
      ).toEqual([]);
      for (const file of lookalikes) {
        expect(existsSync(join(root, file))).toBe(true);
      }
    },
  );

  it("warns and installs nothing when the build staged no sharp", () => {
    const root = join(dir, "staged");
    write(join(root, "apps/web/server.js"), "");
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const source = build.removeExistingSharpBinaries(
      root,
      join(root, "apps/web"),
    );
    expect(source).toBeUndefined();
    build.stageSharpForTarget(
      { name: "default", path: root },
      join(root, "apps/web"),
      "linux-arm64",
    );
    expect(existsSync(sharpBinaryDir(root))).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"sharp" not found'),
    );
    warn.mockRestore();
  });

  describe("per function group", () => {
    const platform = "linux-arm64";
    const stage = (name: string) =>
      build.stageSharpForTarget(
        { name, path: join(dir, "staged") },
        join(dir, "staged/apps/web"),
        platform,
      );

    // Only `default` serves `/_next/image`, so a group without sharp is normal.
    it("installs nothing and stays quiet for a group without sharp", () => {
      write(join(dir, "staged/apps/web/server.js"), "");
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      stage("api");
      expect(existsSync(sharpBinaryDir(join(dir, "staged")))).toBe(false);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("warns for default without sharp, which can't optimize images", () => {
      write(join(dir, "staged/apps/web/server.js"), "");
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      stage("default");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('"sharp" not found'),
      );
      warn.mockRestore();
    });

    it("installs the target's binaries for a group whose own routes use sharp", () => {
      stagePinnedSharp(join(dir, "staged"), platform);
      stage("api");
      expect(readdirSync(sharpBinaryDir(join(dir, "staged"))).sort()).toEqual(
        [`sharp-${platform}`, `sharp-libvips-${platform}`].sort(),
      );
    });
  });
});

describe("deploymentBuildId", () => {
  it("is Next.js's build ID when the app sets no deploymentId", () => {
    expect(
      deploymentBuildId({ buildId: "b1", config: { deploymentId: "" } }),
    ).toBe("b1");
  });

  // With `NEXT_DEPLOYMENT_ID`, Next's BUILD_ID is a constant, so without the
  // suffix every deployment would share one cache partition.
  it("is suffixed with the deploymentId when the app sets one", () => {
    expect(
      deploymentBuildId({ buildId: "b1", config: { deploymentId: "d7" } }),
    ).toBe("b1-d7");
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

describe("storedSize", () => {
  it("counts a link as its target path, as the zip stores it", () => {
    write(join(dir, "store/pkg/file"), "x".repeat(100));
    mkdirSync(join(dir, "a"));
    symlinkSync("../store/pkg", join(dir, "a/pkg"));

    expect(storedSize(dir)).toBe(100 + "../store/pkg".length);
  });

  it("terminates on a cycle and counts a dangling link", () => {
    write(join(dir, "a/file"), "x".repeat(10));
    symlinkSync("..", join(dir, "a/up"));
    symlinkSync("missing", join(dir, "a/dangling"));

    expect(storedSize(dir)).toBe(10 + "..".length + "missing".length);
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

describe("writePublicFileList", () => {
  it("lists public/ the way the runtime lists it off disk", () => {
    // Written at synth, after the build command, so a `postbuild` file (here
    // `sitemap.xml`) is listed; a linked directory is followed.
    const publicDir = join(dir, "public");
    write(join(publicDir, "sitemap.xml"), "<urlset/>");
    write(join(publicDir, "images", "logo@2x.png"), "png");
    write(join(dir, "shared", "hello e2e.txt"), "hi");
    symlinkSync(join(dir, "shared"), join(publicDir, "static"));
    const runtimeDir = join(dir, "cdk-nextjs-runtime");
    mkdirSync(runtimeDir);
    writePublicFileList(runtimeDir, publicDir);
    expect(
      JSON.parse(readFileSync(join(runtimeDir, "public-files.json"), "utf-8")),
    ).toEqual(["images/logo@2x.png", "sitemap.xml", "static/hello e2e.txt"]);
  });

  it("writes an empty list for an app without public/", () => {
    writePublicFileList(dir, join(dir, "public"));
    expect(
      JSON.parse(readFileSync(join(dir, "public-files.json"), "utf-8")),
    ).toEqual([]);
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

describe("NextjsBuild with a build split by other functionGroups", () => {
  it("rejects a build whose groups kept their names but not their routes", () => {
    // Moving `/reports/**` into `api` keeps the group names, and a names-only
    // check let CloudFront send `reports/*` to a zip without those routes.
    write(join(dir, ".next", "BUILD_ID"), "b1");
    write(
      join(dir, ".next", "cdk-nextjs-adapter", "manifest.json"),
      JSON.stringify({
        version: 1,
        buildId: "b1",
        relativeProjectDir: "",
        config: { basePath: "", assetPrefix: "", trailingSlash: false },
        entrypoints: {},
        groups: { default: [], api: [] },
        functionGroups: [{ name: "api", routes: ["/api/**"] }],
      }),
    );
    expect(
      () =>
        new NextjsBuild(new Stack(new App(), "Stack"), "Build", {
          buildCommand: "true",
          buildDirectory: dir,
          nextjsType: NextjsType.REGIONAL_FUNCTIONS,
          skipBuild: true,
          functionGroups: [{ name: "api", routes: ["/api/**", "/reports/**"] }],
        }),
    ).toThrow(/build output is\s+stale/);
  });

  it("accepts a build whose groups and routes were only listed in another order", () => {
    // Only the stale check is under test: past it, the unstaged roots throw.
    write(join(dir, ".next", "BUILD_ID"), "b1");
    write(
      join(dir, ".next", "cdk-nextjs-adapter", "manifest.json"),
      JSON.stringify({
        version: 1,
        buildId: "b1",
        relativeProjectDir: "",
        config: { basePath: "", assetPrefix: "", trailingSlash: false },
        entrypoints: {},
        groups: { default: [], api: [], docs: [] },
        functionGroups: [
          { name: "api", routes: ["/api/**", "/reports/**"] },
          { name: "docs", routes: ["/docs/**"] },
        ],
      }),
    );
    expect(
      () =>
        new NextjsBuild(new Stack(new App(), "Stack"), "Build", {
          buildCommand: "true",
          buildDirectory: dir,
          nextjsType: NextjsType.REGIONAL_FUNCTIONS,
          skipBuild: true,
          functionGroups: [
            { name: "docs", routes: ["/docs/**"] },
            { name: "api", routes: ["/reports/**", "/api/**"] },
          ],
        }),
    ).not.toThrow(/stale/);
  });
});

describe("deploymentArchitecture", () => {
  const base = { buildCommand: "", buildDirectory: "" };
  const functions = { ...base, nextjsType: NextjsType.GLOBAL_FUNCTIONS };

  const host = process.arch.startsWith("arm") ? "arm64" : "x86_64";

  it("stages the Functions types for the synth machine unless told otherwise", () => {
    expect(deploymentArchitecture(functions).name).toBe(host);
  });

  // The point of honoring the prop: `sharp` for another architecture is only
  // a download, so the build no longer has to run where the function will.
  it("stages for the architecture asked for, not the synth machine's", () => {
    const other = host === "arm64" ? Architecture.X86_64 : Architecture.ARM_64;
    expect(deploymentArchitecture({ ...functions, architecture: other })).toBe(
      other,
    );
  });

  it("follows the synth machine for the Containers types", () => {
    const props = {
      ...base,
      nextjsType: NextjsType.REGIONAL_CONTAINERS,
      architecture:
        host === "arm64" ? Architecture.X86_64 : Architecture.ARM_64,
    };
    expect(deploymentArchitecture(props).name).toBe(host);
  });
});

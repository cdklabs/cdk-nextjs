import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import appPlaygroundBasePath from "./__fixtures__/app-playground-base-path.json";
import appPlayground from "./__fixtures__/app-playground.json";
import pagesI18n from "./__fixtures__/pages-i18n.json";
import {
  BuildCompleteContext,
  buildAdapterManifest,
  writeBuildOutputs,
} from "./build-outputs";
import { RUNTIME_DIR_NAME } from "../runtime/manifest";

/**
 * The fixtures are real `onBuildComplete` contexts captured by
 * `scripts/capture-adapter-fixture.mjs`, with absolute paths rewritten to a
 * `/repo` placeholder. Regenerate them when `next` is upgraded.
 */
const fixtures = {
  "app-playground": appPlayground,
  "app-playground-base-path": appPlaygroundBasePath,
  "pages-i18n": pagesI18n,
} as const;

/** Fixtures are JSON, so the structural cast is the point of the cast. */
const asContext = (fixture: unknown): BuildCompleteContext =>
  structuredClone(fixture) as BuildCompleteContext;

/**
 * `buildAdapterManifest` requires the build cwd to be the project dir — see
 * `assertBuildCwd`. The fixtures' project dirs are synthetic `/repo/…` paths, so
 * every call supplies it rather than letting it default to `process.cwd()`. The
 * assertion itself is covered separately below.
 */
const build = (ctx: BuildCompleteContext) =>
  buildAdapterManifest(ctx, { buildCwd: ctx.projectDir });
const write = (ctx: BuildCompleteContext) =>
  writeBuildOutputs(ctx, { buildCwd: ctx.projectDir });

beforeEach(() => {
  // `maxDuration` warnings are expected from the pages-i18n fixture.
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe.each(Object.keys(fixtures) as Array<keyof typeof fixtures>)(
  "buildAdapterManifest(%s)",
  (name) => {
    const ctx = asContext(fixtures[name]);
    const { manifest, staging } = build(ctx);

    it("stamps the manifest version and build identity", () => {
      expect(manifest.version).toBe(1);
      expect(manifest.buildId).toBe(ctx.buildId);
      expect(manifest.relativeProjectDir).toBe(
        name.startsWith("pages-i18n") ? "pages-i18n" : "app-playground",
      );
    });

    it("copies the config fields the runtime router needs", () => {
      expect(manifest.config).toEqual({
        basePath: ctx.config.basePath ?? "",
        trailingSlash: ctx.config.trailingSlash === true,
        assetPrefix: ctx.config.assetPrefix ?? "",
        distDir: ".next",
        compress: true,
        i18n: ctx.config.i18n ?? null,
      });
    });

    it("persists ctx.routing verbatim", () => {
      // `@next/routing`'s `resolveRoutes` consumes this whole object; anything we
      // reshape here is a behavior difference from `next start`.
      expect(manifest.routing).toEqual(ctx.routing);
      expect(manifest.routing).toHaveProperty("middlewareMatchers");
    });

    it("maps every invocable output pathname to an entrypoint", () => {
      const expected = [
        ...ctx.outputs.pages,
        ...ctx.outputs.pagesApi,
        ...ctx.outputs.appPages,
        ...ctx.outputs.appRoutes,
      ].map((o) => o.pathname);
      // Plus dynamic prerender templates, which `addPrerenderTemplates` maps to
      // the entrypoint of the route that owns them.
      const templates = ctx.outputs.prerenders
        .filter((o) => o.pathname.includes("["))
        .map((o) => o.pathname);
      expect(Object.keys(manifest.entrypoints).sort()).toEqual(
        [...new Set([...expected, ...templates])].sort(),
      );
      for (const [pathname, entry] of Object.entries(manifest.entrypoints)) {
        expect(entry.filePath).toMatch(/^[^/]/);
        expect(entry.filePath).not.toContain("\\");
        expect(staging.has(entry.filePath)).toBe(true);
        expect(entry.id).toBeTruthy();
        expect(["app-page", "app-route", "page", "page-api"]).toContain(
          entry.type,
        );
        expect(pathname).toBeTruthy();
      }
    });

    it("lists pathnames as the sorted union of entrypoints and static files", () => {
      expect(manifest.pathnames).toEqual([...manifest.pathnames].sort());
      expect(new Set(manifest.pathnames).size).toBe(manifest.pathnames.length);
      for (const key of Object.keys(manifest.entrypoints)) {
        expect(manifest.pathnames).toContain(key);
      }
      for (const file of ctx.outputs.staticFiles) {
        expect(manifest.pathnames).toContain(file.pathname);
      }
      expect(Object.keys(manifest.staticFiles)).toEqual(
        [...new Set(ctx.outputs.staticFiles.map((f) => f.pathname))].sort(),
      );
    });

    it("maps each static file to a repo-root-relative key", () => {
      for (const [pathname, key] of Object.entries(manifest.staticFiles)) {
        const output = ctx.outputs.staticFiles.find(
          (f) => f.pathname === pathname,
        )!;
        expect(key).toBe(output.filePath.replace("/repo/", ""));
        expect(key.startsWith("/")).toBe(false);
      }
    });

    it("stages the static files nothing in front of the compute serves", () => {
      // `<distDir>/static` goes to S3; `<distDir>/server/**` (404.html,
      // favicon.ico.body, fully-static Pages Router HTML) does not, so the
      // runtime must be able to read it off disk.
      for (const [pathname, key] of Object.entries(manifest.staticFiles)) {
        const servedByS3 = pathname.includes("/_next/static/");
        expect(staging.has(key)).toBe(!servedByS3);
      }
    });

    it("stages only keys that land inside the deployment root", () => {
      expect(staging.size).toBeGreaterThan(0);
      for (const key of staging.keys()) {
        expect(key).not.toBe("");
        expect(key.startsWith("/")).toBe(false);
        expect(key.startsWith("..")).toBe(false);
        expect(key.startsWith(`${RUNTIME_DIR_NAME}/`)).toBe(false);
      }
      // The traced `next` closure is merged into every output, so staging is far
      // smaller than the sum of the per-output `assets` maps.
      expect(staging.size).toBeLessThan(
        ctx.outputs.appPages.length * 100 +
          ctx.outputs.pages.length * 100 +
          1000,
      );
    });
  },
);

describe("buildAdapterManifest edge cases", () => {
  it("throws when `next build` ran from outside the project directory", () => {
    const ctx = asContext(appPlayground);
    expect(() => buildAdapterManifest(ctx, { buildCwd: "/repo" })).toThrow(
      /must run from the Next.js project directory/,
    );
  });

  it("defaults the build cwd to process.cwd()", () => {
    // Which is this package's root, never a fixture's `/repo/…` project dir, so
    // the assertion fires — proving the default is wired and not just the option.
    expect(() => buildAdapterManifest(asContext(appPlayground))).toThrow(
      /must run from the Next.js project directory/,
    );
  });

  it("keys locale variants of one page to the same entrypoint file", () => {
    const { manifest } = build(asContext(pagesI18n));
    // i18n fans one page out into one output per locale, plus a
    // `/_next/data/<buildId>/…json` sibling each. They share `filePath` and
    // `type`; `id` stays per-pathname (locale-prefixed), so it is not a dedup key.
    const ssr = [
      "/ssr",
      "/en-US/ssr",
      "/fr/ssr",
      "/nl-NL/ssr",
      `/_next/data/${manifest.buildId}/fr/ssr.json`,
    ];
    for (const pathname of ssr) {
      expect(manifest.entrypoints[pathname]).toMatchObject({
        filePath: manifest.entrypoints["/ssr"].filePath,
        type: "page",
      });
      expect(manifest.entrypoints[pathname].id).toBe(pathname);
    }
    expect(manifest.entrypoints["/ssr"].type).toBe("page");
    expect(manifest.entrypoints["/api/hello"].type).toBe("page-api");
  });

  it("carries basePath in pathnames but not in entrypoint ids", () => {
    // `output.pathname` is basePath-prefixed while `output.id` is not. Dispatch
    // keys off the pathname, so the prefix has to stay.
    const { manifest } = build(asContext(appPlaygroundBasePath));
    expect(manifest.config.basePath).toBe("/prod");
    expect(manifest.entrypoints["/prod/api/health"]).toBeDefined();
    expect(manifest.entrypoints["/prod/api/health"].id).toBe("/api/health");
    expect(manifest.entrypoints["/api/health"]).toBeUndefined();
  });

  it("records middleware without duplicating its matchers", () => {
    const { manifest, staging } = build(asContext(appPlayground));
    expect(manifest.middleware).not.toBeNull();
    expect(manifest.middleware!.filePath).toMatch(/^[^/]/);
    expect(staging.has(manifest.middleware!.filePath)).toBe(true);
    expect(manifest.middleware).not.toHaveProperty("matchers");

    const { manifest: noMiddleware } = build(asContext(pagesI18n));
    expect(noMiddleware.middleware).toBeNull();
  });

  it("maps a Pages Router data-route template to its owning route", () => {
    // `/_next/data/<buildId>/<locale>/blog/[slug].json` exists only as a
    // prerender. Without it, the ISR data URLs `next start` serves would 404.
    const { manifest } = build(asContext(pagesI18n));
    const dataTemplate = `/_next/data/${manifest.buildId}/fr/blog/[slug].json`;
    expect(manifest.entrypoints[dataTemplate]).toEqual({
      id: dataTemplate,
      filePath: manifest.entrypoints["/fr/blog/[slug]"].filePath,
      type: "page",
    });
    expect(manifest.pathnames).toContain(dataTemplate);
  });

  it("leaves an App Router fallback template on its own entrypoint", () => {
    // `/isr/[id]` is a prerender *and* an appPages output. The output wins, so
    // `id` stays the route's own rather than being rewritten.
    const { manifest } = build(asContext(appPlayground));
    expect(manifest.entrypoints["/isr/[id]"].id).toBe("/isr/[id]");
    expect(manifest.entrypoints["/isr/[id].rsc"]).toBeDefined();
  });

  it("warns instead of throwing when a template has no owning route", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = asContext(pagesI18n);
    ctx.outputs.prerenders[0].route = "/gone/[slug]";
    ctx.outputs.prerenders[0].pathname = "/gone/[slug]";
    const { manifest } = build(ctx);
    expect(manifest.entrypoints["/gone/[slug]"]).toBeUndefined();
    expect(
      warn.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes("will 404")),
    ).toEqual([
      expect.stringContaining('/gone/[slug] (route: "/gone/[slug]")'),
    ]);
  });

  it("warns once per unsupported route config key", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    build(asContext(pagesI18n));
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.filter((m) => m.includes("`maxDuration`"))).toHaveLength(1);
    expect(messages[0]).toContain("ssr");
    expect(messages[0]).toContain("overrides");
    expect(messages.some((m) => m.includes("`preferredRegion`"))).toBe(false);
  });

  it("throws on an edge-runtime output", () => {
    const ctx = asContext(appPlayground);
    ctx.outputs.appRoutes[0].runtime = "edge";
    expect(() => build(ctx)).toThrow(
      /cannot deploy routes built for the edge runtime/,
    );
    expect(() => build(ctx)).toThrow(ctx.outputs.appRoutes[0].sourcePage);
  });

  it("throws when two outputs map one key to different content", () => {
    const ctx = asContext(appPlayground);
    const [first, second] = ctx.outputs.appPages;
    const key = Object.keys(first.assets)[0];
    first.assetsHashes[key] = "hash-a";
    second.assets[key] = first.assets[key];
    second.assetsHashes[key] = "hash-b";
    expect(() => build(ctx)).toThrow(/map "[^"]+" to different content/);
  });

  it("throws on an asset key outside the deployment root", () => {
    const ctx = asContext(appPlayground);
    ctx.outputs.appPages[0].assets["../escape.js"] = "/elsewhere/escape.js";
    expect(() => build(ctx)).toThrow(/outside the deployment root/);
  });

  it("throws on an asset key shadowing the reserved runtime directory", () => {
    const ctx = asContext(appPlayground);
    ctx.outputs.appPages[0].assets[`${RUNTIME_DIR_NAME}/lambda.mjs`] =
      "/repo/whatever.mjs";
    expect(() => build(ctx)).toThrow(
      new RegExp(`"${RUNTIME_DIR_NAME}/" is reserved`),
    );
  });

  it("throws when two outputs claim one pathname from different files", () => {
    const ctx = asContext(appPlayground);
    ctx.outputs.appRoutes[0].pathname = ctx.outputs.appPages[0].pathname;
    expect(() => build(ctx)).toThrow(/claim the pathname "[^"]+"/);
  });
});

describe("writeBuildOutputs", () => {
  /**
   * Builds a throwaway repo on disk so staging can be exercised for real:
   * fixture sources are `/repo` placeholders and cannot be copied.
   */
  async function makeRepo() {
    const repoRoot = await mkdtemp(join(tmpdir(), "cdk-nextjs-staging-"));
    const projectDir = join(repoRoot, "app");
    const distDir = join(projectDir, ".next");
    const entry = join(distDir, "server", "app", "page.js");
    const dep = join(projectDir, "node_modules", "dep");
    const store = join(repoRoot, "store", "pkg");

    await mkdir(join(distDir, "server", "app"), { recursive: true });
    await mkdir(dep, { recursive: true });
    await mkdir(store, { recursive: true });
    await writeFile(entry, "module.exports = {};\n");
    await writeFile(join(dep, "index.js"), "// dep\n");
    await writeFile(join(store, "index.js"), "// store\n");
    await writeFile(join(projectDir, ".env"), "SHARED=1\n");
    await writeFile(join(projectDir, ".env.production"), "PROD=1\n");
    // A relative link whose target is itself staged: pnpm's common shape.
    await symlink("dep", join(projectDir, "node_modules", "rel-link"));
    // An absolute link out of the tree: staging must materialize it instead.
    await symlink(store, join(projectDir, "node_modules", "abs-link"));

    const output = {
      id: "/",
      pathname: "/",
      sourcePage: "/page",
      filePath: entry,
      runtime: "nodejs",
      config: {},
      assets: {
        "app/node_modules/dep/index.js": join(dep, "index.js"),
        "app/node_modules/rel-link": join(
          projectDir,
          "node_modules",
          "rel-link",
        ),
        "app/node_modules/abs-link": join(
          projectDir,
          "node_modules",
          "abs-link",
        ),
      },
      assetsHashes: {},
    };

    const ctx = {
      repoRoot,
      projectDir,
      distDir,
      buildId: "test-build",
      nextVersion: "16.3.5",
      config: {
        basePath: "",
        trailingSlash: false,
        assetPrefix: "",
        i18n: null,
      },
      routing: { dynamicRoutes: [] },
      outputs: {
        pages: [],
        pagesApi: [],
        appPages: [output],
        appRoutes: [],
        prerenders: [],
        staticFiles: [],
        middleware: undefined,
      },
    } as unknown as BuildCompleteContext;

    return { ctx, repoRoot };
  }

  it("stages the tree, preserves symlinks, and writes the manifest", async () => {
    const { ctx } = await makeRepo();
    const result = await write(ctx);

    expect(result.stagingDir).toBe(
      join(ctx.distDir, "cdk-nextjs-adapter", "app"),
    );
    expect(result.stagedBytes).toBeGreaterThan(0);

    const staged = (...parts: string[]) => join(result.stagingDir, ...parts);
    await expect(
      readFile(staged("app", ".next", "server", "app", "page.js"), "utf8"),
    ).resolves.toContain("module.exports");
    await expect(
      readFile(staged("app", "node_modules", "dep", "index.js"), "utf8"),
    ).resolves.toContain("dep");

    // `copyFile` fails outright on a directory symlink, and dereferencing the
    // pnpm store triples the tree against the 250 MB unzipped Lambda limit.
    await expect(
      lstat(staged("app", "node_modules", "rel-link")).then((s) =>
        s.isSymbolicLink(),
      ),
    ).resolves.toBe(true);
    // Points outside the deployment root, so it would dangle in Lambda.
    await expect(
      lstat(staged("app", "node_modules", "abs-link")).then((s) =>
        s.isSymbolicLink(),
      ),
    ).resolves.toBe(false);
    await expect(
      readFile(staged("app", "node_modules", "abs-link", "index.js"), "utf8"),
    ).resolves.toContain("store");

    // `writeStandaloneDirectory` copies these; `onBuildComplete` has no
    // equivalent, so dropping `output: "standalone"` drops them silently.
    await expect(readFile(staged("app", ".env"), "utf8")).resolves.toContain(
      "SHARED=1",
    );
    await expect(
      readFile(staged("app", ".env.production"), "utf8"),
    ).resolves.toContain("PROD=1");

    const written = JSON.parse(await readFile(result.manifestPath, "utf8"));
    expect(written).toEqual(JSON.parse(JSON.stringify(result.manifest)));
    expect(written.relativeProjectDir).toBe("app");
  });

  it("removes a previous build's tree before staging", async () => {
    const { ctx } = await makeRepo();
    const first = await write(ctx);
    const stale = join(first.stagingDir, "app", "stale.js");
    await writeFile(stale, "// removed route\n");

    await write(ctx);
    await expect(lstat(stale)).rejects.toThrow(/ENOENT/);
  });
});

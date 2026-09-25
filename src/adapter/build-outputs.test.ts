import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

/**
 * The one deployment root an unsplit build stages. Asserted rather than indexed
 * so a regression that starts splitting unasked fails here instead of silently
 * checking group 0.
 */
const soleRoot = (result: { stagedGroups: Array<{ path: string }> }) => {
  expect(result.stagedGroups).toHaveLength(1);
  return result.stagedGroups[0].path;
};

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
        generateEtags: true,
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
      // Plus dynamic prerender templates, which `addPrerenderPathnames` maps to
      // the entrypoint of the route that owns them. None of these fixtures has a
      // gated dynamic route, so no *concrete* prerender pathname is added - see
      // the root-params test below.
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
      // One reported pathname can produce two keys - a `/index` static file is
      // also served at `/`, see the static-home-page tests below. None of these
      // fixtures has one, so here the two sets coincide.
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

  /**
   * A Pages Router home page reaches us as `/index`, whichever population it lands
   * in: `normalizePagePath("/")` is `"/index"`, and the adapter hook uses it for a
   * fully-static page's `STATIC_FILE` and for an SSG/SSR page's `PAGES` output
   * alike. Nothing else in the outputs carries `/`, so the mapping under test is
   * the only thing that makes the home page routable.
   */
  function withHomePage(
    basePath: string,
    kind: "static" | "invocable",
  ): ReturnType<typeof build> {
    const ctx = asContext(pagesI18n);
    ctx.config.i18n = null;
    ctx.config.basePath = basePath;
    ctx.outputs.staticFiles = [];
    ctx.outputs.prerenders = [];
    const page = ctx.outputs.pages.find((o) => o.pathname === "/ssr")!;
    ctx.outputs.pages =
      kind === "invocable"
        ? [{ ...page, id: "/index", pathname: `${basePath}/index` }]
        : [];
    if (kind === "static") {
      ctx.outputs.staticFiles = [
        {
          id: "/",
          pathname: `${basePath}/index`,
          type: "STATIC_FILE",
          filePath: "/repo/pages-i18n/.next/server/pages/index.html",
        },
      ] as typeof ctx.outputs.staticFiles;
    }
    return build(ctx);
  }

  it("routes a fully-static Pages Router home page at `/`, not `/index`", () => {
    const { manifest } = withHomePage("", "static");
    const html = "pages-i18n/.next/server/pages/index.html";

    expect(manifest.staticFiles["/"]).toBe(html);
    expect(manifest.pathnames).toContain("/");
    // Kept as well as `/`: next's minimal mode rewrites `/index` to `/` before
    // matching, so it answers there too.
    expect(manifest.staticFiles["/index"]).toBe(html);
  });

  it("routes an SSG or SSR home page's entrypoint at `/` as well", () => {
    const { manifest } = withHomePage("", "invocable");
    expect(manifest.entrypoints["/"]).toEqual(manifest.entrypoints["/index"]);
    expect(manifest.pathnames).toContain("/");
    // The output's own `id` is what next reported, and only names the entrypoint
    // in diagnostics and group ownership - it is not a key into anything.
    expect(manifest.entrypoints["/"].id).toBe("/index");
  });

  it("routes that home page under basePath at the basePath itself", () => {
    // `/prod`, not `/prod/` — which is how the App Router fixture reports its own
    // home page.
    const { manifest } = withHomePage("/prod", "static");
    expect(Object.keys(manifest.staticFiles)).toEqual(["/prod", "/prod/index"]);
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

  it("registers a static getStaticProps page's data route, which no rule reaches", () => {
    // `test/e2e/no-page-props`: `/_next/data/<buildId>/gsp.json` 404'd while
    // `next start` serves it 200, so every client-side navigation into the page
    // fell back to a full page load. `next build` emits a `dynamicRoutes` rule for
    // a data route only when the page is dynamic or the app has middleware, so
    // without middleware a *static* page's data route arrives as a concrete
    // prerender pathname with nothing to match it. Reproduced on `pages-i18n`,
    // whose captured prerenders are all dynamic, by renaming one.
    const ctx = asContext(pagesI18n);
    const dataRoute = `/_next/data/${ctx.buildId}/en-US/gsp.json`;
    const concrete = ctx.outputs.prerenders.find((it) =>
      it.pathname.endsWith("hello.json"),
    )!;
    concrete.pathname = dataRoute;
    concrete.id = dataRoute;
    const { manifest } = build(ctx);
    expect(manifest.entrypoints[dataRoute]).toEqual({
      id: dataRoute,
      filePath: manifest.entrypoints["/en-US/blog/[slug]"].filePath,
      type: "page",
    });

    // And the dynamic page's own concrete data pathname stays out: the ungated
    // `…/blog/[slug].json` rule already reaches it, and that rule is where the
    // `nxtPslug` param comes from — resolving the request to itself would drop it.
    const { manifest: captured } = build(asContext(pagesI18n));
    expect(
      captured.entrypoints[
        `/_next/data/${captured.buildId}/en-US/blog/hello.json`
      ],
    ).toBeUndefined();
  });

  it("leaves an App Router fallback template on its own entrypoint", () => {
    // `/isr/[id]` is a prerender *and* an appPages output. The output wins, so
    // `id` stays the route's own rather than being rewritten.
    const { manifest } = build(asContext(appPlayground));
    expect(manifest.entrypoints["/isr/[id]"].id).toBe("/isr/[id]");
    expect(manifest.entrypoints["/isr/[id].rsc"]).toBeDefined();
  });

  it("adds a concrete prerender pathname when only a gated rule matches it", () => {
    // What a root-params app produces: `app/[locale]/page.tsx` with
    // `generateStaticParams()` and no `app/layout.tsx`. The params can never be
    // filled at request time, so `next build` emits the `dynamicRoutes` rule with a
    // draft-mode `has` and expects the platform to serve `/en` from the prerender.
    // Measured against `test/e2e/app-dir/parallel-routes-root-param-dynamic-child`,
    // where every URL of the app 404'd. Reproduced here by gating
    // `app-playground`'s `/isr/[id]` rules, which no committed capture does.
    const ctx = asContext(appPlayground);
    for (const route of ctx.routing.dynamicRoutes) {
      if (route.sourceRegex.includes("isr")) {
        route.has = [
          { type: "cookie", key: "__prerender_bypass", value: "secret" },
        ];
      }
    }
    const { manifest } = build(ctx);
    expect(manifest.entrypoints["/isr/1"]).toEqual({
      id: "/isr/1",
      filePath: manifest.entrypoints["/isr/[id]"].filePath,
      type: "app-page",
    });
    // The RSC and segment-prefetch variants too: they are the URLs a client-side
    // navigation asks for, so without them the app renders and never hydrates.
    expect(manifest.entrypoints["/isr/1.rsc"]).toBeDefined();
    expect(
      manifest.entrypoints["/isr/1.segments/isr/$d$id/__PAGE__.segment.rsc"],
    ).toBeDefined();
    // Unmutated, the same pathnames stay out: the ungated rule already reaches
    // `/isr/[id]`, which is where the `nxtPid` param comes from.
    const { manifest: ungated } = build(asContext(appPlayground));
    expect(ungated.entrypoints["/isr/1"]).toBeUndefined();
    expect(ungated.entrypoints["/isr/1.rsc"]).toBeUndefined();
    // And a pathname no rule matches at all stays out either way: `resolveRoutes`
    // never resolves a static route's segment outputs, so listing them is weight.
    expect(
      manifest.entrypoints["/index.segments/_tree.segment.rsc"],
    ).toBeUndefined();
  });

  it("leaves public/ out of the manifest and the staging plan", async () => {
    // The container runtime lists `public/` off disk at cold start
    // (`readPublicFiles`), because only the disk has what a `postbuild` wrote
    // into it after this hook ran; and the Lambda types never serve it.
    const repoRoot = await mkdtemp(join(tmpdir(), "cdk-nextjs-public-"));
    // Every path in the fixture, rebased from `/repo` onto a real directory.
    const ctx = asContext(
      JSON.parse(
        JSON.stringify(appPlaygroundBasePath).replaceAll(
          '"/repo',
          `"${repoRoot}`,
        ),
      ),
    );
    await mkdir(join(ctx.projectDir, "public"), { recursive: true });
    await writeFile(join(ctx.projectDir, "public", "test.txt"), "hello");

    const { manifest, staging } = build(ctx);
    expect(
      Object.values(manifest.staticFiles).filter((key) =>
        key.includes("/public/"),
      ),
    ).toEqual([]);
    expect(manifest.pathnames).not.toContain("/prod/test.txt");
    expect(
      [...staging.keys()].filter((key) => key.includes("/public/")),
    ).toEqual([]);
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

  it("blames middleware, not `/`, for edge-runtime middleware", () => {
    const ctx = asContext(appPlayground);
    const middleware = ctx.outputs.middleware;
    if (!middleware) {
      throw new Error("fixture has no middleware output");
    }
    // What a legacy `middleware.ts` builds to. Its `sourcePage` is `/`, so the
    // regression guarded here is the message telling an author to edit the home
    // page.
    middleware.runtime = "edge";

    expect(() => build(ctx)).toThrow(
      /cannot deploy middleware built for the edge runtime/,
    );
    expect(() => build(ctx)).toThrow(middleware.filePath);
    expect(() => build(ctx)).not.toThrow(
      /cannot deploy routes built for the edge runtime/,
    );
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
  /**
   * A `next` install just real enough for {@link addRuntimeNextClosure}: the
   * modules `src/runtime/image.ts` requires, one file only the trace reaches, and
   * a stand-in for next's vendored `@vercel/nft` that reports them. Tracing for
   * real is next's job, not ours; what is under test is that the closure is
   * resolved from the project dir and staged under repo-root-relative keys.
   */
  async function installFakeNext(repoRoot: string) {
    const nextRoot = join(repoRoot, "node_modules", "next");
    const files = [
      "dist/server/config-shared.js",
      "dist/shared/lib/image-config.js",
      "dist/server/image-optimizer.js",
      "dist/server/serve-static.js",
      // Reached only through the trace, i.e. the reason tracing is needed.
      "dist/shared/lib/match-remote-pattern.js",
    ];
    for (const file of files) {
      const path = join(nextRoot, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `// ${file}\n`);
    }
    // No `exports` field: `next/dist/**` is required by path.
    await writeFile(
      join(nextRoot, "package.json"),
      JSON.stringify({ name: "next", version: "0.0.0-test" }),
    );

    const tracer = join(nextRoot, "dist", "compiled", "@vercel", "nft");
    await mkdir(tracer, { recursive: true });
    await writeFile(
      join(tracer, "package.json"),
      JSON.stringify({ name: "@vercel/nft", main: "index.js" }),
    );
    await writeFile(
      join(tracer, "index.js"),
      `const files = ${JSON.stringify(files)};\n` +
        // Real nft returns paths relative to `base`; these are already relative
        // to the repo root, which is the `base` the adapter passes.
        "exports.nodeFileTrace = async () => ({\n" +
        "  fileList: new Set(files.map((f) => `node_modules/next/${f}`)),\n" +
        "});\n",
    );
  }

  async function makeRepo(options: { withNext?: boolean } = {}) {
    const repoRoot = await mkdtemp(join(tmpdir(), "cdk-nextjs-staging-"));
    if (options.withNext) {
      await installFakeNext(repoRoot);
    }
    const projectDir = join(repoRoot, "app");
    const distDir = join(projectDir, ".next");
    const entry = join(distDir, "server", "app", "page.js");
    const dep = join(projectDir, "node_modules", "dep");
    const store = join(repoRoot, "store", "pkg");
    // pnpm's virtual store: one package reachable only from inside it, and one
    // that also has a logical path (`app/node_modules/dep`).
    const virtualStore = join(repoRoot, "node_modules", ".pnpm");
    const hidden = join(
      virtualStore,
      "helpers@1.0.0",
      "node_modules",
      "@scope",
      "helpers",
    );
    const depInStore = join(virtualStore, "dep@1.0.0", "node_modules", "dep");
    // A second version of the same package that the trace only read the
    // `package.json` of. It sorts first, so hoisting by staging key would pick
    // this one and leave the hoisted copy without any code in it.
    const staleVersion = join(
      virtualStore,
      "helpers@0.1.0",
      "node_modules",
      "@scope",
      "helpers",
    );
    // The shape that makes a store package reachable from another store
    // package: a link between two store directories, no files of its own.
    const hiddenLink = join(
      virtualStore,
      "dep@1.0.0",
      "node_modules",
      "@scope",
      "helpers",
    );

    await mkdir(join(distDir, "server", "app"), { recursive: true });
    // Every deployment root needs this, and `loadRuntime` refuses to serve
    // without it, so the staging plan carries it independently of any output's
    // traced assets.
    await writeFile(join(distDir, "required-server-files.json"), "{}\n");
    await mkdir(dep, { recursive: true });
    await mkdir(store, { recursive: true });
    await mkdir(hidden, { recursive: true });
    await mkdir(depInStore, { recursive: true });
    await mkdir(staleVersion, { recursive: true });
    await writeFile(entry, "module.exports = {};\n");
    await writeFile(
      join(staleVersion, "package.json"),
      JSON.stringify({ name: "@scope/helpers", version: "0.1.0" }),
    );
    await writeFile(join(dep, "index.js"), "// dep\n");
    await writeFile(join(store, "index.js"), "// store\n");
    await writeFile(join(hidden, "index.js"), "// helpers\n");
    await writeFile(join(depInStore, "index.js"), "// dep\n");
    await mkdir(dirname(hiddenLink), { recursive: true });
    await symlink(
      join(
        "..",
        "..",
        "..",
        "helpers@1.0.0",
        "node_modules",
        "@scope",
        "helpers",
      ),
      hiddenLink,
    );
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
        "node_modules/.pnpm/helpers@1.0.0/node_modules/@scope/helpers/index.js":
          join(hidden, "index.js"),
        "node_modules/.pnpm/helpers@0.1.0/node_modules/@scope/helpers/package.json":
          join(staleVersion, "package.json"),
        "node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js": join(
          depInStore,
          "index.js",
        ),
        "node_modules/.pnpm/dep@1.0.0/node_modules/@scope/helpers": hiddenLink,
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

    expect(soleRoot(result)).toBe(
      join(ctx.distDir, "cdk-nextjs-adapter", "app"),
    );
    expect(result.stagedBytes).toBeGreaterThan(0);

    const staged = (...parts: string[]) => join(soleRoot(result), ...parts);
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

  it("hoists store-only packages to the deployment root", async () => {
    const { ctx } = await makeRepo();
    const result = await write(ctx);
    const staged = (...parts: string[]) => join(soleRoot(result), ...parts);

    // Nothing resolves `@scope/helpers` once the symlinks are dereferenced
    // (which is what zipping the asset does), so it needs a copy Node finds by
    // walking up to the deployment root.
    await expect(
      readFile(staged("node_modules", "@scope", "helpers", "index.js"), "utf8"),
    ).resolves.toContain("helpers");
    // A link between two store directories sorts before the directory holding
    // the files, and copying it would only produce another dangling link.
    await expect(
      lstat(staged("node_modules", "@scope", "helpers")).then((s) =>
        s.isSymbolicLink(),
      ),
    ).resolves.toBe(false);
    // And the version staged for its `package.json` alone must not win either:
    // `sharp` loaded against a code-less `semver` fails, and next reports that
    // as "Module `sharp` not found" while quietly serving unoptimized images.
    await expect(
      readFile(staged("node_modules", "@scope", "helpers", "package.json"), {
        encoding: "utf8",
      }).catch(() => "{}"),
    ).resolves.not.toContain("0.1.0");
    // `dep` already has a logical path, so hoisting it would only add bytes.
    await expect(lstat(staged("node_modules", "dep"))).rejects.toThrow(
      /ENOENT/,
    );
    // The store copies stay where they were staged.
    await expect(
      readFile(
        staged(
          "node_modules",
          ".pnpm",
          "helpers@1.0.0",
          "node_modules",
          "@scope",
          "helpers",
          "index.js",
        ),
        "utf8",
      ),
    ).resolves.toContain("helpers");
  });

  it("stages the next closure the runtime's image optimizer requires", async () => {
    // `next build` traces what the *app* reaches, and no app reaches next's
    // image optimizer, so without this every /_next/image request 500s on a
    // MODULE_NOT_FOUND that nothing in the build warned about.
    const { ctx } = await makeRepo({ withNext: true });
    const result = await write(ctx);
    const staged = (...parts: string[]) => join(soleRoot(result), ...parts);

    await expect(
      readFile(
        staged("node_modules", "next", "dist", "server", "image-optimizer.js"),
        "utf8",
      ),
    ).resolves.toContain("image-optimizer");
    await expect(
      readFile(
        staged(
          "node_modules",
          "next",
          "dist",
          "shared",
          "lib",
          "match-remote-pattern.js",
        ),
        "utf8",
      ),
    ).resolves.toContain("match-remote-pattern");
  });

  it("warns instead of failing when next cannot be resolved for tracing", async () => {
    const { ctx } = await makeRepo();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await expect(write(ctx)).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("/_next/image will fail at runtime"),
    );
  });

  it("removes a previous build's tree before staging", async () => {
    const { ctx } = await makeRepo();
    const first = await write(ctx);
    const stale = join(soleRoot(first), "app", "stale.js");
    await writeFile(stale, "// removed route\n");

    await write(ctx);
    await expect(lstat(stale)).rejects.toThrow(/ENOENT/);
  });

  describe("with functionGroups", () => {
    /**
     * Two routes with one asset each, so "the group's tree holds its own route
     * and not the other's" is checkable by file. Deliberately not `makeRepo`'s
     * repo: its single output cannot be split.
     */
    async function makeSplittableRepo() {
      const repoRoot = await mkdtemp(join(tmpdir(), "cdk-nextjs-groups-"));
      const projectDir = join(repoRoot, "app");
      const distDir = join(projectDir, ".next");
      await mkdir(join(distDir, "server", "app"), { recursive: true });
      await writeFile(join(distDir, "required-server-files.json"), "{}\n");

      const outputFor = async (name: string, pathname: string) => {
        const entry = join(distDir, "server", "app", `${name}.js`);
        const asset = join(projectDir, "node_modules", name, "index.js");
        await mkdir(dirname(asset), { recursive: true });
        await writeFile(entry, `// ${name}\n`);
        await writeFile(asset, `// ${name} dep\n`);
        return {
          id: pathname,
          pathname,
          sourcePage: pathname,
          filePath: entry,
          runtime: "nodejs",
          config: {},
          assets: { [`app/node_modules/${name}/index.js`]: asset },
          assetsHashes: {},
        };
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
          appPages: [await outputFor("home", "/")],
          appRoutes: [await outputFor("reports", "/api/reports/[id]")],
          prerenders: [],
          staticFiles: [],
          middleware: undefined,
        },
      } as unknown as BuildCompleteContext;
      return { ctx };
    }

    const groups = [{ name: "reports", routes: ["/api/reports/**"] }];

    it("records the assignment in the manifest every group shares", async () => {
      const { ctx } = await makeSplittableRepo();
      const { manifest } = buildAdapterManifest(ctx, {
        buildCwd: ctx.projectDir,
        functionGroups: groups,
      });
      expect(manifest.groups).toEqual({
        default: ["/"],
        reports: ["/api/reports/[id]"],
      });
    });

    it("stages one tree per group, each holding only its own routes", async () => {
      const { ctx } = await makeSplittableRepo();
      const result = await writeBuildOutputs(ctx, {
        buildCwd: ctx.projectDir,
        functionGroups: groups,
      });

      expect(result.stagedGroups.map((group) => group.name).sort()).toEqual([
        "default",
        "reports",
      ]);
      const pathOf = (name: string) => {
        const group = result.stagedGroups.find((it) => it.name === name);
        if (!group) {
          throw new Error(`No staged group "${name}"`);
        }
        return group.path;
      };
      // Under `groups/<name>/`, so neither can collide with the unsplit layout.
      expect(pathOf("reports")).toBe(
        join(ctx.distDir, "cdk-nextjs-adapter", "groups", "reports"),
      );
      expect(pathOf("default")).toBe(
        join(ctx.distDir, "cdk-nextjs-adapter", "groups", "default"),
      );

      const has = (name: string, ...parts: string[]) =>
        lstat(join(pathOf(name), ...parts)).then(
          () => true,
          () => false,
        );
      await expect(
        has("reports", "app", ".next", "server", "app", "reports.js"),
      ).resolves.toBe(true);
      await expect(
        has("reports", "app", "node_modules", "reports", "index.js"),
      ).resolves.toBe(true);
      // The point of splitting: the other group's route is absent.
      await expect(
        has("reports", "app", ".next", "server", "app", "home.js"),
      ).resolves.toBe(false);
      await expect(
        has("default", "app", ".next", "server", "app", "home.js"),
      ).resolves.toBe(true);
      await expect(
        has("default", "app", ".next", "server", "app", "reports.js"),
      ).resolves.toBe(false);
      // The manifest is written once, above the groups; `NextjsBuild` copies it
      // and the runtime shell into each group's reserved runtime dir afterwards,
      // so no group's staged tree may contain that directory yet.
      expect(result.manifestPath).toBe(
        join(ctx.distDir, "cdk-nextjs-adapter", "manifest.json"),
      );
      for (const name of ["default", "reports"]) {
        await expect(has(name, RUNTIME_DIR_NAME)).resolves.toBe(false);
      }
      // `required-server-files.json` is not any output's traced asset, so a
      // group that reaches it only through the outputs it owns does not get it -
      // and `loadRuntime` probes for it before serving anything, so the whole
      // root answers "the deployment package is incomplete" without it.
      for (const name of ["default", "reports"]) {
        await expect(
          has(name, "app", ".next", "required-server-files.json"),
        ).resolves.toBe(true);
      }
    });

    it("refuses to split an i18n app, whose routes are locale-prefixed", async () => {
      const { ctx } = await makeSplittableRepo();
      const i18nCtx = {
        ...ctx,
        config: {
          ...ctx.config,
          i18n: { locales: ["en"], defaultLocale: "en" },
        },
      } as unknown as BuildCompleteContext;
      expect(() =>
        buildAdapterManifest(i18nCtx, {
          buildCwd: ctx.projectDir,
          functionGroups: groups,
        }),
      ).toThrow(/cannot be combined with `i18n`/);
    });

    it("throws on a pattern that matches nothing, rather than silently not splitting", async () => {
      const { ctx } = await makeSplittableRepo();
      expect(() =>
        buildAdapterManifest(ctx, {
          buildCwd: ctx.projectDir,
          functionGroups: [{ name: "typo", routes: ["/api/report/**"] }],
        }),
      ).toThrow(/matches no route in this build/);
    });
  });
});

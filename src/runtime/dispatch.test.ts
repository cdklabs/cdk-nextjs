/* eslint-disable import/no-extraneous-dependencies */
import { MiddlewareResult } from "@next/routing";
import {
  createDispatcher,
  DispatchRequest,
  Dispatcher,
  outOfBandRouteParams,
  repairRouteParamQuery,
  resolveErrorTarget,
  toRedirect,
} from "./dispatch";
import { AdapterManifest } from "./manifest";
import appPlaygroundBasePath from "../adapter/__fixtures__/app-playground-base-path.json";
import appPlayground from "../adapter/__fixtures__/app-playground.json";
import pagesI18n from "../adapter/__fixtures__/pages-i18n.json";
import {
  BuildCompleteContext,
  buildAdapterManifest,
} from "../adapter/build-outputs";

/**
 * Dispatch is tested against the manifests that step 1 produces from real
 * `onBuildComplete` captures, rather than against hand-written manifests: the
 * thing most likely to break is the correspondence between how the build keys
 * `entrypoints` and how `resolveRoutes` reports `resolvedPathname`, and a
 * hand-written manifest would assume that correspondence instead of proving it.
 */
function manifestOf(fixture: unknown): AdapterManifest {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const ctx = structuredClone(fixture) as BuildCompleteContext;
    // The fixtures' project dirs are synthetic `/repo/…` paths, so the build cwd
    // has to be stated; see `assertBuildCwd`.
    return buildAdapterManifest(ctx, { buildCwd: ctx.projectDir }).manifest;
  } finally {
    warn.mockRestore();
  }
}

const manifests = {
  "app-playground": manifestOf(appPlayground),
  "app-playground-base-path": manifestOf(appPlaygroundBasePath),
  "pages-i18n": manifestOf(pagesI18n),
} as const;

const ORIGIN = "https://example.test";

function request(url: string, headers: Record<string, string> = {}) {
  const result: DispatchRequest = {
    method: "GET",
    url: new URL(url, ORIGIN),
    headers: new Headers({ host: "example.test", ...headers }),
    // GET/HEAD have no body, but `resolveRoutes` requires a stream.
    body: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
  };
  return result;
}

function dispatcherFor(
  name: keyof typeof manifests,
  invokeMiddleware?: () => Promise<MiddlewareResult>,
): Dispatcher {
  const manifest = manifests[name];
  return createDispatcher({
    manifest,
    invokeMiddleware: manifest.middleware
      ? (invokeMiddleware ?? (async () => ({})))
      : undefined,
  });
}

describe("Dispatcher entrypoint resolution", () => {
  it("resolves a dynamic App Router page to its template entrypoint", async () => {
    const result = await dispatcherFor("app-playground").dispatch(
      request("/isr/1"),
    );
    expect(result.kind).toBe("entrypoint");
    if (result.kind !== "entrypoint") return;
    // `resolvedPathname` is the template; `invocationTarget` is concrete. Both
    // are needed: the first picks the module, the second is what it renders.
    expect(result.resolvedPathname).toBe("/isr/[id]");
    expect(result.invocationTarget).toEqual({
      pathname: "/isr/1",
      query: { nxtPid: "1" },
    });
    expect(result.query).toEqual({ nxtPid: "1" });
    expect(result.routeMatches).toMatchObject({ nxtPid: "1" });
    expect(result.entrypoint.filePath).toContain("isr/[id]/page.js");
    expect(result.entrypoint.type).toBe("app-page");
  });

  it("resolves an App Router route handler", async () => {
    const result = await dispatcherFor("app-playground").dispatch(
      request("/api/health"),
    );
    expect(result.kind).toBe("entrypoint");
    if (result.kind !== "entrypoint") return;
    expect(result.entrypoint.type).toBe("app-route");
    expect(result.resolvedPathname).toBe("/api/health");
  });

  it("matches basePath-prefixed entrypoint keys without normalization", async () => {
    // Step 1 keyed `entrypoints` by the basePath-prefixed `output.pathname` and
    // left open whether `resolvedPathname` comes back prefixed. It does — this
    // test is what closes that question.
    const dispatcher = dispatcherFor("app-playground-base-path");
    const result = await dispatcher.dispatch(request("/prod/isr/1"));
    expect(result.kind).toBe("entrypoint");
    if (result.kind !== "entrypoint") return;
    expect(result.resolvedPathname).toBe("/prod/isr/[id]");
    expect(result.invocationTarget.pathname).toBe("/prod/isr/1");

    // The same path without the prefix is not the app's.
    const unprefixed = await dispatcher.dispatch(request("/isr/1"));
    expect(unprefixed.kind).toBe("not-found");
  });

  it("resolves a Pages Router page and API route", async () => {
    const dispatcher = dispatcherFor("pages-i18n");
    const page = await dispatcher.dispatch(request("/en-US/ssr"));
    expect(page.kind).toBe("entrypoint");
    if (page.kind === "entrypoint") {
      expect(page.entrypoint.type).toBe("page");
    }
    const api = await dispatcher.dispatch(request("/api/hello"));
    expect(api.kind).toBe("entrypoint");
    if (api.kind === "entrypoint") {
      expect(api.entrypoint.type).toBe("page-api");
    }
  });

  it("resolves a Pages Router ISR data URL via its prerender template", async () => {
    // This only works because `buildAdapterManifest` adds dynamic *prerender*
    // templates to `pathnames`/`entrypoints`: `/_next/data/…/[slug].json` is
    // not a route output, so without it this URL 404s while `next start` serves
    // it.
    const { buildId } = manifests["pages-i18n"];
    const result = await dispatcherFor("pages-i18n").dispatch(
      request(`/_next/data/${buildId}/fr/blog/hello.json`),
    );
    expect(result.kind).toBe("entrypoint");
    if (result.kind !== "entrypoint") return;
    expect(result.resolvedPathname).toBe(
      `/_next/data/${buildId}/fr/blog/[slug].json`,
    );
    expect(result.entrypoint.filePath).toContain("blog/[slug]");
    expect(result.query).toMatchObject({ nxtPslug: "hello" });
  });

  it("resolves the canonical trailing-slash URL of a `trailingSlash` app", async () => {
    // The build's pathnames never carry the slash, but `trailingSlash: true`
    // makes `/a/` the URL Next.js's own 308 sends browsers to, and
    // `@next/routing` matches pathnames by exact equality. Measured against
    // next.js's `test/e2e/app-dir/trailingslash`: without this, 6 of 8 cases
    // failed, including `fetch('/api/revalidate')` getting the 404 page.
    const withSlash = structuredClone(
      appPlayground as unknown,
    ) as BuildCompleteContext;
    (withSlash.config as { trailingSlash: boolean }).trailingSlash = true;
    // All three captures are from apps with the default `trailingSlash: false`,
    // so their `beforeMiddleware` carries the *strip*-slash 308 (`/a/` → `/a`).
    // Leaving it in would make the clone incoherent — that redirect is what a
    // real `trailingSlash: true` build replaces with the add-slash one — and it
    // fires before any pathname is matched, so nothing below would be reached.
    const routing = withSlash.routing as {
      beforeMiddleware: { status?: number }[];
    };
    routing.beforeMiddleware = routing.beforeMiddleware.filter(
      (route) => route.status !== 308,
    );
    const dispatcher = createDispatcher({
      manifest: manifestOf(withSlash),
      invokeMiddleware: async () => ({}),
    });

    const page = await dispatcher.dispatch(request("/isr/1/"));
    expect(page.kind).toBe("entrypoint");
    if (page.kind !== "entrypoint") return;
    // Normalized on the way out, because `entrypoints` is keyed without the
    // slash and the render has to land on its prerender's cache key.
    expect(page.resolvedPathname).toBe("/isr/[id]");
    expect(page.invocationTarget).toEqual({
      pathname: "/isr/1",
      query: { nxtPid: "1" },
    });

    const route = await dispatcher.dispatch(request("/api/health/"));
    expect(route.kind).toBe("entrypoint");
    if (route.kind === "entrypoint") {
      expect(route.resolvedPathname).toBe("/api/health");
    }

    // A static file keeps its extension-bearing pathname: Next.js compiles the
    // *opposite* redirect for those, and shadowing it would serve `/x.js/`.
    const asset = await dispatcher.dispatch(request("/favicon.ico"));
    expect(asset.kind).toBe("static-file");
    expect(await dispatcher.dispatch(request("/favicon.ico/"))).toMatchObject({
      kind: "not-found",
    });
  });

  it("gives a param whose name prefixes another param's its own value", async () => {
    // `@next/routing` expands `$nxtPid2` by replacing group names in insertion
    // order, so the `$nxtPid` prefix wins and leaves a literal `2`: the route is
    // invoked with `nxtPid2=a2`. `repairRouteParamQuery` corrects it from
    // `routeMatches`. Measured against `test/e2e/app-dir/use-params`, whose
    // fixture is `app/[id]/[id2]/page.tsx`; the committed fixtures have no two
    // params where one name prefixes the other, so this renames a pair that the
    // app-playground capture does have.
    const renamed = JSON.parse(
      JSON.stringify(appPlayground)
        .replace(/subCategorySlug/g, "id2")
        .replace(/categorySlug/g, "id"),
    );
    const result = await createDispatcher({
      manifest: manifestOf(renamed),
      invokeMiddleware: async () => ({}),
    }).dispatch(request("/context/a/b"));
    expect(result.kind).toBe("entrypoint");
    if (result.kind !== "entrypoint") return;
    expect(result.resolvedPathname).toBe("/context/[id]/[id2]");
    expect(result.invocationTarget).toEqual({
      pathname: "/context/a/b",
      query: { nxtPid: "a", nxtPid2: "b" },
    });
    expect(result.query).toEqual({ nxtPid: "a", nxtPid2: "b" });
  });
});

describe("Dispatcher non-entrypoint outcomes", () => {
  it("serves a build asset as a static file with its immutable cache header", async () => {
    const manifest = manifests["app-playground"];
    const pathname = Object.keys(manifest.staticFiles).find((file) =>
      file.startsWith("/_next/static/"),
    )!;
    const result = await dispatcherFor("app-playground").dispatch(
      request(pathname),
    );
    expect(result.kind).toBe("static-file");
    if (result.kind !== "static-file") return;
    expect(result.pathname).toBe(pathname);
    expect(result.responseHeaders.get("cache-control")).toBe(
      "public,max-age=31536000,immutable",
    );
  });

  it("routes /_next/image to the optimizer, basePath included", async () => {
    const query = "?url=%2Ffoo.png&w=640&q=75";
    const plain = await dispatcherFor("app-playground").dispatch(
      request(`/_next/image${query}`),
    );
    expect(plain.kind).toBe("image-optimization");

    const prefixed = await dispatcherFor("app-playground-base-path").dispatch(
      request(`/prod/_next/image${query}`),
    );
    expect(prefixed.kind).toBe("image-optimization");
    if (prefixed.kind !== "image-optimization") return;
    expect(prefixed.url.searchParams.get("url")).toBe("/foo.png");
  });

  it("redirects a trailing slash", async () => {
    const result = await dispatcherFor("app-playground").dispatch(
      request("/isr/1/"),
    );
    expect(result).toMatchObject({
      kind: "redirect",
      status: 308,
      location: "/isr/1",
    });
  });

  it("serves the app's root in the default locale, with no redirect at all", async () => {
    // `resolveRoutes` prefixes the locale as `${basePath}/${locale}${pathname}`,
    // which turns the root into `/en-US/`, and the slash-stripping 308 every
    // build compiles then answered `GET /` with a redirect no `next start`
    // sends. Measured against `test/e2e/i18n-support-catchall`, whose `/` is a
    // 200. See `Dispatcher.withRootLocale`.
    const result = await dispatcherFor("pages-i18n").dispatch(request("/"));
    expect(result).toMatchObject({ kind: "static-file", pathname: "/en-US" });
  });

  it("redirects the root to the locale the request asked for", async () => {
    const result = await dispatcherFor("pages-i18n").dispatch(
      request("/", { "accept-language": "nl-NL" }),
    );
    // 307 and not 308, because the next request may detect a different locale.
    // Relative and without the trailing slash `resolveRoutes` puts in the
    // location it builds (`https://example.test/nl-NL/`), which is what
    // `next start` sends and what a test asserting `headers.location` reads.
    expect(result).toMatchObject({
      kind: "redirect",
      status: 307,
      location: "/nl-NL",
    });
  });

  it("keeps a redirect to another locale's domain absolute", async () => {
    // The fixture maps `fr` onto example.fr, and an absolute location is the
    // only way to leave the origin.
    const result = await dispatcherFor("pages-i18n").dispatch(
      request("/", { cookie: "NEXT_LOCALE=fr" }),
    );
    expect(result).toMatchObject({
      kind: "redirect",
      status: 307,
      location: "https://example.fr/",
    });
  });

  it("still strips a trailing slash the request itself carried", async () => {
    const result = await dispatcherFor("pages-i18n").dispatch(
      request("/nl-NL/"),
    );
    expect(result).toMatchObject({
      kind: "redirect",
      status: 308,
      location: "/nl-NL",
    });
  });

  it("returns a direct response for a route that forces a status", async () => {
    const base = manifests["app-playground"];
    const manifest: AdapterManifest = {
      ...base,
      middleware: null,
      routing: {
        ...(base.routing as Record<string, unknown>),
        beforeFiles: [
          {
            sourceRegex: "^/blocked$",
            status: 403,
            headers: { "x-why": "no" },
          },
        ],
      },
    };
    const result = await createDispatcher({ manifest }).dispatch(
      request("/blocked"),
    );
    expect(result).toMatchObject({ kind: "response", status: 403 });
    expect(result.responseHeaders.get("x-why")).toBe("no");
  });

  it("reports an unknown path as not found", async () => {
    const result = await dispatcherFor("app-playground").dispatch(
      request("/definitely-not-a-route"),
    );
    expect(result.kind).toBe("not-found");
    if (result.kind !== "not-found") return;
    expect(result.pathname).toBe("/definitely-not-a-route");
  });

  it("resolves the 404 target per router flavor", () => {
    expect(dispatcherFor("app-playground").notFound).toMatchObject({
      kind: "entrypoint",
      pathname: "/_not-found",
    });
    expect(dispatcherFor("app-playground-base-path").notFound).toMatchObject({
      kind: "entrypoint",
      pathname: "/prod/_not-found",
    });
    // Pages Router has no `/_not-found`; `_error` is the invocable equivalent.
    expect(dispatcherFor("pages-i18n").notFound).toMatchObject({
      kind: "entrypoint",
      pathname: "/_error",
    });
  });

  it("prefers an invocable custom /404 over /_error", () => {
    // What `pages/404.js` plus a `pages/_app.js` with `getInitialProps` builds:
    // the 404 cannot be prerendered, so it arrives as an entrypoint beside
    // `/_error`. Serving `/_error` there means the built-in "404: This page
    // could not be found" replaces the app's own — `test/e2e/404-page-app`.
    const base = manifests["pages-i18n"];
    const withCustom404: AdapterManifest = {
      ...base,
      entrypoints: {
        ...base.entrypoints,
        "/404": { ...base.entrypoints["/_error"], id: "/404" },
      },
    };
    expect(
      createDispatcher({ manifest: withCustom404 }).notFound,
    ).toMatchObject({ kind: "entrypoint", pathname: "/404" });
    // App Router still wins over both: `/_not-found` is what next looks for
    // first, and an app with both routers has all three.
    expect(
      createDispatcher({
        manifest: {
          ...withCustom404,
          entrypoints: {
            ...withCustom404.entrypoints,
            "/_not-found": {
              ...base.entrypoints["/_error"],
              id: "/_not-found",
            },
          },
        },
      }).notFound,
    ).toMatchObject({ kind: "entrypoint", pathname: "/_not-found" });
  });

  it("falls back to a prerendered 404, then to nothing", () => {
    const base = manifests["app-playground"];
    const withoutEntrypoints: AdapterManifest = {
      ...base,
      entrypoints: {},
      middleware: null,
    };
    expect(createDispatcher({ manifest: withoutEntrypoints }).notFound).toEqual(
      {
        kind: "static-file",
        pathname: "/404",
        filePath: base.staticFiles["/404"],
      },
    );
    expect(
      createDispatcher({
        manifest: { ...withoutEntrypoints, staticFiles: {} },
      }).notFound,
    ).toEqual({ kind: "none" });
  });
});

describe("resolveErrorTarget", () => {
  it("prefers the prerendered /500 next emits by default", () => {
    const base = manifests["app-playground"];
    expect(resolveErrorTarget(base)).toEqual({
      kind: "static-file",
      pathname: "/500",
      filePath: base.staticFiles["/500"],
    });
  });

  it("prefers an invocable /500 over the prerendered one", () => {
    // What a `pages/500.js` that cannot be static-optimized builds.
    const base = manifests["pages-i18n"];
    expect(
      resolveErrorTarget({
        ...base,
        entrypoints: {
          ...base.entrypoints,
          "/500": { ...base.entrypoints["/_error"], id: "/500" },
        },
      }),
    ).toMatchObject({ kind: "entrypoint", pathname: "/500" });
  });

  it("falls back to /_error, then to nothing", () => {
    // `/_error` is where a custom error page lands when it has
    // `getInitialProps` — the case `test/e2e/async-modules` measures.
    const base = manifests["pages-i18n"];
    expect(resolveErrorTarget({ ...base, staticFiles: {} })).toMatchObject({
      kind: "entrypoint",
      pathname: "/_error",
    });
    expect(
      resolveErrorTarget({ ...base, staticFiles: {}, entrypoints: {} }),
    ).toEqual({ kind: "none" });
  });

  it("looks for the error page under the app's basePath", () => {
    const base = manifests["app-playground-base-path"];
    expect(resolveErrorTarget(base)).toMatchObject({ pathname: "/prod/500" });
  });
});

describe("toRedirect", () => {
  it("prefers the documented redirect field", () => {
    // `resolveRoutes` does not populate `ResolveRoutesResult.redirect` in
    // next 16.3.5 — every redirect arrives as bare status + `location` — so this
    // is the only coverage that branch can have until it does.
    expect(
      toRedirect(
        { redirect: { url: new URL("https://e.test/x"), status: 301 } },
        new Headers(),
      ),
    ).toEqual({ location: "https://e.test/x", status: 301 });
  });

  it("ignores a location header on a non-3xx status", () => {
    const headers = new Headers({ location: "/x" });
    expect(toRedirect({ status: 200 }, headers)).toBeUndefined();
    expect(toRedirect({ status: 403 }, headers)).toBeUndefined();
    expect(toRedirect({}, headers)).toBeUndefined();
    expect(toRedirect({ status: 308 }, new Headers())).toBeUndefined();
  });
});

describe("Dispatcher middleware handling", () => {
  it("reports a middleware response without resolving a route", async () => {
    const result = await dispatcherFor("app-playground", async () => ({
      bodySent: true,
      responseHeaders: new Headers({ "x-mw": "responded" }),
    })).dispatch(request("/isr/1"));
    expect(result.kind).toBe("middleware-responded");
  });

  it("normalizes a middleware redirect to a same-origin path", async () => {
    const result = await dispatcherFor("app-playground", async () => ({
      redirect: { url: new URL("/login", ORIGIN), status: 307 },
    })).dispatch(request("/isr/1"));
    expect(result).toMatchObject({
      kind: "redirect",
      status: 307,
      // `NextResponse.redirect(new URL("/login", request.url))` is how every
      // middleware spells this, and Next.js sends the path: `@next/routing`'s
      // own `getRelativeURL` does it for the header it sets, and only the
      // `redirect.url` field this path reads keeps the absolute form.
      location: "/login",
    });
  });

  it("follows an internal middleware rewrite to the rewritten entrypoint", async () => {
    const result = await dispatcherFor("app-playground", async () => ({
      rewrite: new URL("/api/health", ORIGIN),
    })).dispatch(request("/isr/1"));
    expect(result.kind).toBe("entrypoint");
    if (result.kind !== "entrypoint") return;
    expect(result.resolvedPathname).toBe("/api/health");
  });

  it("routes /_next/image when middleware is what put the request on it", async () => {
    // The API Gateway examples' middleware rewrites `/x` to `/<stage>/x` so the
    // build's `basePath` lines up. `resolveRoutes` never reports the rewritten
    // URL back — and cannot resolve `/_next/image` itself — so matching the URL
    // as received would 404 every optimized image behind such a rewrite.
    const query = "?url=%2Ffoo.png&w=640&q=75";
    const result = await dispatcherFor(
      "app-playground-base-path",
      async () => ({ rewrite: new URL(`/prod/_next/image${query}`, ORIGIN) }),
    ).dispatch(request(`/_next/image${query}`));
    expect(result.kind).toBe("image-optimization");
    if (result.kind !== "image-optimization") return;
    expect(result.url.searchParams.get("url")).toBe("/foo.png");
  });

  it("does not leak the internal rewrite header it consumed", async () => {
    const result = await dispatcherFor("app-playground", async () => ({
      rewrite: new URL("/api/health", ORIGIN),
      responseHeaders: new Headers({ "x-middleware-rewrite": "/api/health" }),
    })).dispatch(request("/isr/1"));
    expect(result.responseHeaders.has("x-middleware-rewrite")).toBe(false);
  });

  it("reports an external middleware rewrite as a proxy target", async () => {
    const result = await dispatcherFor("app-playground", async () => ({
      rewrite: new URL("https://upstream.test/x"),
    })).dispatch(request("/isr/1"));
    expect(result.kind).toBe("external-rewrite");
    if (result.kind !== "external-rewrite") return;
    expect(result.url.href).toBe("https://upstream.test/x");
  });

  it("carries middleware request headers forward and response headers back", async () => {
    // `resolveRoutes` drops `MiddlewareResult.requestHeaders`: it neither
    // returns them nor mutates the `headers` it was given. Dispatch captures
    // them from the callback, which is what keeps
    // `NextResponse.next({ request: { headers } })` working.
    const result = await dispatcherFor("app-playground", async () => ({
      requestHeaders: new Headers({ host: "example.test", "x-user": "42" }),
      responseHeaders: new Headers({ "x-mw": "ran" }),
    })).dispatch(request("/isr/1"));
    expect(result.kind).toBe("entrypoint");
    if (result.kind !== "entrypoint") return;
    expect(result.requestHeaders.get("x-user")).toBe("42");
    expect(result.responseHeaders.get("x-mw")).toBe("ran");
  });

  it("passes the caller's request headers through when middleware adds none", async () => {
    const result = await dispatcherFor("app-playground").dispatch(
      request("/isr/1", { "x-caller": "yes" }),
    );
    expect(result.kind).toBe("entrypoint");
    if (result.kind !== "entrypoint") return;
    expect(result.requestHeaders.get("x-caller")).toBe("yes");
  });

  it("refuses to construct without a runner when the build has middleware", () => {
    expect(() =>
      createDispatcher({ manifest: manifests["app-playground"] }),
    ).toThrow(/needs an `invokeMiddleware` implementation/);
    // No middleware in the build, so no runner is required.
    expect(() =>
      createDispatcher({ manifest: manifests["pages-i18n"] }),
    ).not.toThrow();
  });
});

describe("repairRouteParamQuery", () => {
  it("drops an optional catchall's param when the request filled none", () => {
    // Measured from `resolveRoutes` for `/optional-catchall` against
    // `app/optional-catchall/[[...params]]`: *both* sides carry the key with no
    // value, which the `@next/routing` types do not admit. The key alone is what
    // makes `prepare()` invent a param, so the key has to go.
    expect(
      repairRouteParamQuery(
        { nxtPparams: undefined! },
        {
          nxtPparams: undefined,
        },
      ),
    ).toEqual({});
    // The same shape with "" for the value, which the expansion can also produce.
    expect(repairRouteParamQuery({ nxtPparams: "" }, {})).toEqual({});
    // A filled one is left alone, whichever source it came from.
    expect(
      repairRouteParamQuery({ nxtPparams: "a/b" }, { nxtPparams: "a/b" }),
    ).toEqual({ nxtPparams: "a/b" });
    // No route param can be legitimately empty - a required segment captures
    // `[^/]+?`, a required catchall `.+?`, and an optional catchall that matched
    // nothing has no group for `routeMatches` to report - so an empty value goes
    // whether or not `routeMatches` echoes it.
    expect(repairRouteParamQuery({ nxtPid: "" }, { nxtPid: "" })).toEqual({});
    // Not a route param, so not ours to touch.
    expect(repairRouteParamQuery({ q: "" }, {})).toEqual({ q: "" });
  });

  it("repairs and drops in one pass", () => {
    // The prefix collision and the unset optional catchall in the same query:
    // `nxtPid2` is wrong and `nxtPrest` was never requested.
    expect(
      repairRouteParamQuery(
        { nxtPid: "a", nxtPid2: "a2", nxtPrest: "" },
        { nxtPid: "a", nxtPid2: "b" },
      ),
    ).toEqual({ nxtPid: "a", nxtPid2: "b" });
  });
});

describe("outOfBandRouteParams", () => {
  it("leaves a query the contract can carry alone", () => {
    expect(
      outOfBandRouteParams(
        { nxtPrest: "a/b", q: "1" },
        "/pages-cache/[...rest]",
      ),
    ).toBeUndefined();
    expect(outOfBandRouteParams({ nxtPid: "42" }, "/isr/[id]")).toBeUndefined();
    // An encoded delimiter in something that is not a route param is not ours.
    expect(
      outOfBandRouteParams({ q: "a%2Fb" }, "/pages-cache/[...rest]"),
    ).toBeUndefined();
  });

  it("restates a capture with an encoded delimiter as params, once decoded", () => {
    // `test/e2e/incremental-cache-path-traversal`. Through the query contract
    // this becomes three params and `normalizePagePath` throws on the pathname
    // rebuilt from them; `next start` renders one param, which is this.
    expect(
      outOfBandRouteParams(
        { nxtPrest: "..%2F..%2Fserver-reference-manifest" },
        "/_next/data/BUILD_ID/pages-cache/[...rest].json",
      ),
    ).toEqual({
      params: { rest: ["../../server-reference-manifest"] },
      query: {},
    });
  });

  it("splits a repeat on real delimiters only, and keeps a single param whole", () => {
    expect(
      outOfBandRouteParams(
        { nxtPrest: "a/b%2Fc/d" },
        "/pages-cache/[[...rest]]",
      ),
    ).toEqual({ params: { rest: ["a", "b/c", "d"] }, query: {} });
    expect(outOfBandRouteParams({ nxtPid: "a%2Fb" }, "/isr/[id]")).toEqual({
      params: { id: "a/b" },
      query: {},
    });
  });

  it("keeps everything that is not a route param in the query", () => {
    expect(
      outOfBandRouteParams(
        { nxtPrest: "a%2Fb", from: "/x", page: "2" },
        "/pages-cache/[...rest]",
      ),
    ).toEqual({
      params: { rest: ["a/b"] },
      query: { from: "/x", page: "2" },
    });
  });

  it("stays on the query contract when a param cannot be restated", () => {
    // An optional catchall the request left unset. Half a param set is worse
    // than none: `prepare` would interpolate a route with a missing segment.
    expect(
      outOfBandRouteParams(
        { nxtPrest: "a%2Fb", nxtPoptional: "" },
        "/pages-cache/[...rest]/[[...optional]]",
      ),
    ).toBeUndefined();
  });

  it("tolerates a capture that is not valid percent-encoding", () => {
    // `decodeQueryPathParameter` is a try/catch for the same reason: `%2F` makes
    // this reachable while `%zz` makes `decodeURIComponent` throw.
    expect(
      outOfBandRouteParams({ nxtPrest: "a%2F%zz" }, "/pages-cache/[...rest]"),
    ).toEqual({ params: { rest: ["a%2F%zz"] }, query: {} });
  });
});

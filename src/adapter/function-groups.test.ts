/* eslint-disable import/no-extraneous-dependencies */
import { getNamedRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";
import {
  getSortedRouteObjects,
  getSortedRoutes,
} from "next/dist/shared/lib/router/utils/sorted-routes";
import appPlayground from "./__fixtures__/app-playground.json";
import pagesI18n from "./__fixtures__/pages-i18n.json";
import { BuildCompleteContext, buildAdapterManifest } from "./build-outputs";
import {
  AssignRoutesOptions,
  DEFAULT_FUNCTION_GROUP,
  FunctionGroupSpec,
  RouteEntry,
  RoutingRules,
  assignRoutesToGroups,
  interceptedRoute,
  parseFunctionGroupsEnv,
  pathPatternsFor,
  routedPatterns,
  validateFunctionGroups,
} from "./function-groups";

/** One entrypoint per template unless a test says otherwise. */
const routes = (...templates: string[]): RouteEntry[] =>
  templates.map((template) => ({ template, entrypointId: template }));

const BUILD_ID = "abc123";

/**
 * `ctx.routing.dynamicRoutes` as `next build` derives it from `entries`: Next's
 * own route sort and regexes, data URLs included.
 */
function nextRouting(entries: RouteEntry[], basePath: string): RoutingRules {
  const dataPrefix = `${basePath}/_next/data/${BUILD_ID}/`;
  const dynamic = [...new Set(entries.map((entry) => entry.template))].filter(
    (template) =>
      template.includes("[") &&
      !template.endsWith(".rsc") &&
      !/\(\.{1,3}\)/.test(template),
  );
  const route = (template: string) => ({
    sourceRegex: getNamedRouteRegex(template, {
      prefixRouteKeys: true,
      includeSuffix: true,
    }).namedRegex,
    destination: template,
  });
  return {
    dynamicRoutes: [
      // Sorted by the page they name: Next's sort reads `[slug].json` as static.
      ...getSortedRouteObjects(
        dynamic.filter((template) => template.startsWith(dataPrefix)),
        (template) => `/${template.slice(dataPrefix.length, -".json".length)}`,
      ).map(route),
      ...getSortedRoutes(
        dynamic.filter((template) => !template.startsWith(dataPrefix)),
      ).map(route),
    ],
  };
}

const assignment = (
  groups: FunctionGroupSpec[],
  entries: RouteEntry[],
  basePath = "",
  options: Partial<AssignRoutesOptions> = {},
) =>
  assignRoutesToGroups(groups, entries, {
    basePath,
    buildId: BUILD_ID,
    ...options,
    routing: { ...nextRouting(entries, basePath), ...options.routing },
  });

const assign = (...args: Parameters<typeof assignment>) =>
  assignment(...args).templates;

/** The path patterns of the behaviors the assignment returns, in order. */
const patternsOf = (...args: Parameters<typeof assignment>) =>
  assignment(...args).behaviors.map(({ pattern }) => pattern);

/**
 * A captured `onBuildComplete` fixture's routes, exactly as `buildAdapterManifest`
 * hands them to the assignment, plus the rest of what it passes.
 */
function fixtureRoutes(fixture: unknown) {
  const ctx = structuredClone(fixture) as BuildCompleteContext;
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const { manifest } = buildAdapterManifest(ctx, { buildCwd: ctx.projectDir });
  warn.mockRestore();
  const entries: RouteEntry[] = Object.entries(manifest.entrypoints).map(
    ([template, entrypoint]) => ({
      template,
      entrypointId: entrypoint.filePath,
      type: entrypoint.type,
    }),
  );
  return {
    entries,
    options: {
      basePath: ctx.config.basePath || "",
      buildId: ctx.buildId,
      trailingSlash: ctx.config.trailingSlash === true,
      routing: ctx.routing,
    } as AssignRoutesOptions,
  };
}

describe("validateFunctionGroups", () => {
  it("rejects an empty array rather than treating it as no splitting", () => {
    expect(() => validateFunctionGroups([])).toThrow(/Omit the prop entirely/);
  });

  it("reserves the default group name", () => {
    expect(() =>
      validateFunctionGroups([{ name: "default", routes: ["/a"] }]),
    ).toThrow(/reserved group name/);
  });

  it.each([["has space"], ["under_score"], ["dots.here"], [""]])(
    "rejects group name %p, which has to be a construct id",
    (name) => {
      expect(() => validateFunctionGroups([{ name, routes: ["/a"] }])).toThrow(
        /must match/,
      );
    },
  );

  it("rejects two groups with the same name", () => {
    expect(() =>
      validateFunctionGroups([
        { name: "api", routes: ["/a"] },
        { name: "api", routes: ["/b"] },
      ]),
    ).toThrow(/both named "api"/);
  });

  it("rejects a group that owns no routes", () => {
    expect(() => validateFunctionGroups([{ name: "api", routes: [] }])).toThrow(
      /owns no routes/,
    );
  });

  it("rejects the same pattern in two groups", () => {
    expect(() =>
      validateFunctionGroups([
        { name: "a", routes: ["/api/**"] },
        { name: "b", routes: ["/api/**"] },
      ]),
    ).toThrow(/appears in both group "a" and group "b"/);
  });

  it("allows overlapping-but-different patterns, which resolve longest-first", () => {
    expect(() =>
      validateFunctionGroups([
        { name: "a", routes: ["/api/**"] },
        { name: "b", routes: ["/api/reports/**"] },
      ]),
    ).not.toThrow();
  });

  it("requires a leading slash", () => {
    expect(() =>
      validateFunctionGroups([{ name: "a", routes: ["api/**"] }]),
    ).toThrow(/must start with "\/"/);
  });

  it.each([["/dashboard/[id]"], ["/blog/[...slug]"], ["/shop/[[...slug]]"]])(
    "rejects the dynamic segment in %p, which CloudFront cannot express",
    (route) => {
      expect(() =>
        validateFunctionGroups([{ name: "a", routes: [route] }]),
      ).toThrow(/contains a dynamic segment/);
    },
  );

  it("rejects a route group segment, which never appears in a URL", () => {
    expect(() =>
      validateFunctionGroups([{ name: "a", routes: ["/(marketing)/about"] }]),
    ).toThrow(/route group segment/);
  });

  it.each([["/api/*"], ["/api/**/x"], ["/api/repo?ts"], ["/*"]])(
    "rejects the wildcard placement in %p",
    (route) => {
      expect(() =>
        validateFunctionGroups([{ name: "a", routes: [route] }]),
      ).toThrow(/wildcard somewhere other than a trailing/);
    },
  );

  it("rejects a pattern that would own everything", () => {
    expect(() =>
      validateFunctionGroups([{ name: "a", routes: ["/**"] }]),
    ).toThrow(/would own every route/);
  });

  it("rejects the root, which no CloudFront path pattern can match alone", () => {
    expect(() =>
      validateFunctionGroups([{ name: "a", routes: ["/"] }]),
    ).toThrow(/cannot be routed/);
  });

  it("accepts /index, which is a real App Router route", () => {
    // `app/index/page.tsx` is served at `/index`, apart from `/`. Only the
    // assignment knows which router `/index` came from; it rejects the Pages
    // Router home page, which is the same file as `/`.
    expect(() =>
      validateFunctionGroups([{ name: "a", routes: ["/index"] }]),
    ).not.toThrow();
  });

  it.each(["/_next", "/_next/**", "/_next/data/**"])(
    "rejects %s, which Next.js reserves",
    (route) => {
      // A data route follows its page into the page's group; a `_next/*`
      // behavior would compete with the static-asset and image behaviors.
      expect(() =>
        validateFunctionGroups([{ name: "a", routes: [route] }]),
      ).toThrow(/under "\/_next"/);
    },
  );

  it("rejects an empty path segment", () => {
    expect(() =>
      validateFunctionGroups([{ name: "a", routes: ["/api//x"] }]),
    ).toThrow(/empty path segment/);
  });

  it.each([
    ["/über", '"ü"'],
    ["/a b", '" "'],
    ["/shop/a,b/**", '","'],
    ["/100%25", '"%"'],
  ])(
    "rejects %p, which holds a character no CloudFront path pattern can",
    (route, char) => {
      // `pathPatternsFor` copies the route verbatim into a behavior path
      // pattern, so without this it failed at deploy naming neither the group
      // nor the route.
      expect(() =>
        validateFunctionGroups([{ name: "a", routes: [route] }]),
      ).toThrow(`contains ${char}, which a CloudFront behavior path pattern`);
    },
  );

  it("accepts every literal in CloudFront's path pattern alphabet", () => {
    expect(() =>
      validateFunctionGroups([
        {
          name: "a",
          routes: [`/AZaz09_-.$~"'@:+&/**`],
        },
      ]),
    ).not.toThrow();
  });
});

describe("assignRoutesToGroups", () => {
  it("puts unassigned routes in the default group, which always exists", () => {
    const assigned = assign(
      [{ name: "api", routes: ["/api/**"] }],
      routes("/", "/pricing", "/api/health"),
    );
    expect(assigned).toEqual({
      [DEFAULT_FUNCTION_GROUP]: ["/", "/pricing"],
      api: ["/api/health"],
    });
  });

  it("matches an exact pattern only exactly", () => {
    const assigned = assign(
      [{ name: "p", routes: ["/pricing"] }],
      routes("/pricing", "/pricing/enterprise"),
    );
    expect(assigned.p).toEqual(["/pricing"]);
    expect(assigned[DEFAULT_FUNCTION_GROUP]).toEqual(["/pricing/enterprise"]);
  });

  it("matches a subtree against the dynamic routes under it", () => {
    const assigned = assign(
      [{ name: "blog", routes: ["/blog/**"] }],
      routes("/blog/[slug]", "/blog/[slug]/comments", "/blogroll"),
    );
    expect(assigned.blog).toEqual(["/blog/[slug]", "/blog/[slug]/comments"]);
    expect(assigned[DEFAULT_FUNCTION_GROUP]).toEqual(["/blogroll"]);
  });

  it("does not let a subtree claim its own root, because the behavior would not", () => {
    // `/api/reports/**` deploys as CloudFront `api/reports/*`, which does not
    // match `/api/reports`. Claiming it here would package the route into a
    // function the edge never routes it to.
    expect(() =>
      assign(
        [{ name: "r", routes: ["/api/reports/**"] }],
        routes("/api/reports"),
      ),
    ).toThrow(/matches no route in this build/);
  });

  it("gives the longest matching pattern the route", () => {
    const assigned = assign(
      [
        { name: "api", routes: ["/api/**"] },
        { name: "reports", routes: ["/api/reports/**"] },
      ],
      routes("/api/health", "/api/reports/[id]"),
    );
    expect(assigned.api).toEqual(["/api/health"]);
    expect(assigned.reports).toEqual(["/api/reports/[id]"]);
  });

  it("ranks by segment count before string length", () => {
    // "/a/b" is deeper than "/alongname" even though it is shorter.
    const assigned = assign(
      [
        { name: "deep", routes: ["/a/b/**"] },
        { name: "long", routes: ["/a/**"] },
      ],
      routes("/a/b/c", "/a/x"),
    );
    expect(assigned.deep).toEqual(["/a/b/c"]);
    expect(assigned.long).toEqual(["/a/x"]);
  });

  it("throws on a pattern that matches nothing, because the typo is invisible", () => {
    expect(() =>
      assign(
        [{ name: "api", routes: ["/api/**", "/apy/**"] }],
        routes("/api/x"),
      ),
    ).toThrow(/pattern "\/apy\/\*\*" matches no route/);
  });

  it("accepts a pattern every match of which a narrower pattern also claims", () => {
    // `/api/**` never wins a route here, because every API route this build has
    // is under `/api/reports/`. Recording only the *winning* pattern made it look
    // like a typo and threw - rejecting the exact layout the duplicate-pattern
    // error documents as supported. The group is legitimately empty: it is the
    // consumer's choice to keep it for the routes it will own later.
    const assigned = assign(
      [
        { name: "api", routes: ["/api/**"] },
        { name: "reports", routes: ["/api/reports/**"] },
      ],
      routes("/api/reports/[id]", "/api/reports/summary"),
    );
    expect(assigned.api).toEqual([]);
    expect(assigned.reports).toEqual([
      "/api/reports/[id]",
      "/api/reports/summary",
    ]);
  });

  it("gives a shared entrypoint to its most specific match, not its last one", () => {
    // Two templates, one file, two groups whose patterns both match - one
    // narrowly, one broadly. Ownership used to be last-write-wins over `entries`,
    // so the same build grouped differently depending on manifest key order.
    const entries: RouteEntry[] = [
      // Matched only by the broad pattern.
      { template: "/api/health", entrypointId: "shared" },
      // Matched by both; the narrow one wins.
      { template: "/api/reports/summary", entrypointId: "shared" },
    ];
    const groups: FunctionGroupSpec[] = [
      { name: "api", routes: ["/api/**"] },
      { name: "reports", routes: ["/api/reports/**"] },
    ];
    // `/api/reports/**` is the most specific claim any of the entrypoint's
    // templates has, so it takes the whole entrypoint — and then the edge still
    // sends `/api/health` to the api group, which lacks the file. That used to
    // deploy and 500; it is the coverage check's to reject, identically in both
    // orders.
    const message =
      /"\/api\/health" to group "api" \(its pattern "\/api\/\*\*"\)/;
    expect(() => assign(groups, entries)).toThrow(message);
    expect(() => assign(groups, [...entries].reverse())).toThrow(message);
    expect(() => assign(groups, entries)).toThrow(
      /Add "\/api\/health" to group "reports"'s routes/,
    );
    // Which is the fix: the exact pattern beats the api subtree at the edge.
    const fixed = assign(
      [
        groups[0],
        { name: "reports", routes: ["/api/reports/**", "/api/health"] },
      ],
      entries,
    );
    expect(fixed.reports).toEqual(["/api/health", "/api/reports/summary"]);
    expect(fixed.api).toEqual([]);
  });

  it("prefixes basePath before matching, since manifest templates carry it", () => {
    const assigned = assign(
      [{ name: "api", routes: ["/api/**"] }],
      routes("/prod/api/health", "/prod/pricing"),
      "/prod",
    );
    expect(assigned.api).toEqual(["/prod/api/health"]);
    expect(assigned[DEFAULT_FUNCTION_GROUP]).toEqual(["/prod/pricing"]);
  });

  it("keeps two templates sharing one entrypoint in the same group", () => {
    // A Pages Router page and its `/_next/data/<buildId>/…json` sibling are one
    // file; splitting them would stage it twice and misroute one of them.
    const assigned = assign(
      [{ name: "blog", routes: ["/blog/**"] }],
      [
        {
          template: "/blog/[slug]",
          entrypointId: "pages/blog/[slug]",
          type: "page",
        },
        {
          template: "/_next/data/abc123/blog/[slug].json",
          entrypointId: "pages/blog/[slug]",
          type: "page",
        },
        { template: "/", entrypointId: "pages/index", type: "page" },
      ],
    );
    expect(assigned.blog).toEqual([
      "/_next/data/abc123/blog/[slug].json",
      "/blog/[slug]",
    ]);
    expect(assigned[DEFAULT_FUNCTION_GROUP]).toEqual(["/"]);
  });

  it("returns every group even when a group ends up with only the default's leftovers", () => {
    const assigned = assign(
      [{ name: "api", routes: ["/api/**"] }],
      routes("/api/health"),
    );
    expect(Object.keys(assigned).sort()).toEqual(["api", "default"]);
    expect(assigned[DEFAULT_FUNCTION_GROUP]).toEqual([]);
  });

  it("sorts each group's templates so the manifest is byte-stable", () => {
    const assigned = assign(
      [{ name: "api", routes: ["/api/**"] }],
      routes("/api/z", "/api/a", "/z", "/a"),
    );
    expect(assigned.api).toEqual(["/api/a", "/api/z"]);
    expect(assigned[DEFAULT_FUNCTION_GROUP]).toEqual(["/a", "/z"]);
  });
});

describe("the behaviors the assignment returns", () => {
  it("orders overlapping group patterns most specific first", () => {
    // CloudFront stops at the first matching behavior, so `api/*` ahead of
    // `api/reports/*` would send every report request to the wrong function.
    expect(
      patternsOf(
        [
          { name: "api", routes: ["/api/**"] },
          { name: "reports", routes: ["/api/reports/**"] },
        ],
        routes("/api/[x]", "/api/reports/[id]"),
      ),
    ).toEqual(["api/reports/*", "api/*"]);
  });

  it("ranks by segment count before string length", () => {
    expect(
      patternsOf(
        [
          { name: "a", routes: ["/a/b/**"] },
          { name: "b", routes: ["/averyverylongsegment/**"] },
        ],
        routes("/a/b/[x]", "/averyverylongsegment/[x]"),
      ),
    ).toEqual(["a/b/*", "averyverylongsegment/*"]);
  });

  it("puts an exact pattern ahead of a wildcard of the same depth", () => {
    // `a/*` and `a/b` are the same length and segment count; `a/*` first
    // swallows `a/b`, sending group b's only route to group a's function.
    expect(
      patternsOf(
        [
          { name: "a", routes: ["/a/**"] },
          { name: "b", routes: ["/a/b"] },
        ],
        routes("/a/b", "/a/[x]"),
      ),
    ).toEqual(["a/b", "a/*"]);
  });

  it("adds data-URL behaviors only for the groups that own a Pages Router page", () => {
    // One legacy page must not double every group's behaviors.
    expect(
      patternsOf(
        [
          { name: "blog", routes: ["/blog/**"] },
          { name: "docs", routes: ["/docs/**"] },
        ],
        [
          {
            template: "/blog/[slug]",
            entrypointId: "pages/blog/[slug].js",
            type: "page",
          },
          { template: "/docs/[page]", entrypointId: "app/docs/[page]/page.js" },
        ],
      ),
    ).toEqual(["_next/data/abc123/blog/*", "blog/*", "docs/*"]);
  });
});

describe("what the edge routes, checked against what was packaged", () => {
  describe("Pages Router data URLs (A)", () => {
    it("keeps a nested page's data URL in its own group", () => {
      // With `_next/data/*/blog/*`, CloudFront sent the docs group's
      // `/_next/data/<id>/docs/blog/intro.json` to the blog function.
      const page = (template: string, file: string): RouteEntry[] => [
        { template, entrypointId: file, type: "page" },
        {
          template: `/_next/data/${BUILD_ID}${template}.json`,
          entrypointId: file,
          type: "page",
        },
      ];
      const assigned = assign(
        [
          { name: "blog", routes: ["/blog/**"] },
          { name: "docs", routes: ["/docs/**"] },
        ],
        [
          ...page("/blog/[slug]", "pages/blog/[slug].js"),
          ...page("/docs/blog/[slug]", "pages/docs/blog/[slug].js"),
        ],
      );
      expect(assigned.docs).toEqual([
        "/_next/data/abc123/docs/blog/[slug].json",
        "/docs/blog/[slug]",
      ]);
    });

    it("routes the pages-i18n fixture's page and data URLs together", () => {
      // Splitting refuses i18n, so drop the locale-prefixed copies and keep the
      // shape the fixture has without them: a dynamic SSG page, an SSR page with
      // its data output, two API routes.
      const { entries, options } = fixtureRoutes(pagesI18n);
      const locale = /^\/(?:_next\/data\/[^/]+\/)?(?:en-US|fr|nl-NL)(?:\/|$)/;
      const unlocalized = entries.filter(
        (entry) => !locale.test(entry.template),
      );
      const { templates, behaviors } = assignRoutesToGroups(
        [
          { name: "blog", routes: ["/blog/**"] },
          { name: "ssr", routes: ["/ssr"] },
        ],
        unlocalized,
        options,
      );
      expect(templates.blog).toEqual(["/blog/[slug]"]);
      expect(templates.ssr).toEqual([
        `/_next/data/${options.buildId}/ssr.json`,
        "/ssr",
      ]);
      expect(
        behaviors.filter(({ pattern }) => pattern.startsWith("_next/data/")),
      ).toEqual([
        {
          group: "ssr",
          route: "/ssr",
          pattern: `_next/data/${options.buildId}/ssr.json`,
        },
        {
          group: "blog",
          route: "/blog/**",
          pattern: `_next/data/${options.buildId}/blog/*`,
        },
      ]);
    });
  });

  describe("an optional catch-all's parent (B)", () => {
    it("routes the parent URL with the subtree that moved the file", () => {
      const { entries, options } = fixtureRoutes(appPlayground);
      const groups = [{ name: "params", routes: ["/params/optional/**"] }];
      const { templates, behaviors } = assignRoutesToGroups(
        groups,
        entries,
        options,
      );
      expect(templates.params).toContain("/params/optional/[[...rest]]");
      // `params/optional/*` does not match `/params/optional`, which the same
      // file serves, so it gets an exact behavior of its own.
      expect(behaviors).toEqual([
        {
          group: "params",
          route: "/params/optional",
          pattern: "params/optional",
        },
        {
          group: "params",
          route: "/params/optional/**",
          pattern: "params/optional/*",
        },
      ]);
    });

    it("points the old exact-pattern workaround at the subtree", () => {
      const { entries, options } = fixtureRoutes(appPlayground);
      expect(() =>
        assignRoutesToGroups(
          [{ name: "params", routes: ["/params/optional"] }],
          entries,
          options,
        ),
      ).toThrow(
        /served by the optional catch-all "\/params\/optional\/\[\[\.\.\.rest\]\]", whose subtree pattern "\/params\/optional\/\*\*" routes "\/params\/optional" as well/,
      );
    });

    it("works under a basePath too", () => {
      const assigned = assign(
        [{ name: "shop", routes: ["/shop/**"] }],
        routes("/base/shop/[[...slug]]", "/base"),
        "/base",
      );
      expect(assigned.shop).toEqual(["/base/shop/[[...slug]]"]);
      expect(routedPatterns(["/shop/**"], assigned.shop, "base")).toEqual([
        "/shop/**",
        "/shop",
      ]);
    });

    it("routes a Pages Router optional catch-all's parent data URL", () => {
      // `/_next/data/<id>/shop.json` belongs to the same file, and the exact
      // `/shop` pattern `routedPatterns` adds carries it.
      const assigned = assign(
        [{ name: "shop", routes: ["/shop/**"] }],
        [
          {
            template: "/shop/[[...slug]]",
            entrypointId: "pages/shop/[[...slug]].js",
            type: "page",
          },
        ],
      );
      expect(assigned.shop).toEqual(["/shop/[[...slug]]"]);
    });
  });

  describe("one file behind several templates (C)", () => {
    // `app/[locale]/page.tsx` with root params: `/en` and `/de` are synthesized
    // from one output, alongside its own `/[locale]` template.
    const rootParams: RouteEntry[] = [
      "/[locale]",
      "/[locale].rsc",
      "/en",
      "/en.rsc",
      "/de",
      "/de.rsc",
    ].map((template) => ({
      template,
      entrypointId: "app/[locale]/page.js",
      type: "app-page",
    }));

    it("rejects a pattern that moves the file for one of its URLs", () => {
      // Only `en` got a behavior, so `/de` reached the default function, which
      // no longer had the file.
      expect(() =>
        assign([{ name: "intl", routes: ["/en"] }], rootParams),
      ).toThrow(
        /"app\/\[locale\]\/page\.js" is packaged into group "intl", but CloudFront would send "\/\[locale\]" to the "default" group, "\/de" to the "default" group/,
      );
      // And says the file cannot be grouped at all: `/[locale]` would need `/**`.
      expect(() =>
        assign([{ name: "intl", routes: ["/en", "/de"] }], rootParams),
      ).toThrow(/"\/\[locale\]" cannot be routed to any group/);
    });

    it("suggests the pattern that covers a static template it left behind", () => {
      const shared: RouteEntry[] = [
        { template: "/about", entrypointId: "shared.js" },
        { template: "/team", entrypointId: "shared.js" },
      ];
      expect(() => assign([{ name: "m", routes: ["/about"] }], shared)).toThrow(
        /Add "\/team" to group "m"'s routes/,
      );
      expect(
        assign([{ name: "m", routes: ["/about", "/team"] }], shared).m,
      ).toEqual(["/about", "/team"]);
    });

    it("checks the trailingSlash form, which exact patterns route", () => {
      const assigned = assign(
        [{ name: "p", routes: ["/pricing"] }],
        routes("/pricing"),
        "",
        { trailingSlash: true },
      );
      expect(assigned.p).toEqual(["/pricing"]);
    });

    it("puts an exact trailingSlash form ahead of a subtree it sits at the base of", () => {
      // `a/b/` and `a/b/*` have the same literal depth; were the subtree first
      // it would take `/a/b/` from group x.
      const assigned = assign(
        [
          { name: "x", routes: ["/a/b"] },
          { name: "y", routes: ["/a/b/**"] },
        ],
        routes("/", "/a/b", "/a/b/[id]"),
        "",
        { trailingSlash: true },
      );
      expect(assigned.x).toEqual(["/a/b"]);
      expect(assigned.y).toEqual(["/a/b/[id]"]);
    });

    it("gives a group without Pages Router routes no data URL behaviors", () => {
      // An App Router `/index` next to a Pages Router home page: a data behavior
      // for the group, `_next/data/<id>/index.json`, would be the home page's
      // data URL. The group owns no page, so it gets none.
      expect(
        assign(
          [{ name: "idx", routes: ["/index"] }],
          [
            { template: "/", entrypointId: "pages/index.js", type: "page" },
            {
              template: "/index",
              entrypointId: "app/index/page.js",
              type: "app-page",
            },
          ],
        ).idx,
      ).toEqual(["/index"]);
    });

    it("rejects a group pattern claiming a data URL of a file left in default", () => {
      // The same collision in a group that does own a page.
      expect(() =>
        assign(
          [{ name: "idx", routes: ["/index", "/legacy"] }],
          [
            { template: "/", entrypointId: "pages/index.js", type: "page" },
            {
              template: "/index",
              entrypointId: "app/index/page.js",
              type: "app-page",
            },
            {
              template: "/legacy",
              entrypointId: "pages/legacy.js",
              type: "page",
            },
          ],
        ),
      ).toThrow(
        /"pages\/index\.js" is packaged into the "default" group, but CloudFront would send "\/_next\/data\/abc123\/index\.json" to group "idx"/,
      );
    });
  });

  describe("interception routes (D)", () => {
    const photoApp = (): RouteEntry[] => [
      { template: "/feed", entrypointId: "app/feed/page.js", type: "app-page" },
      {
        template: "/feed/(..)photo/[id]",
        entrypointId: "app/feed/(..)photo/[id]/page.js",
        type: "app-page",
      },
      {
        template: "/feed/(..)photo/[id].rsc",
        entrypointId: "app/feed/(..)photo/[id]/page.js",
        type: "app-page",
      },
      {
        template: "/photo/[id]",
        entrypointId: "app/photo/[id]/page.js",
        type: "app-page",
      },
    ];

    it("packages an intercepting file with the URL it intercepts", () => {
      // The soft navigation requests `/photo/1`, which CloudFront sends to the
      // default function; Next.js rewrites it there to the intercepting file.
      const assigned = assign(
        [{ name: "feed", routes: ["/feed/**"] }],
        [
          ...photoApp(),
          { template: "/feed/[post]", entrypointId: "app/feed/[post]/page.js" },
        ],
      );
      expect(assigned.feed).toEqual(["/feed/[post]"]);
      expect(assigned[DEFAULT_FUNCTION_GROUP]).toContain(
        "/feed/(..)photo/[id]",
      );
      expect(assigned[DEFAULT_FUNCTION_GROUP]).toContain(
        "/feed/(..)photo/[id].rsc",
      );
    });

    it("follows the intercepted route into its group", () => {
      const assigned = assign(
        [{ name: "photos", routes: ["/photo/**"] }],
        photoApp(),
      );
      expect(assigned.photos).toEqual([
        "/feed/(..)photo/[id]",
        "/feed/(..)photo/[id].rsc",
        "/photo/[id]",
      ]);
    });

    it("throws when the intercepted URL space is split between groups", () => {
      expect(() =>
        assign(
          [{ name: "one", routes: ["/photo/1"] }],
          [
            ...photoApp(),
            { template: "/photo/1", entrypointId: "app/photo/1/page.js" },
          ],
        ),
      ).toThrow(
        /interception route "\/feed\/\(\.\.\)photo\/\[id\]".*group "one"'s pattern "\/photo\/1" claims part of it/s,
      );
    });

    it.each([
      ["/feed/(..)photo/[id]", "/photo/[id]"],
      ["/feed/(.)photo/[id]", "/feed/photo/[id]"],
      ["/(.)photo/[id]", "/photo/[id]"],
      ["/a/b/(..)(..)photo", "/photo"],
      ["/a/b/(...)photo", "/photo"],
      ["/photo/[id]", undefined],
    ])("resolves %p to the route it intercepts, %p", (path, expected) => {
      expect(interceptedRoute(path)).toBe(expected);
    });
  });

  describe("next.config rewrites (D)", () => {
    it("rejects a rewrite whose source and destination land in different groups", () => {
      // app-playground rewrites `/e2e/rewrite/:path(.*)` to `/e2e/rewrite/echo`.
      // Grouping only the destination leaves the source on the default
      // function, which then rewrites to a file it does not have.
      const { entries, options } = fixtureRoutes(appPlayground);
      expect(() =>
        assignRoutesToGroups(
          [{ name: "echo", routes: ["/e2e/rewrite/echo"] }],
          entries,
          options,
        ),
      ).toThrow(
        /rewrite from "\/e2e\/rewrite\/:path\(\.\*\)" to "\/e2e\/rewrite\/echo\?.*" crosses groups: CloudFront sends "\/e2e\/rewrite\/\[path\]" to the "default" group, and Next\.js then serves it with ".*echo\/page\.js", which is packaged into group "echo"/,
      );
      // Both ends in one group is fine.
      expect(
        assignRoutesToGroups(
          [{ name: "e2e", routes: ["/e2e/rewrite/**"] }],
          entries,
          options,
        ).templates.e2e,
      ).toContain("/e2e/rewrite/echo");
    });

    it("resolves a destination through Next.js's dynamic route rules", () => {
      const routing = {
        beforeFiles: [{ source: "/old", destination: "/blog/hello" }],
        dynamicRoutes: [
          {
            sourceRegex: "^/blog/([^/]+?)(?:/)?$",
            destination: "/blog/[slug]",
          },
        ],
      };
      expect(() =>
        assign(
          [{ name: "blog", routes: ["/blog/**"] }],
          routes("/blog/[slug]"),
          "",
          {
            routing,
          },
        ),
      ).toThrow(/CloudFront sends "\/old" to the "default" group/);
    });

    it("resolves a destination through a rule for a run of fallback shells", () => {
      // next 16.4's `collapseAdapterRoutes` folds `/en/[slug]` and
      // `/fr/[slug]` into one rule, with the matched prefix as `$1`.
      const routing = {
        beforeFiles: [{ source: "/old", destination: "/en/hello" }],
        dynamicRoutes: [
          {
            sourceRegex: "^/(en|fr)/(?<nxtPslug>[^/]+?)(?:/)?$",
            destination: "/$1/[slug]?nxtPslug=$nxtPslug",
          },
        ],
      };
      expect(() =>
        assign(
          [{ name: "en", routes: ["/en/**"] }],
          routes("/en/[slug]", "/fr/[slug]"),
          "",
          { routing },
        ),
      ).toThrow(/CloudFront sends "\/old" to the "default" group/);
    });

    it("skips an afterFiles source a route already serves, and parameterized destinations", () => {
      const routing = {
        // Never applied: `/pricing` is a route, and afterFiles yields to it.
        afterFiles: [{ source: "/pricing", destination: "/blog/x" }],
        // Not resolvable at synth.
        beforeFiles: [{ source: "/b/:slug", destination: "/blog/:slug" }],
      };
      expect(() =>
        assign(
          [{ name: "blog", routes: ["/blog/**"] }],
          routes("/blog/x", "/pricing"),
          "",
          { routing },
        ),
      ).not.toThrow();
    });

    it("checks the path an optional parameter leaves", () => {
      const routing = {
        beforeFiles: [{ source: "/docs/:path*", destination: "/docs-app" }],
      };
      expect(() =>
        assign(
          [{ name: "docs", routes: ["/docs/**", "/docs-app"] }],
          routes("/docs-app", "/docs/[page]"),
          "",
          { routing },
        ),
      ).toThrow(/CloudFront sends "\/docs" to the "default" group/);
    });
  });

  describe("a dynamic route's URL space (E)", () => {
    it("rejects a subtree capturing URLs a default-group catch-all serves", () => {
      // `/blog/[slug]` only matches one segment, so `/blog/a/b` reaches the
      // blog function via `blog/*` and resolves there to `/[...slug]`, which
      // the blog zip lacks. The template text itself never matched `blog/*`.
      expect(() =>
        assign(
          [{ name: "blog", routes: ["/blog/**"] }],
          routes("/", "/[...slug]", "/blog/[slug]"),
        ),
      ).toThrow(
        /"\/\[\.\.\.slug\]" is packaged into the "default" group, but CloudFront would send "\/blog\/_\/_" to group "blog" \(its pattern "\/blog\/\*\*"\).*dynamic route "\/\[\.\.\.slug\]"/s,
      );
    });

    it("checks under a basePath too", () => {
      expect(() =>
        assign(
          [{ name: "blog", routes: ["/blog/**"] }],
          routes("/base", "/base/[...slug]", "/base/blog/[slug]"),
          "/base",
        ),
      ).toThrow(/CloudFront would send "\/base\/blog\/_\/_" to group "blog"/);
    });

    it("accepts the capture when the group's own routes shadow every URL of it", () => {
      // A more specific route in the capturing group wins inside Next.js, so
      // with `/blog/[...rest]` there nothing under `/blog/` resolves to the
      // root catch-all.
      const assigned = assign(
        [{ name: "blog", routes: ["/blog/**"] }],
        routes("/", "/[...slug]", "/blog/[slug]", "/blog/[...rest]"),
      );
      expect(assigned[DEFAULT_FUNCTION_GROUP]).toEqual(["/", "/[...slug]"]);
      expect(assigned.blog).toEqual(["/blog/[...rest]", "/blog/[slug]"]);
    });

    it("accepts a single-segment root param, which never reaches under a subtree", () => {
      const assigned = assign(
        [{ name: "blog", routes: ["/blog/**"] }],
        routes("/", "/[slug]", "/blog/[slug]"),
      );
      expect(assigned[DEFAULT_FUNCTION_GROUP]).toEqual(["/", "/[slug]"]);
    });

    it("rejects the trailingSlash form of a subtree's base that a root param serves", () => {
      // `/blog/` matches `blog/*`, and with no `/blog` page Next.js serves it
      // with `/[slug]`.
      expect(() =>
        assign(
          [{ name: "blog", routes: ["/blog/**"] }],
          routes("/", "/[slug]", "/blog/[slug]"),
          "",
          { trailingSlash: true },
        ),
      ).toThrow(/CloudFront would send "\/blog\/" to group "blog"/);
    });

    it("lets a static first segment in the group outrank a param in a later one", () => {
      // `/blog/settings` reaches the blog function; `/blog/[slug]` beats
      // `/[team]/settings` there, static first segment before dynamic.
      expect(() =>
        assign(
          [{ name: "blog", routes: ["/blog/**"] }],
          routes("/", "/[team]/settings", "/blog/[slug]"),
        ),
      ).not.toThrow();
      // Without it, `/[team]/settings` is what Next.js resolves it to.
      expect(() =>
        assign(
          [{ name: "blog", routes: ["/blog/**"] }],
          routes("/", "/[team]/settings", "/blog/x"),
        ),
      ).toThrow(/"\/blog\/settings" to group "blog"/);
    });

    it("checks a root optional catch-all against subtree and exact patterns", () => {
      expect(() =>
        assign(
          [{ name: "docs", routes: ["/docs/**"] }],
          routes("/[[...slug]]", "/docs/[page]"),
        ),
      ).toThrow(/"\/docs\/_\/_" to group "docs"/);
      // An exact pattern owns a static route, which Next.js prefers.
      expect(
        assign(
          [{ name: "about", routes: ["/about"] }],
          routes("/[[...slug]]", "/about"),
        ).about,
      ).toEqual(["/about"]);
    });

    it("checks a grouped catch-all against a narrower group's subtree", () => {
      // `/api/reports/1/2` reaches the reports function, which only has
      // `/api/reports/[id]`; Next.js resolves it to `/api/[...rest]`.
      expect(() =>
        assign(
          [
            { name: "api", routes: ["/api/**"] },
            { name: "reports", routes: ["/api/reports/**"] },
          ],
          routes("/api/[...rest]", "/api/reports/[id]"),
        ),
      ).toThrow(
        /"\/api\/\[\.\.\.rest\]" is packaged into group "api", but CloudFront would send "\/api\/reports\/_\/_" to group "reports"/,
      );
    });

    it("checks a Pages Router catch-all's data URLs", () => {
      const page = (template: string, file: string): RouteEntry[] => [
        { template, entrypointId: file, type: "page" },
        {
          template: `/_next/data/${BUILD_ID}${template}.json`,
          entrypointId: file,
          type: "page",
        },
      ];
      expect(() =>
        assign(
          [{ name: "blog", routes: ["/blog/**"] }],
          [
            ...page("/[...slug]", "pages/[...slug].js"),
            ...page("/blog/[slug]", "pages/blog/[slug].js"),
          ],
        ),
      ).toThrow(/"\/_next\/data\/abc123\/blog\/_\/_\.json" to group "blog"/);
    });
  });

  describe("/index (G)", () => {
    it("groups an App Router /index, a route of its own", () => {
      const assigned = assign(
        [{ name: "idx", routes: ["/index"] }],
        [
          { template: "/", entrypointId: "app/page.js", type: "app-page" },
          {
            template: "/index.rsc",
            entrypointId: "app/page.js",
            type: "app-page",
          },
          {
            template: "/index",
            entrypointId: "app/index/page.js",
            type: "app-page",
          },
        ],
      );
      expect(assigned.idx).toEqual(["/index"]);
    });

    it("rejects the Pages Router home page, which is also /", () => {
      expect(() =>
        assign(
          [{ name: "idx", routes: ["/index"] }],
          ["/", "/index", `/_next/data/${BUILD_ID}/index.json`].map(
            (template) => ({
              template,
              entrypointId: "pages/index.js",
              type: "page",
            }),
          ),
        ),
      ).toThrow(/"\/" cannot be routed to any group.*"\/index": one file/s);
    });
  });
});

describe("routedPatterns", () => {
  it("adds nothing for a group without an optional catch-all at a subtree's base", () => {
    expect(
      routedPatterns(
        ["/blog/**", "/pricing"],
        ["/blog/[slug]", "/blog/x/[[...rest]]", "/pricing"],
        "",
      ),
    ).toEqual(["/blog/**", "/pricing"]);
  });

  it("does not repeat a parent the group already declares", () => {
    expect(
      routedPatterns(["/shop/**", "/shop"], ["/shop/[[...slug]]"], ""),
    ).toEqual(["/shop/**", "/shop"]);
  });
});

describe("pathPatternsFor", () => {
  it("drops the leading slash, because the distribution adds basePath itself", () => {
    expect(pathPatternsFor("/pricing", { hasDataRoutes: false })).toEqual([
      "pricing",
    ]);
  });

  it("turns a subtree into a single trailing wildcard", () => {
    expect(
      pathPatternsFor("/api/reports/**", { hasDataRoutes: false }),
    ).toEqual(["api/reports/*"]);
  });

  it("adds the `_next/data` URL space for Pages Router groups, on the literal build ID", () => {
    // A `*` for the build ID also matches `/`, so `_next/data/*/blog/*` claimed
    // `/_next/data/<id>/docs/blog/x.json`, a page of another group.
    const options = { hasDataRoutes: true, buildId: BUILD_ID };
    expect(pathPatternsFor("/blog/**", options)).toEqual([
      "blog/*",
      "_next/data/abc123/blog/*",
    ]);
    expect(pathPatternsFor("/pricing", options)).toEqual([
      "pricing",
      "_next/data/abc123/pricing.json",
    ]);
  });

  it("refuses to route data URLs without the build ID", () => {
    expect(() => pathPatternsFor("/blog/**", { hasDataRoutes: true })).toThrow(
      /needs its build ID/,
    );
  });

  it("refuses a build ID a path pattern cannot hold", () => {
    // `generateBuildId` can return anything.
    expect(() =>
      pathPatternsFor("/blog/**", { hasDataRoutes: true, buildId: "v1/2 3" }),
    ).toThrow(/The build ID "v1\/2 3" contains "\/", " "/);
  });

  it("adds the trailing-slash form for a trailingSlash app", async () => {
    // With `trailingSlash: true` the canonical URL is `/pricing/`, and that is
    // what every link in the app points at. A behavior on `pricing` alone does
    // not match it, so the request fell through to the default function - which
    // does not have the route packaged.
    expect(pathPatternsFor("/pricing", { hasDataRoutes: false })).toEqual([
      "pricing",
    ]);
    expect(
      pathPatternsFor("/pricing", {
        hasDataRoutes: false,
        trailingSlash: true,
      }),
    ).toEqual(["pricing", "pricing/"]);
  });

  it("leaves a subtree pattern alone, which already matches both forms", () => {
    expect(
      pathPatternsFor("/api/reports/**", {
        hasDataRoutes: false,
        trailingSlash: true,
      }),
    ).toEqual(["api/reports/*"]);
  });
});

describe("parseFunctionGroupsEnv", () => {
  it("returns undefined when unset", () => {
    expect(parseFunctionGroupsEnv(undefined)).toBeUndefined();
  });
});

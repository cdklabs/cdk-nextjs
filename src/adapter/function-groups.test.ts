import {
  DEFAULT_FUNCTION_GROUP,
  FunctionGroupSpec,
  RouteEntry,
  assignRoutesToGroups,
  pathPatternsFor,
  validateFunctionGroups,
} from "./function-groups";

/** One entrypoint per template unless a test says otherwise. */
const routes = (...templates: string[]): RouteEntry[] =>
  templates.map((template) => ({ template, entrypointId: template }));

const assign = (
  groups: FunctionGroupSpec[],
  entries: RouteEntry[],
  basePath = "",
) => assignRoutesToGroups(groups, entries, { basePath });

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

  it("rejects an empty path segment", () => {
    expect(() =>
      validateFunctionGroups([{ name: "a", routes: ["/api//x"] }]),
    ).toThrow(/empty path segment/);
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
        { template: "/blog/[slug]", entrypointId: "pages/blog/[slug]" },
        {
          template: "/_next/data/abc123/blog/[slug].json",
          entrypointId: "pages/blog/[slug]",
        },
        { template: "/", entrypointId: "pages/index" },
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

  it("adds the `_next/data` URL space for Pages Router groups", () => {
    expect(pathPatternsFor("/blog/**", { hasDataRoutes: true })).toEqual([
      "blog/*",
      "_next/data/*/blog/*",
    ]);
    expect(pathPatternsFor("/pricing", { hasDataRoutes: true })).toEqual([
      "pricing",
      "_next/data/*/pricing.json",
    ]);
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

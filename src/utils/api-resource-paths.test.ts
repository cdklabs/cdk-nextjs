import {
  API_PATH_PART,
  apiGroupRoutePaths,
  apiParentPaths,
  ApiRoutePath,
  apiResourcePaths,
  assertApiRoutable,
  assertNoApiPublicCollision,
} from "./api-resource-paths";
import { pathPatternsFor } from "../adapter/function-groups";

/** The behaviors the build would record for `routes`, as `NextjsApi` gets them. */
function behaviorsFor(
  group: string,
  routes: string[],
  options: { hasDataRoutes?: boolean; trailingSlash?: boolean } = {},
) {
  return routes.flatMap((route) =>
    pathPatternsFor(route, {
      hasDataRoutes: options.hasDataRoutes ?? false,
      trailingSlash: options.trailingSlash,
      buildId: "abc123",
    }).map((pattern) => ({ group, route, pattern })),
  );
}

/** Route paths from `"a/b/{proxy+}"`-style strings. */
function routePaths(
  ...entries: [path: string, owner: string][]
): ApiRoutePath<string>[] {
  return entries.map(([path, owner]) => ({ path: path.split("/"), owner }));
}

/** {@link apiGroupRoutePaths} with each owning group reduced to its name. */
function groupRoutePaths(
  ...args: Parameters<typeof apiGroupRoutePaths>
): ApiRoutePath<string>[] {
  return apiGroupRoutePaths(...args).map(({ path, owner }) => ({
    path,
    owner: owner.name,
  }));
}

describe("API_PATH_PART", () => {
  it("accepts what API Gateway accepts", () => {
    for (const part of ["api", "favicon.ico", "a-b_c", "x:y", "$id", "v1.2"]) {
      expect(API_PATH_PART.test(part)).toBe(true);
    }
  });

  it("rejects a space, `~`, `@`, quotes and non-ASCII", () => {
    for (const part of ["hello world.jpg", "a~b", "@x", `a"b`, "a'b", "ä"]) {
      expect(API_PATH_PART.test(part)).toBe(false);
    }
  });
});

describe("assertApiRoutable", () => {
  it("accepts subtree and exact routes", () => {
    expect(() => assertApiRoutable("/api/reports/**", "api")).not.toThrow();
    expect(() => assertApiRoutable("/pricing", "api")).not.toThrow();
  });

  it.each(["/a~b/**", "/@team/page", `/a"b`, "/docs/it's"])(
    "rejects %s, naming the group, the pattern and the segment",
    (route) => {
      const segment = route
        .replace(/\/\*\*$/, "")
        .split("/")
        .find((it) => it && !API_PATH_PART.test(it));
      expect(() => assertApiRoutable(route, "g")).toThrow(
        `functionGroups pattern "${route}" (group "g") has a segment, ` +
          `"${segment}", that an API Gateway resource path part cannot hold`,
      );
    },
  );

  it("does not count the `/**` suffix as a segment", () => {
    expect(() => assertApiRoutable("/docs/**", "g")).not.toThrow();
  });
});

describe("assertNoApiPublicCollision", () => {
  const dir = { name: "docs", isDirectory: true };
  const file = { name: "pricing", isDirectory: false };

  it("rejects a subtree on a public directory", () => {
    expect(() => assertNoApiPublicCollision("/docs/**", "g", [dir])).toThrow(
      `functionGroups pattern "/docs/**" (group "g") overlaps the top-level ` +
        `public/ directory "docs"`,
    );
  });

  it("rejects a route nested under a public directory", () => {
    expect(() => assertNoApiPublicCollision("/docs/guide", "g", [dir])).toThrow(
      `public/ directory "docs"`,
    );
    expect(() =>
      assertNoApiPublicCollision("/docs/guide/**", "g", [dir]),
    ).toThrow(`public/ directory "docs"`);
  });

  it("allows the exact path of a public directory", () => {
    // `docs` itself has no method; only `docs/{proxy+}` does.
    expect(() => assertNoApiPublicCollision("/docs", "g", [dir])).not.toThrow();
  });

  it("rejects an exact route on a public file", () => {
    expect(() => assertNoApiPublicCollision("/pricing", "g", [file])).toThrow(
      `functionGroups pattern "/pricing" (group "g") overlaps the top-level ` +
        `public/ file "pricing"`,
    );
  });

  it("allows a subtree or a nested route under a public file's name", () => {
    expect(() =>
      assertNoApiPublicCollision("/pricing/**", "g", [file]),
    ).not.toThrow();
    expect(() =>
      assertNoApiPublicCollision("/pricing/plans", "g", [file]),
    ).not.toThrow();
  });

  it("ignores entries the route does not start with", () => {
    expect(() =>
      assertNoApiPublicCollision("/blog/**", "g", [dir, file]),
    ).not.toThrow();
    expect(() =>
      assertNoApiPublicCollision("/api/docs/**", "g", [dir]),
    ).not.toThrow();
  });
});

describe("apiResourcePaths", () => {
  it("ends a subtree in `{proxy+}`", () => {
    expect(apiResourcePaths("/api/reports/**")).toEqual([
      ["api", "reports", "{proxy+}"],
    ]);
  });

  it("leaves an exact path as it is", () => {
    expect(apiResourcePaths("/a/b/c")).toEqual([["a", "b", "c"]]);
    expect(apiResourcePaths("/pricing", false)).toEqual([["pricing"]]);
  });

  it("adds a `{proxy+}` data path under `{buildId}` for a subtree", () => {
    expect(apiResourcePaths("/blog/**", true)).toEqual([
      ["blog", "{proxy+}"],
      ["_next", "data", "{buildId}", "blog", "{proxy+}"],
    ]);
  });

  it("adds a `.json` leaf for an exact path", () => {
    expect(apiResourcePaths("/pricing", true)).toEqual([
      ["pricing"],
      ["_next", "data", "{buildId}", "pricing.json"],
    ]);
  });

  it("keeps a nested exact path's parents in its data path", () => {
    expect(apiResourcePaths("/docs/guide/intro", true)).toEqual([
      ["docs", "guide", "intro"],
      ["_next", "data", "{buildId}", "docs", "guide", "intro.json"],
    ]);
  });
});

describe("apiGroupRoutePaths", () => {
  it("throws for a behavior routed to an unknown group", () => {
    expect(() =>
      apiGroupRoutePaths(
        [{ name: "a" }],
        [{ group: "nope", route: "/x/**", pattern: "x/*" }],
        [],
      ),
    ).toThrow(
      '`functionGroupBehaviors` routes to function group "nope", which is not ' +
        "in `functionGroups`.",
    );
  });

  it("gives each path the group object itself", () => {
    const group = { name: "g", extra: 1 };
    const [routePath] = apiGroupRoutePaths(
      [group],
      behaviorsFor("g", ["/pricing"]),
      [],
    );
    expect(routePath.owner).toBe(group);
  });

  it("lists each group's distinct routes in group order", () => {
    expect(
      groupRoutePaths(
        [{ name: "api" }, { name: "shop" }],
        [
          ...behaviorsFor("shop", ["/shop/**"]),
          ...behaviorsFor("api", ["/api/**", "/status"]),
        ],
        [],
      ),
    ).toEqual(
      routePaths(
        ["api/{proxy+}", "api"],
        ["status", "api"],
        ["shop/{proxy+}", "shop"],
      ),
    );
  });

  it("gives a `trailingSlash` form no path of its own", () => {
    // `pricing` and `pricing/` are two behaviors of one route.
    const behaviors = behaviorsFor("g", ["/pricing"], { trailingSlash: true });
    expect(behaviors.length).toBeGreaterThan(1);
    expect(groupRoutePaths([{ name: "g" }], behaviors, [])).toEqual(
      routePaths(["pricing", "g"]),
    );
  });

  it("adds data paths only for a group with data behaviors", () => {
    expect(
      groupRoutePaths(
        [{ name: "blog" }, { name: "app" }],
        [
          ...behaviorsFor("blog", ["/blog/**", "/blog"], {
            hasDataRoutes: true,
          }),
          ...behaviorsFor("app", ["/app/**"]),
        ],
        [],
      ),
    ).toEqual(
      routePaths(
        ["blog/{proxy+}", "blog"],
        ["_next/data/{buildId}/blog/{proxy+}", "blog"],
        ["blog", "blog"],
        ["_next/data/{buildId}/blog.json", "blog"],
        ["app/{proxy+}", "app"],
      ),
    );
  });

  it("checks each route against API Gateway and `public/`", () => {
    expect(() =>
      apiGroupRoutePaths([{ name: "g" }], behaviorsFor("g", ["/a~b/**"]), []),
    ).toThrow('segment, "a~b"');
    expect(() =>
      apiGroupRoutePaths([{ name: "g" }], behaviorsFor("g", ["/docs/**"]), [
        { name: "docs", isDirectory: true },
      ]),
    ).toThrow('public/ directory "docs"');
  });

  it("returns nothing without behaviors", () => {
    expect(apiGroupRoutePaths([{ name: "g" }], [], [])).toEqual([]);
  });
});

describe("apiParentPaths", () => {
  it("leaves a parent no subtree covers to the default function", () => {
    expect(
      apiParentPaths(routePaths(["api/reports/{proxy+}", "reports"])),
    ).toEqual([
      { path: ["api"], owner: undefined },
      { path: ["api", "reports"], owner: undefined },
    ]);
  });

  it("gives a parent under another group's subtree to that group", () => {
    expect(
      apiParentPaths(
        routePaths(
          ["api/{proxy+}", "api"],
          ["api/reports/{proxy+}", "reports"],
        ),
      ),
    ).toEqual([
      { path: ["api"], owner: undefined },
      { path: ["api", "reports"], owner: "api" },
    ]);
  });

  it("lets the deepest covering subtree win, whatever the order", () => {
    const expected = [
      { path: ["a"], owner: undefined },
      { path: ["a", "b"], owner: "a" },
      { path: ["a", "b", "c"], owner: "b" },
      { path: ["a", "b", "c", "d"], owner: "b" },
    ];
    const paths = routePaths(
      ["a/{proxy+}", "a"],
      ["a/b/{proxy+}", "b"],
      ["a/b/c/d/{proxy+}", "d"],
    );
    const sortByPath = (parents: typeof expected) =>
      [...parents].sort((x, y) => x.path.length - y.path.length);
    expect(apiParentPaths(paths)).toEqual(expected);
    expect(sortByPath(apiParentPaths([...paths].reverse()))).toEqual(expected);
  });

  it("does not let a subtree own its own base path", () => {
    // `/blog/**` owns what is under `/blog`, not `/blog` itself.
    expect(apiParentPaths(routePaths(["blog/x/{proxy+}", "blog"]))).toEqual([
      { path: ["blog"], owner: undefined },
      { path: ["blog", "x"], owner: undefined },
    ]);
  });

  it("does not count an exact route as covering anything", () => {
    expect(
      apiParentPaths(
        routePaths(["docs", "docs"], ["docs/guide/intro", "intro"]),
      ),
    ).toEqual([{ path: ["docs", "guide"], owner: undefined }]);
  });

  it("drops a parent that is also a route path, in either order", () => {
    expect(
      apiParentPaths(routePaths(["shop/{proxy+}", "a"], ["shop", "b"])),
    ).toEqual([]);
    expect(
      apiParentPaths(routePaths(["shop", "b"], ["shop/{proxy+}", "a"])),
    ).toEqual([]);
  });

  it("lists each parent once, in the order the routes first reach it", () => {
    expect(
      apiParentPaths(
        routePaths(
          ["x/y/{proxy+}", "g"],
          ["_next/data/{buildId}/x/{proxy+}", "g"],
          ["x/z/{proxy+}", "h"],
        ),
      ).map(({ path }) => path.join("/")),
    ).toEqual([
      "x",
      "x/y",
      "_next",
      "_next/data",
      "_next/data/{buildId}",
      "_next/data/{buildId}/x",
      "x/z",
    ]);
  });

  it("gives data parents to the group whose data subtree covers them", () => {
    expect(
      apiParentPaths(
        routePaths(
          ["_next/data/{buildId}/blog/{proxy+}", "blog"],
          ["_next/data/{buildId}/blog/x/{proxy+}", "x"],
        ),
      ).slice(-1),
    ).toEqual([
      { path: ["_next", "data", "{buildId}", "blog", "x"], owner: "blog" },
    ]);
  });

  it("returns nothing for top-level routes", () => {
    expect(apiParentPaths(routePaths(["pricing", "g"]))).toEqual([]);
    expect(apiParentPaths([])).toEqual([]);
  });
});

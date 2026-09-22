import {
  appPageCacheHeaders,
  groupPrerenders,
  prerenderPathToCacheKey,
} from "./cache-utils";

describe("prerenderPathToCacheKey", () => {
  it("drops the leading slash", () => {
    expect(prerenderPathToCacheKey("/ssg/1", "")).toBe("ssg/1");
  });

  it("maps the root route to index", () => {
    expect(prerenderPathToCacheKey("/", "")).toBe("index");
  });

  /**
   * The regression that made every prerender a MISS on a deployment with a
   * `basePath`: the seed wrote `prod/ssg/1.json` while the server, which sees the
   * path only after Next.js has stripped `basePath`, asked for `ssg/1.json`.
   */
  it("strips the app's basePath", () => {
    expect(prerenderPathToCacheKey("/prod/ssg/1", "/prod")).toBe("ssg/1");
  });

  it("maps the basePath root to index", () => {
    expect(prerenderPathToCacheKey("/prod", "/prod")).toBe("index");
  });

  it("only strips basePath on a path boundary", () => {
    expect(prerenderPathToCacheKey("/production/1", "/prod")).toBe(
      "production/1",
    );
  });
});

describe("groupPrerenders", () => {
  const at = (...pathnames: string[]) =>
    pathnames.map((pathname) => ({
      pathname,
    }));

  it("groups a route's html, rsc and segment outputs together", () => {
    const groups = groupPrerenders(
      at(
        "/blog/hello",
        "/blog/hello.rsc",
        "/blog/hello.segments/$c$.segment.rsc",
        "/blog/hello.segments/$c$/__PAGE__.segment.rsc",
      ),
    );
    expect(groups.size).toBe(1);
    const variants = groups.get("/blog/hello");
    expect(variants?.html?.pathname).toBe("/blog/hello");
    expect(variants?.rsc?.pathname).toBe("/blog/hello.rsc");
    expect(variants?.segments).toHaveLength(2);
  });

  /**
   * The regression: the root route's HTML is emitted as `/` but its flight payload
   * as `/index.rsc`, so grouping by a reconstructed `${route}.rsc` left `/` with no
   * `rscData` and every client-side navigation to the home page 404'd.
   */
  it("gives the root route the /index.rsc payload", () => {
    const groups = groupPrerenders(
      at("/", "/index.rsc", "/index.segments/$c$.segment.rsc"),
    );
    expect(Array.from(groups.keys())).toEqual(["/"]);
    expect(groups.get("/")?.rsc?.pathname).toBe("/index.rsc");
    expect(groups.get("/")?.segments).toHaveLength(1);
  });

  /** With a `basePath` the split is `/prod` vs `/prod/index`. */
  it("gives the basePath root its /index.rsc payload", () => {
    const groups = groupPrerenders(
      at("/prod", "/prod/index.rsc", "/prod/index.segments/$c$.segment.rsc"),
    );
    expect(Array.from(groups.keys())).toEqual(["/prod"]);
    expect(groups.get("/prod")?.rsc?.pathname).toBe("/prod/index.rsc");
    expect(groups.get("/prod")?.segments).toHaveLength(1);
  });

  /** An app with a real `app/index/page.tsx` keeps its own group. */
  it("leaves a genuine /index route alone", () => {
    const groups = groupPrerenders(at("/", "/index", "/index.rsc"));
    expect(Array.from(groups.keys()).sort()).toEqual(["/", "/index"]);
    expect(groups.get("/")?.rsc).toBeUndefined();
    expect(groups.get("/index")?.rsc?.pathname).toBe("/index.rsc");
  });

  /** `/nested/index.rsc` with no `/nested` HTML is its own route, not a remap. */
  it("only remaps when the parent really is a prerendered route", () => {
    const groups = groupPrerenders(at("/nested/index.rsc"));
    expect(Array.from(groups.keys())).toEqual(["/nested/index"]);
  });

  it("keeps segments whose route has no other output", () => {
    const groups = groupPrerenders(at("/ppr.segments/$c$.segment.rsc"));
    expect(groups.get("/ppr")?.segments).toHaveLength(1);
    expect(groups.get("/ppr")?.html).toBeUndefined();
  });
});

describe("appPageCacheHeaders", () => {
  /** Exactly what `onBuildComplete` is handed for a prerendered app page. */
  const initialHeaders = {
    vary: "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch",
    "content-type": "text/html; charset=utf-8",
    "x-nextjs-stale-time": "300",
    "x-nextjs-prerender": "1",
    "x-next-cache-tags": "_N_T_/layout,_N_T_/page,_N_T_/,_N_T_/index",
  };

  /**
   * The regression: a seeded `content-type: text/html` survives into the response
   * and `send-payload.js` will not overwrite it, so an RSC request to a
   * prerendered page gets the flight payload labeled as HTML.
   */
  it("drops content-type, which would mislabel every RSC response", () => {
    expect(appPageCacheHeaders(initialHeaders)).not.toHaveProperty(
      "content-type",
    );
  });

  it("keeps the headers a render would really have stored", () => {
    expect(appPageCacheHeaders(initialHeaders)).toEqual({
      "x-nextjs-stale-time": "300",
      "x-next-cache-tags": "_N_T_/layout,_N_T_/page,_N_T_/,_N_T_/index",
    });
  });

  it("drops the headers the entrypoint sets itself, which would double up", () => {
    const headers = appPageCacheHeaders({
      ...initialHeaders,
      "x-nextjs-postponed": "1",
    });
    expect(Object.keys(headers)).not.toContain("vary");
    expect(Object.keys(headers)).not.toContain("x-nextjs-prerender");
    expect(Object.keys(headers)).not.toContain("x-nextjs-postponed");
  });

  it("matches case-insensitively", () => {
    expect(appPageCacheHeaders({ "Content-Type": "text/html" })).toEqual({});
  });

  it("passes through anything the app set itself", () => {
    expect(
      appPageCacheHeaders({ "x-custom": "1", "set-cookie": "a=b" }),
    ).toEqual({ "x-custom": "1", "set-cookie": "a=b" });
  });
});

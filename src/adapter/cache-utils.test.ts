import { appPageCacheHeaders, prerenderPathToCacheKey } from "./cache-utils";

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

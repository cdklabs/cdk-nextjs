import { prerenderPathToCacheKey } from "./cache-utils";

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

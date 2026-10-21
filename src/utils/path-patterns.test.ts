import {
  assertNoPublicCollisions,
  getPathPattern,
  isPathPatternChar,
  MAX_PATH_PATTERN_LENGTH,
  publicPathPatterns,
  toPathPattern,
} from "./path-patterns";

describe("isPathPatternChar", () => {
  it("accepts literals and both wildcards", () => {
    for (const char of ["a", "Z", "0", "-", "_", ".", "/", "*", "?"]) {
      expect(isPathPatternChar(char)).toBe(true);
    }
  });

  it("rejects a space, `%` and non-ASCII", () => {
    for (const char of [" ", "%", "ä", "ф", "😀"]) {
      expect(isPathPatternChar(char)).toBe(false);
    }
  });
});

describe("toPathPattern", () => {
  it("leaves a name already in the alphabet alone", () => {
    expect(toPathPattern("favicon.ico")).toBe("favicon.ico");
  });

  it("replaces each character outside it with one `?` per UTF-8 byte", () => {
    expect(toPathPattern("hello world.jpg")).toBe("hello?world.jpg");
    // Two bytes each.
    expect(toPathPattern("äöüščří.png")).toBe("??????????????.png");
    // Three bytes, and an astral one of four: one `?` per byte, not per
    // UTF-16 unit.
    expect(toPathPattern("€")).toBe("???");
    expect(toPathPattern("😀.svg")).toBe("????.svg");
  });
});

describe("getPathPattern", () => {
  it("returns the pattern unchanged without a basePath", () => {
    expect(getPathPattern("", "_next/static*")).toBe("_next/static*");
  });

  it("prepends `/basePath/`, dropping the pattern's own leading slashes", () => {
    expect(getPathPattern("base", "_next/image*")).toBe("/base/_next/image*");
    expect(getPathPattern("base", "//docs/*")).toBe("/base/docs/*");
    expect(getPathPattern("a/b", "*")).toBe("/a/b/*");
  });

  it("keeps a trailing slash, so `pricing` and `pricing/` stay distinct", () => {
    expect(getPathPattern("base", "pricing")).toBe("/base/pricing");
    expect(getPathPattern("base", "pricing/")).toBe("/base/pricing/");
  });
});

describe("publicPathPatterns", () => {
  const entry = (name: string, isDirectory = false) => ({ name, isDirectory });

  it("adds `/*` to directories and the basePath to every pattern", () => {
    expect(
      publicPathPatterns([entry("favicon.ico"), entry("static", true)], "base"),
    ).toEqual({
      patterns: ["/base/favicon.ico", "/base/static/*"],
      unmatchable: [],
    });
  });

  it("leaves out an entry whose pattern would be wildcards alone", () => {
    expect(
      publicPathPatterns(
        [entry("фото", true), entry("äöü"), entry("фото.jpg")],
        "",
      ),
    ).toEqual({
      patterns: ["????????.jpg"],
      unmatchable: ["фото", "äöü"],
    });
  });

  it("counts the basePath and `/*` against the length limit", () => {
    // Fits on its own, and as a file at the root.
    const name = "a".repeat(MAX_PATH_PATTERN_LENGTH - 2);
    expect(publicPathPatterns([entry(name)], "").patterns).toEqual([name]);
    // `/*` takes it to 255 exactly: still fine.
    expect(publicPathPatterns([entry(name, true)], "").patterns).toEqual([
      `${name}/*`,
    ]);
    // A basePath tips it over.
    expect(() => publicPathPatterns([entry(name, true)], "b")).toThrow(
      `needs a ${MAX_PATH_PATTERN_LENGTH + 3}-character CloudFront path pattern`,
    );
  });

  it("measures the limit after `?` expansion", () => {
    // 128 characters, 256 bytes and so 256 `?`, one literal included.
    const name = `${"ä".repeat(127)}a`;
    expect(publicPathPatterns([entry(name)], "").patterns[0]).toHaveLength(255);
    expect(() => publicPathPatterns([entry(`${name}a`)], "")).toThrow(
      "needs a 256-character",
    );
  });
});

describe("assertNoPublicCollisions", () => {
  const behavior = (pathPattern: string, route = "/docs/**") => ({
    group: { name: "docs" },
    route,
    pathPattern,
  });

  it("accepts disjoint patterns", () => {
    expect(() =>
      assertNoPublicCollisions(
        ["/base/static/*", "/base/favicon.ico"],
        [behavior("/base/docs/*"), behavior("/base/docs")],
      ),
    ).not.toThrow();
  });

  it("refuses a group pattern a public/ entry already uses", () => {
    expect(() =>
      assertNoPublicCollisions(["docs/*"], [behavior("docs/*")]),
    ).toThrow(
      '`functionGroups` pattern "/docs/**" (group "docs") deploys as the ' +
        'path pattern "docs/*", which a top-level public/ entry already uses',
    );
  });

  it("refuses a group pattern under a public/ directory", () => {
    expect(() =>
      assertNoPublicCollisions(
        ["/base/docs/*"],
        [behavior("/base/docs/guide/*", "/docs/guide/**")],
      ),
    ).toThrow(
      'deploys as "/base/docs/guide/*", but the top-level public/ entry ' +
        'behind "/base/docs/*" is matched first',
    );
  });

  it("matches the `?` of a non-ASCII public/ name against a group pattern", () => {
    // `фото/` is `????????/*`, but `фото.jpg` keeps a literal: neither is
    // dropped by `publicPathPatterns`, and only a path of the same shape is
    // shadowed by one.
    expect(() =>
      assertNoPublicCollisions(
        ["????????.jpg"],
        [behavior("abcdefgh.jpg", "/abcdefgh.jpg")],
      ),
    ).toThrow('behind "????????.jpg" is matched first');
    expect(() =>
      assertNoPublicCollisions(
        ["????????.jpg"],
        [behavior("abc.jpg", "/abc.jpg")],
      ),
    ).not.toThrow();
  });
});

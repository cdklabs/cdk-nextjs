import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextjsType } from "../constants";
import {
  joinPath,
  normalizeBasePath,
  prefixWithBasePath,
  readNextConfigAssetPrefix,
  readNextConfigAssetPrefixPath,
  readNextConfigBasePath,
  resolveBasePath,
} from "./base-path";

const GLOBAL = [NextjsType.GLOBAL_FUNCTIONS, NextjsType.GLOBAL_CONTAINERS];

describe("normalizeBasePath", () => {
  it("reduces values addressing the same path to the same segment", () => {
    expect(normalizeBasePath("/base")).toBe("base");
    expect(normalizeBasePath("base")).toBe("base");
    expect(normalizeBasePath("/base/")).toBe("base");
    expect(normalizeBasePath("//base//")).toBe("base");
  });

  it("maps undefined and empty values to an empty string", () => {
    expect(normalizeBasePath(undefined)).toBe("");
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath("/")).toBe("");
  });

  it("keeps interior slashes of a nested basePath", () => {
    expect(normalizeBasePath("/team/app/")).toBe("team/app");
  });
});

describe("joinPath", () => {
  const origin = "https://d111111abcdef8.cloudfront.net";

  it("drops empty parts", () => {
    expect(joinPath(origin)).toBe(origin);
    expect(joinPath(origin, "")).toBe(origin);
    expect(joinPath(origin, undefined)).toBe(origin);
    expect(joinPath(origin, "/")).toBe(origin);
    expect(joinPath("", "base", undefined, "_next/static")).toBe(
      "base/_next/static",
    );
  });

  it("joins with exactly one slash regardless of each part's slashes", () => {
    expect(joinPath(origin, "/base")).toBe(`${origin}/base`);
    expect(joinPath(origin, "base/")).toBe(`${origin}/base`);
    expect(joinPath(origin, "/team/app/")).toBe(`${origin}/team/app`);
    expect(joinPath("/base/", "/_next/static/{key}")).toBe(
      "base/_next/static/{key}",
    );
  });

  it("returns an empty string when every part is empty", () => {
    expect(joinPath()).toBe("");
    expect(joinPath(undefined, "", "/")).toBe("");
  });

  // How `NextjsRegionalContainers.url` appends the app's basePath: the ALB
  // forwards every path to the container unchanged, so the app only answers
  // under its own basePath and the bare ALB URL would 404.
  it("appends an app basePath to a bare ALB origin", () => {
    const alb = "http://my-alb-123.us-east-1.elb.amazonaws.com";
    expect(joinPath(alb, "base")).toBe(`${alb}/base`);
    expect(joinPath(alb, "team/app")).toBe(`${alb}/team/app`);
    // An app with no basePath is served at the origin itself.
    expect(joinPath(alb, "")).toBe(alb);
  });
});

describe("prefixWithBasePath", () => {
  // The health check path is handed to things that talk to the app directly (an
  // ALB target group, the Lambda Web Adapter readiness check), and the app only
  // answers under its basePath. Unprefixed, every check 404s: the target never
  // turns healthy, so tasks are killed on the health check interval and the
  // deployment rolls back.
  it("prefixes a health check path with the app's basePath", () => {
    expect(prefixWithBasePath("base", "/api/health")).toBe("/base/api/health");
    expect(prefixWithBasePath("/base/", "/api/health")).toBe(
      "/base/api/health",
    );
  });

  it("leaves the path untouched when the app sets no basePath", () => {
    expect(prefixWithBasePath(undefined, "/api/health")).toBe("/api/health");
    expect(prefixWithBasePath("", "/api/health")).toBe("/api/health");
    expect(prefixWithBasePath("/", "/api/health")).toBe("/api/health");
  });

  it("always returns a leading slash, whatever the path came with", () => {
    // The ALB health check and the readiness check URL both need an absolute
    // path, so the result can't come back bare. Without a basePath a bare path
    // used to pass straight through, which concatenated into
    // "http://127.0.0.1:3000api/health" as the readiness check URL.
    expect(prefixWithBasePath("base", "api/health")).toBe("/base/api/health");
    expect(prefixWithBasePath(undefined, "api/health")).toBe("/api/health");
    expect(prefixWithBasePath("", "api/health")).toBe("/api/health");
  });

  // The path is what the app routes, without basePath, and it is prefixed
  // whether or not it already looks prefixed: an app can route "/base/base/..."
  // legitimately, so treating a leading "/base" as already-prefixed would make
  // that path unreachable and give the prop two meanings. Users who prefixed
  // `healthCheckPath` by hand to work around the missing prefix drop it on
  // upgrade — documented in docs/breaking-changes.md under 0.6.0.
  it("prefixes a path that already looks prefixed", () => {
    expect(prefixWithBasePath("base", "/base/api/health")).toBe(
      "/base/base/api/health",
    );
  });

  // A `trailingSlash: true` app redirects "/api/health" to "/api/health/" with a
  // 308, which an ALB health check doesn't count as healthy, so the slash the
  // user wrote has to survive.
  it("preserves a trailing slash", () => {
    expect(prefixWithBasePath("base", "/api/health/")).toBe(
      "/base/api/health/",
    );
    expect(prefixWithBasePath(undefined, "/api/health/")).toBe("/api/health/");
  });

  it("handles a nested basePath, as REGIONAL_FUNCTIONS can produce", () => {
    // An app at the `prod` stage nested under "/base" sets `basePath:
    // "/prod/base"`, and the readiness check hits the local server, so the
    // whole prefix has to be there.
    expect(prefixWithBasePath("/prod/base", "/api/health")).toBe(
      "/prod/base/api/health",
    );
  });
});

describe("readNextConfigBasePath", () => {
  let dotNextPath: string;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    dotNextPath = mkdtempSync(join(tmpdir(), "base-path-"));
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    rmSync(dotNextPath, { recursive: true, force: true });
  });

  function writeRequiredServerFiles(contents: string) {
    writeFileSync(join(dotNextPath, "required-server-files.json"), contents);
  }

  it("reads the app's basePath and strips the leading slash", () => {
    writeRequiredServerFiles(JSON.stringify({ config: { basePath: "/prod" } }));

    expect(readNextConfigBasePath(dotNextPath)).toBe("prod");
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns an empty string when the app sets no basePath", () => {
    // `next build` writes basePath: "" rather than omitting it.
    writeRequiredServerFiles(JSON.stringify({ config: { basePath: "" } }));

    expect(readNextConfigBasePath(dotNextPath)).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  // Degrading to "" is deliberate, but it's indistinguishable from an app that
  // sets no basePath, so it has to be visible: the Global constructs derive
  // their basePath from this value and would otherwise 404 every static asset
  // with nothing but a silent fallback to explain it.
  it("warns when required-server-files.json is missing", () => {
    expect(readNextConfigBasePath(dotNextPath)).toBe("");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("required-server-files.json"),
    );
  });

  it("warns when the file isn't valid JSON", () => {
    writeRequiredServerFiles("not json");

    expect(readNextConfigBasePath(dotNextPath)).toBe("");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not read basePath"),
    );
  });

  it("returns an empty string when the file has no config key", () => {
    writeRequiredServerFiles(JSON.stringify({ files: [] }));

    expect(readNextConfigBasePath(dotNextPath)).toBe("");
  });
});

describe("readNextConfigAssetPrefix", () => {
  let dotNextPath: string;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    dotNextPath = mkdtempSync(join(tmpdir(), "asset-prefix-"));
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    rmSync(dotNextPath, { recursive: true, force: true });
  });

  function write(config: unknown) {
    writeFileSync(
      join(dotNextPath, "required-server-files.json"),
      JSON.stringify({ config }),
    );
  }

  it("reads a path-style assetPrefix with one leading slash", () => {
    write({ assetPrefix: "/custom-asset-prefix" });
    expect(readNextConfigAssetPrefix(dotNextPath)).toBe("/custom-asset-prefix");
    write({ assetPrefix: "custom-asset-prefix/" });
    expect(readNextConfigAssetPrefix(dotNextPath)).toBe("/custom-asset-prefix");
    expect(warn).not.toHaveBeenCalled();
  });

  it("ignores an absolute assetPrefix", () => {
    // It names an origin cdk-nextjs does not serve, so there is no behavior to
    // add and nothing the distribution could get wrong.
    for (const assetPrefix of [
      "https://cdn.example.com",
      "http://cdn.example.com/x",
      "//cdn.example.com",
    ]) {
      write({ assetPrefix });
      expect(readNextConfigAssetPrefix(dotNextPath)).toBe("");
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns an empty string for every way of setting none", () => {
    for (const config of [
      { assetPrefix: "" },
      { assetPrefix: "/" },
      { assetPrefix: undefined },
      {},
      // `next build` has never written a non-string here, but the file is JSON
      // from another program's version of the schema.
      { assetPrefix: 3 },
    ]) {
      write(config);
      expect(readNextConfigAssetPrefix(dotNextPath)).toBe("");
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports the path an absolute assetPrefix carries, separately", () => {
    // `readNextConfigAssetPrefix` answers "is this a prefix the regional
    // NextjsTypes cannot serve"; `…Path` answers "what path do bundle URLs carry",
    // and an absolute prefix with a path carries one — `next build` compiles a
    // rewrite for it, so `next start` serves bundles there. See
    // `test/e2e/app-dir/asset-prefix-absolute`.
    for (const [assetPrefix, path] of [
      ["https://example.vercel.sh/custom-asset-prefix", "/custom-asset-prefix"],
      ["//example.vercel.sh/cdn/", "/cdn"],
      ["https://example.vercel.sh/", ""],
      ["https://example.vercel.sh", ""],
      ["/cdn", "/cdn"],
      ["", ""],
    ] as const) {
      write({ assetPrefix });
      expect(readNextConfigAssetPrefixPath(dotNextPath)).toBe(path);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays quiet when the file is missing, and warns when it is unreadable", () => {
    // `readNextConfigBasePath` reads the same file and already warns about it
    // being absent; a second warning on every synth of an app with no
    // `assetPrefix` would be noise. Unparseable is different — it means the file
    // is there and says something we could not understand.
    expect(readNextConfigAssetPrefix(dotNextPath)).toBe("");
    expect(warn).not.toHaveBeenCalled();

    writeFileSync(join(dotNextPath, "required-server-files.json"), "not json");
    expect(readNextConfigAssetPrefix(dotNextPath)).toBe("");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not read assetPrefix"),
    );
  });
});

describe("resolveBasePath", () => {
  describe.each(Object.values(NextjsType))("%s", (nextjsType) => {
    it("resolves to undefined when both are unset", () => {
      expect(resolveBasePath(nextjsType)).toBeUndefined();
      expect(resolveBasePath(nextjsType, "", "")).toBeUndefined();
      // Normalizes to empty, so it's the same as unset rather than a prefix.
      expect(resolveBasePath(nextjsType, "/")).toBeUndefined();
    });

    // One shape out, whatever shape came in: consumers that need a leading
    // slash (only `NextjsDistribution`'s path patterns) add their own, so
    // nothing downstream has to re-normalize.
    it("normalizes the prop when it matches the app", () => {
      expect(resolveBasePath(nextjsType, "/base", "/base")).toBe("base");
      expect(resolveBasePath(nextjsType, "base", "/base")).toBe("base");
      expect(resolveBasePath(nextjsType, "/base/", "/base")).toBe("base");
      expect(resolveBasePath(nextjsType, "base//", "/base")).toBe("base");
    });
  });

  describe.each(GLOBAL)("%s", (nextjsType) => {
    // CloudFront uses the request path verbatim as the S3 object key, so the
    // prop has to be the prefix the app emits — there's exactly one valid value,
    // which makes the app's config the source of truth.
    it("derives the prop from the app's basePath", () => {
      expect(resolveBasePath(nextjsType, undefined, "/base")).toBe("base");
      expect(resolveBasePath(nextjsType, "", "base")).toBe("base");
      expect(resolveBasePath(nextjsType, undefined, "/team/app/")).toBe(
        "team/app",
      );
    });

    it("rejects the prop setting a basePath the app doesn't", () => {
      expect(() => resolveBasePath(nextjsType, "/base")).toThrow(
        /CloudFront serves static assets straight from S3/,
      );
    });

    it("rejects two different values", () => {
      expect(() => resolveBasePath(nextjsType, "/a", "/b")).toThrow(
        'prop is "/a" but your Next.js app\'s config sets `basePath` to "/b"',
      );
    });
  });

  describe(NextjsType.REGIONAL_FUNCTIONS, () => {
    // API Gateway strips the stage before matching resources, so an app served
    // at the default `prod` stage sets basePath: "/prod" and leaves the prop
    // unset. Same shape as a custom domain base path mapping. Deriving here
    // would nest every resource under a path the stage already consumed.
    it("does not derive the app's basePath", () => {
      expect(
        resolveBasePath(NextjsType.REGIONAL_FUNCTIONS, undefined, "/prod"),
      ).toBeUndefined();
    });

    // The stripped prefix is part of what the app emits but never part of the
    // resource path, so an app at the `prod` stage nested under "/base" sets
    // basePath: "/prod/base" and the prop to "/base".
    it("accepts an app basePath that ends with the prop", () => {
      expect(
        resolveBasePath(NextjsType.REGIONAL_FUNCTIONS, "/base", "/prod/base"),
      ).toBe("base");
    });

    it("only accepts the prop as a whole trailing path segment", () => {
      expect(() =>
        resolveBasePath(NextjsType.REGIONAL_FUNCTIONS, "/se", "/prod/base"),
      ).toThrow(/nests every API Gateway resource under that path/);
      // Leading, not trailing: API Gateway strips the stage, so the app would
      // emit "/prod/..." while the resources live under "/prod/base/...".
      expect(() =>
        resolveBasePath(NextjsType.REGIONAL_FUNCTIONS, "/prod", "/prod/base"),
      ).toThrow(/nests every API Gateway resource under that path/);
    });

    // The reverse is never right: the prop nests every resource, including the
    // catch-all, under a path the app never links to.
    it("rejects the prop setting a basePath the app doesn't", () => {
      expect(() =>
        resolveBasePath(NextjsType.REGIONAL_FUNCTIONS, "/base"),
      ).toThrow(/nests every API Gateway resource under that path/);
    });

    it("rejects two different values", () => {
      expect(() =>
        resolveBasePath(NextjsType.REGIONAL_FUNCTIONS, "/a", "/b"),
      ).toThrow(/nests every API Gateway resource under that path/);
    });
  });

  describe(NextjsType.REGIONAL_CONTAINERS, () => {
    // basePath only namespaces the S3 bucket here: the ALB forwards every path
    // to the container, which serves its own static assets. So any combination
    // is valid, and the app's basePath is never derived into the bucket prefix.
    it("accepts any combination, always keeping the prop", () => {
      const nextjsType = NextjsType.REGIONAL_CONTAINERS;
      expect(resolveBasePath(nextjsType, "/a", "/b")).toBe("a");
      expect(resolveBasePath(nextjsType, "/a")).toBe("a");
      expect(resolveBasePath(nextjsType, undefined, "/b")).toBeUndefined();
    });
  });
});

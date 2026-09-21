import { NextjsType } from "../constants";
import { resolveBasePath } from "./resolve-base-path";

const GLOBAL = [NextjsType.GLOBAL_FUNCTIONS, NextjsType.GLOBAL_CONTAINERS];

describe("resolveBasePath", () => {
  describe.each(Object.values(NextjsType))("%s", (nextjsType) => {
    it("resolves to undefined when both are unset", () => {
      expect(resolveBasePath(nextjsType)).toBeUndefined();
      expect(resolveBasePath(nextjsType, "", "")).toBeUndefined();
      // Normalizes to empty, so it's the same as unset rather than a prefix.
      expect(resolveBasePath(nextjsType, "/")).toBeUndefined();
    });

    it("keeps the prop's leading slash (or lack of one) when it matches the app", () => {
      // Returning the prop rather than the normalized form keeps an existing
      // stack's cache behaviors and S3 keys from shifting shape.
      expect(resolveBasePath(nextjsType, "/base", "/base")).toBe("/base");
      expect(resolveBasePath(nextjsType, "base", "/base")).toBe("base");
    });

    // A trailing slash is the one part of the prop's shape that can't be kept:
    // `NextjsDistribution` would build "/base//_next/static*" from it while
    // `BucketDeployment` uploads the keys under "base/_next/...".
    it("trims a trailing slash off the prop", () => {
      expect(resolveBasePath(nextjsType, "/base/", "/base")).toBe("/base");
      expect(resolveBasePath(nextjsType, "base//", "/base")).toBe("base");
    });
  });

  describe.each(GLOBAL)("%s", (nextjsType) => {
    // CloudFront uses the request path verbatim as the S3 object key, so the
    // prop has to be the prefix the app emits — there's exactly one valid value,
    // which makes the app's config the source of truth.
    it("derives the prop from the app's basePath", () => {
      expect(resolveBasePath(nextjsType, undefined, "/base")).toBe("/base");
      expect(resolveBasePath(nextjsType, "", "base")).toBe("/base");
      expect(resolveBasePath(nextjsType, undefined, "/team/app/")).toBe(
        "/team/app",
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
      ).toBe("/base");
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
      expect(resolveBasePath(nextjsType, "/a", "/b")).toBe("/a");
      expect(resolveBasePath(nextjsType, "/a")).toBe("/a");
      expect(resolveBasePath(nextjsType, undefined, "/b")).toBeUndefined();
    });
  });
});

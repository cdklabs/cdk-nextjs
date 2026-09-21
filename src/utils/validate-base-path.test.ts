import { NextjsType } from "../constants";
import { validateBasePath } from "./validate-base-path";

const GLOBAL = [NextjsType.GLOBAL_FUNCTIONS, NextjsType.GLOBAL_CONTAINERS];

describe("validateBasePath", () => {
  describe.each(Object.values(NextjsType))("%s", (nextjsType) => {
    it("accepts both unset", () => {
      expect(() => validateBasePath(nextjsType)).not.toThrow();
      expect(() => validateBasePath(nextjsType, "", "")).not.toThrow();
    });

    it("accepts matching values", () => {
      expect(() =>
        validateBasePath(nextjsType, "/base", "/base"),
      ).not.toThrow();
    });

    it("compares normalized values, so surrounding slashes don't matter", () => {
      expect(() =>
        validateBasePath(nextjsType, "base/", "/base"),
      ).not.toThrow();
      expect(() => validateBasePath(nextjsType, "/", "")).not.toThrow();
    });
  });

  describe.each(GLOBAL)("%s", (nextjsType) => {
    // CloudFront uses the request path verbatim as the S3 object key, so the
    // prop is also the key prefix and has to be the prefix the app emits.
    it("rejects the app setting a basePath the prop doesn't", () => {
      expect(() => validateBasePath(nextjsType, undefined, "/base")).toThrow(
        'prop is unset but your Next.js app\'s config sets `basePath` to "/base"',
      );
    });

    it("rejects the prop setting a basePath the app doesn't", () => {
      expect(() => validateBasePath(nextjsType, "/base")).toThrow(
        /CloudFront serves static assets straight from S3/,
      );
    });

    it("rejects two different values", () => {
      expect(() => validateBasePath(nextjsType, "/a", "/b")).toThrow(
        'prop is "/a" but your Next.js app\'s config sets `basePath` to "/b"',
      );
    });
  });

  describe(NextjsType.REGIONAL_FUNCTIONS, () => {
    // API Gateway strips the stage before matching resources, so an app served
    // at the default `prod` stage sets basePath: "/prod" and leaves the prop
    // unset. Same shape as a custom domain base path mapping.
    it("accepts the app setting a basePath the prop doesn't", () => {
      expect(() =>
        validateBasePath(NextjsType.REGIONAL_FUNCTIONS, undefined, "/prod"),
      ).not.toThrow();
    });

    // The reverse is never right: the prop nests every resource, including the
    // catch-all, under a path the app never links to.
    it("rejects the prop setting a basePath the app doesn't", () => {
      expect(() =>
        validateBasePath(NextjsType.REGIONAL_FUNCTIONS, "/base"),
      ).toThrow(/nests every API Gateway resource under that path/);
    });

    it("rejects two different values", () => {
      expect(() =>
        validateBasePath(NextjsType.REGIONAL_FUNCTIONS, "/a", "/b"),
      ).toThrow(/nests every API Gateway resource under that path/);
    });
  });

  describe(NextjsType.REGIONAL_CONTAINERS, () => {
    // basePath only namespaces the S3 bucket here: the ALB forwards every path
    // to the container, which serves its own static assets.
    it("accepts any combination", () => {
      const nextjsType = NextjsType.REGIONAL_CONTAINERS;
      expect(() => validateBasePath(nextjsType, "/a", "/b")).not.toThrow();
      expect(() => validateBasePath(nextjsType, "/a")).not.toThrow();
      expect(() => validateBasePath(nextjsType, undefined, "/b")).not.toThrow();
    });
  });
});

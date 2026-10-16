import { Duration, Token } from "aws-cdk-lib";
import {
  DISABLED_CACHE_KEY,
  DYNAMIC_CACHE_KEY,
  isCachingDisabled,
} from "./cache-keys";

describe("isCachingDisabled", () => {
  const zero = Duration.seconds(0);

  it("is false without overrides or without a `maxTtl`", () => {
    expect(isCachingDisabled(undefined)).toBe(false);
    expect(isCachingDisabled({})).toBe(false);
    // CDK's `maxTtl` default is a year, so the zeros below it still cache.
    expect(isCachingDisabled({ defaultTtl: zero, minTtl: zero })).toBe(false);
  });

  it("is true when every TTL given is 0", () => {
    expect(isCachingDisabled({ maxTtl: zero })).toBe(true);
    expect(isCachingDisabled({ maxTtl: zero, defaultTtl: zero })).toBe(true);
    expect(
      isCachingDisabled({ maxTtl: zero, defaultTtl: zero, minTtl: zero }),
    ).toBe(true);
  });

  it("is false when a TTL CDK raises `maxTtl` to is above 0", () => {
    expect(
      isCachingDisabled({ maxTtl: zero, defaultTtl: Duration.hours(1) }),
    ).toBe(false);
    expect(
      isCachingDisabled({ maxTtl: zero, minTtl: Duration.seconds(1) }),
    ).toBe(false);
  });

  it("is false when a TTL is a token, which might not be 0", () => {
    const token = Duration.seconds(Token.asNumber({ resolve: () => 0 }));
    expect(isCachingDisabled({ maxTtl: token })).toBe(false);
    expect(isCachingDisabled({ maxTtl: zero, defaultTtl: token })).toBe(false);
  });
});

describe("cache keys", () => {
  it("keys the dynamic policy on headers, cookies, query strings and encodings", () => {
    expect(DYNAMIC_CACHE_KEY.headerBehavior.headers).toEqual([
      "accept",
      "rsc",
      "next-url",
      "next-router-state-tree",
      "next-router-prefetch",
      "next-router-segment-prefetch",
      "x-prerender-revalidate",
    ]);
    expect(DYNAMIC_CACHE_KEY.cookieBehavior.behavior).toBe("all");
    expect(DYNAMIC_CACHE_KEY.queryStringBehavior.behavior).toBe("all");
    expect(DYNAMIC_CACHE_KEY.enableAcceptEncodingBrotli).toBe(true);
    expect(DYNAMIC_CACHE_KEY.enableAcceptEncodingGzip).toBe(true);
  });

  it("keys the disabled policy on nothing", () => {
    expect(DISABLED_CACHE_KEY.headerBehavior.behavior).toBe("none");
    expect(DISABLED_CACHE_KEY.cookieBehavior.behavior).toBe("none");
    expect(DISABLED_CACHE_KEY.queryStringBehavior.behavior).toBe("none");
    expect(DISABLED_CACHE_KEY.enableAcceptEncodingBrotli).toBe(false);
    expect(DISABLED_CACHE_KEY.enableAcceptEncodingGzip).toBe(false);
  });
});

import { Token } from "aws-cdk-lib";
import {
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CachePolicyProps,
  CacheQueryStringBehavior,
} from "aws-cdk-lib/aws-cloudfront";

/**
 * Whether `dynamicCachePolicyProps` turns the dynamic cache off, by capping every
 * TTL at 0.
 *
 * CloudFront rejects a policy that caches nothing but still has a cache key
 * ("HeaderBehavior is invalid for policy with caching disabled"), so such a
 * policy has to drop the key. Until the default TTL became 0 this could not
 * come up: CDK raises `maxTtl` to `defaultTtl` when it is lower, so an override
 * of `maxTtl: 0` synthesized as a day and deployed. Now it is honored, and
 * without this the upgrade deploy would fail.
 *
 * The TTLs are resolved the way CDK resolves them: `defaultTtl` raised to
 * `minTtl`, then `maxTtl` raised to `defaultTtl`. Checking `maxTtl` alone called
 * `{ maxTtl: 0, defaultTtl: 1h }` disabled, dropped the key, and CDK then
 * synthesized a policy that caches for an hour keyed on nothing — one viewer's
 * page served to every viewer.
 */
export function isCachingDisabled(
  props: CachePolicyProps | undefined,
): boolean {
  const ttls = [props?.maxTtl, props?.defaultTtl, props?.minTtl];
  if (props?.maxTtl === undefined) return false; // CDK's default is a year
  return ttls.every(
    (ttl) =>
      ttl === undefined ||
      (!Token.isUnresolved(ttl.toString()) && ttl.toSeconds() === 0),
  );
}

/** The cache-key half of {@link CachePolicyProps}. */
export interface CacheKeyProps {
  readonly queryStringBehavior: CacheQueryStringBehavior;
  readonly headerBehavior: CacheHeaderBehavior;
  readonly cookieBehavior: CacheCookieBehavior;
  readonly enableAcceptEncodingBrotli: boolean;
  readonly enableAcceptEncodingGzip: boolean;
}

/**
 * What the dynamic cache policy keys on: every request input a Next.js response
 * varies by.
 */
export const DYNAMIC_CACHE_KEY: CacheKeyProps = {
  queryStringBehavior: CacheQueryStringBehavior.all(),
  headerBehavior: CacheHeaderBehavior.allowList(
    // Every request header Next.js varies a cacheable response on: the headers
    // it lists in `Vary`, plus `accept` and `x-prerender-revalidate`. That is 7
    // of the 10 a cache policy allows by default
    // (https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-policies).
    // The spare slots are not waste: each header added splits the cache.
    "accept", // content negotiation (HTML vs RSC payload)
    "rsc", // React Server Components requests
    "next-url", // interception routes
    "next-router-state-tree", // App Router navigation state
    "next-router-prefetch", // prefetch behavior
    "next-router-segment-prefetch", // segment-level prefetching
    "x-prerender-revalidate", // on-demand ISR revalidation
    // Headers Next.js reads but that are left out on purpose:
    // - `x-prerender-revalidate-if-generated` only travels with
    //   `x-prerender-revalidate`, so it would split nothing viewers share.
    // - `next-action` and `content-type` are only on server action POSTs,
    //   which CloudFront does not cache.
    // - `x-middleware-prefetch` and `sec-fetch-dest` only change responses
    //   Next.js sends `no-store`. `x-nextjs-data` follows from the
    //   `/_next/data/` URL.
    // - `user-agent`: HTML-limited bots get a blocking render, but only where
    //   the response is not shared-cacheable, and keying on it would make
    //   nearly every request a miss.
    // Draft mode needs no header: it is the `__prerender_bypass` cookie, which
    // `cookieBehavior.all()` already keys on.
  ),
  cookieBehavior: CacheCookieBehavior.all(),
  enableAcceptEncodingBrotli: true,
  enableAcceptEncodingGzip: true,
};

/**
 * A cache key of nothing, for a policy that caches nothing. Forwarding is
 * unaffected: the dynamic origin request policy sends every viewer header,
 * cookie and query string regardless.
 */
export const DISABLED_CACHE_KEY: CacheKeyProps = {
  queryStringBehavior: CacheQueryStringBehavior.none(),
  headerBehavior: CacheHeaderBehavior.none(),
  cookieBehavior: CacheCookieBehavior.none(),
  enableAcceptEncodingBrotli: false,
  enableAcceptEncodingGzip: false,
};

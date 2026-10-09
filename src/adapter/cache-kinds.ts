/* eslint-disable import/no-extraneous-dependencies */
import type { CachedRouteKind } from "next/dist/server/response-cache/index.js";
import type { PrerenderVariants } from "./cache-utils";

/**
 * The `CachedRouteKind` members the init cache seeds, as their own string
 * values. The enum is a `const enum`, which esbuild can't inline, so using it
 * as a value put a runtime `import` of `next/dist/server/response-cache` in the
 * adapter bundle; only its type is imported now.
 */
export const CACHED_ROUTE_KIND = {
  APP_PAGE: "APP_PAGE" as CachedRouteKind.APP_PAGE,
  APP_ROUTE: "APP_ROUTE" as CachedRouteKind.APP_ROUTE,
  PAGES: "PAGES" as CachedRouteKind.PAGES,
} as const;

/** The fields of `ctx.outputs` a cache kind is read from. */
export interface CacheKindOutputs {
  readonly pages: ReadonlyArray<{ id: string }>;
  readonly appPages: ReadonlyArray<{ id: string }>;
  readonly appRoutes: ReadonlyArray<{ id: string }>;
}

/**
 * Returns which kind of cache entry to seed for one prerendered route, or
 * `undefined` for a route whose owner writes no response-cache entry.
 *
 * Read from the prerender's `parentOutputId`, which `next build` sets to the
 * `id` of the output that renders it — not by matching the pathname against
 * route templates. Matching had to reimplement Next's dynamic-segment grammar
 * and got it wrong twice: it required as many segments as the template had, so
 * no `[...slug]` or `[[...rest]]` prerender ever got a kind and every one was a
 * MISS on first request; and it knew the Pages Router home page only as the
 * `/index` its output reports, while its HTML prerender is grouped under `/`, so
 * that page was never seeded either. The parent link has neither problem, and it
 * cannot hand a prerender to the wrong one of two templates that both match its
 * pathname (`/about` against an app route `/[slug]`).
 */
export function cacheKindResolver(
  outputs: CacheKindOutputs,
): (
  variants: PrerenderVariants<{ parentOutputId: string }>,
) => CachedRouteKind | undefined {
  const kindById = new Map<string, CachedRouteKind>();
  for (const { id } of outputs.pages) {
    kindById.set(id, CACHED_ROUTE_KIND.PAGES);
  }
  for (const { id } of outputs.appPages) {
    kindById.set(id, CACHED_ROUTE_KIND.APP_PAGE);
  }
  for (const { id } of outputs.appRoutes) {
    kindById.set(id, CACHED_ROUTE_KIND.APP_ROUTE);
  }
  return (variants) => {
    const source =
      variants.html ?? variants.rsc ?? variants.data ?? variants.segments[0];
    return source ? kindById.get(source.parentOutputId) : undefined;
  };
}

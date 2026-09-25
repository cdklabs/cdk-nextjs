/* eslint-disable import/no-extraneous-dependencies */
import { CachedRouteKind } from "next/dist/server/response-cache/index.js";
import type { PrerenderVariants } from "./cache-utils";

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
    kindById.set(id, CachedRouteKind.PAGES);
  }
  for (const { id } of outputs.appPages) {
    kindById.set(id, CachedRouteKind.APP_PAGE);
  }
  for (const { id } of outputs.appRoutes) {
    kindById.set(id, CachedRouteKind.APP_ROUTE);
  }
  return (variants) => {
    const source =
      variants.html ?? variants.rsc ?? variants.data ?? variants.segments[0];
    return source ? kindById.get(source.parentOutputId) : undefined;
  };
}

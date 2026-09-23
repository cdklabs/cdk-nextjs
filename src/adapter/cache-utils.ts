/*
  Shared cache utility functions
*/
import type {
  SetIncrementalFetchCacheContext,
  SetIncrementalResponseCacheContext,
} from "next/dist/server/response-cache";

/**
 * Pre-process value to convert Buffers and Maps before JSON.stringify
 * This is necessary because Buffer.toJSON() is called before replacer functions
 */
function preprocessValue(value: any): any {
  // Handle null/undefined
  if (value == null) {
    return value;
  }

  // Convert Buffer to our custom format. base64, not the array of per-byte
  // integers this used to write (and that `Buffer.toJSON()` writes) — see
  // {@link parseCacheValue} for why that mattered so much.
  if (Buffer.isBuffer(value)) {
    return {
      __type: "Buffer",
      base64: value.toString("base64"),
    };
  }

  // Convert Map to our custom format
  if (value instanceof Map) {
    const entries: Record<string, any> = {};
    for (const [key, val] of value.entries()) {
      entries[key] = preprocessValue(val);
    }
    return {
      __type: "Map",
      data: entries,
    };
  }

  // Recursively process arrays
  if (Array.isArray(value)) {
    return value.map((item) => preprocessValue(item));
  }

  // Recursively process objects
  if (typeof value === "object") {
    const processed: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) {
      processed[key] = preprocessValue(val);
    }
    return processed;
  }

  // Return primitives as-is
  return value;
}

/**
 * Serialize cache value with custom handling for Map and Buffer objects
 */
export function serializeCacheValue(value: any): string {
  // Pre-process to convert Buffers and Maps before JSON.stringify
  // This ensures Buffer.toJSON() doesn't interfere
  const processed = preprocessValue(value);
  return JSON.stringify(processed);
}

/**
 * Parse cache value with custom handling for Map and Buffer objects
 *
 * Buffers are read back from base64 when that is how they were written, and from
 * an array of per-byte integers when they were not. That array is the format
 * `Buffer.toJSON()` produces and the one this code used to write, and it is
 * ruinous for a page with a large payload: a 1 MiB prerender became ~3 MiB of
 * JSON text, an 11.6 MiB cache entry once html and the per-segment copies are
 * counted, and — because `JSON.parse`'s reviver runs for *every array element* —
 * upwards of three million reviver calls to read one page. Measured against a
 * deployment: 4.8s of Lambda time to answer a 1 MiB segment prefetch, against
 * 45ms for a small one from the same cache. base64 is 4/3 the bytes rather than
 * ~3x, and `Buffer.from(str, "base64")` is one native call.
 */
export function parseCacheValue(jsonString: string): any {
  return JSON.parse(jsonString, (_key, val) => {
    // Restore Map objects that were serialized with __type marker
    if (val && typeof val === "object" && val.__type === "Map") {
      return new Map(Object.entries(val.data));
    }
    // Restore Buffer objects that were serialized with __type marker (our custom format)
    if (val && typeof val === "object" && val.__type === "Buffer") {
      return typeof val.base64 === "string"
        ? Buffer.from(val.base64, "base64")
        : Buffer.from(val.data);
    }
    // Restore Buffer objects that were serialized with Node.js default Buffer.toJSON() format
    // This handles legacy cache entries or runtime-generated entries
    if (
      val &&
      typeof val === "object" &&
      val.type === "Buffer" &&
      Array.isArray(val.data)
    ) {
      return Buffer.from(val.data);
    }
    return val;
  });
}

/**
 * The cache key a prerendered route's seeded entry has to be written under.
 *
 * `ctx.outputs.prerenders[].pathname` is the *URL* the page is served at, so it
 * carries the app's `basePath`. The key the server later looks entries up under
 * is the route, which does not — Next.js strips `basePath` before routing, so the
 * cache handler never sees it at request time. Seeding `/prod/ssg/1` verbatim
 * therefore writes `<buildId>/prod/ssg/1.json` while the server asks for
 * `<buildId>/ssg/1.json`: every build-time prerender is a MISS that re-renders on
 * first request, and the page is only "static" from the second visit onwards.
 */
export function prerenderPathToCacheKey(
  pathname: string,
  basePath: string,
): string {
  // Matching on a path boundary so a sibling route like `/production` is not
  // read as basePath `/prod` plus `uction`.
  const hasBasePath =
    !!basePath &&
    (pathname === basePath || pathname.startsWith(`${basePath}/`));
  const route = (hasBasePath ? pathname.slice(basePath.length) : pathname)
    // Leading slashes would make an S3 key with an empty first segment.
    .replace(/^\/+/, "");
  return route === "" ? "index" : route;
}

/** The outputs one route contributes to `ctx.outputs.prerenders`. */
export interface PrerenderVariants<T> {
  /** The HTML render. Its pathname is the route, with no suffix. */
  html?: T;
  /** The flight payload, built as `<route>.rsc` — but see {@link groupPrerenders}. */
  rsc?: T;
  /** Per-segment flight payloads, under `<route>.segments/`. */
  segments: T[];
  /** A Pages Router route's `pageData`, built as its `/_next/data/` route. */
  data?: T;
}

const INDEX_SUFFIX = "/index";

/**
 * A Pages Router data route: `/_next/data/<buildId>/<page>.json`, optionally
 * behind a `basePath` (`normalizePathname` in Next.js's `build-complete` prefixes
 * every output pathname, this one included).
 *
 * Capture 1 is that prefix and capture 2 the page path without its `.json`, so
 * `/prod/_next/data/abc123/blog/hello.json` recomposes to `/prod/blog/hello`.
 */
const PAGES_DATA_PATHNAME = /^(.*)\/_next\/data\/[^/]+\/(.+)\.json$/;

/**
 * Collect `ctx.outputs.prerenders` into one entry per route.
 *
 * Next.js emits up to three shapes per prerendered App Router route — `/blog/hello`,
 * `/blog/hello.rsc`, and `/blog/hello.segments/*.segment.rsc` — and a cache entry
 * needs all of them together, so they have to be grouped by route before anything
 * can be seeded. A Pages Router route emits two: the HTML, and its `pageData` at
 * the route's `/_next/data/<buildId>/<page>.json` pathname
 * ({@link PAGES_DATA_PATHNAME}). That one is not a suffix of the page's own
 * pathname, so it is matched rather than stripped.
 *
 * The one case that is not a suffix strip is the **root route**, which cannot be
 * named `/.rsc`: its payloads are emitted under `/index.rsc` and
 * `/index.segments/` while its HTML stays at `/` (or at the `basePath`, e.g.
 * `/prod` and `/prod/index.rsc`). Reconstructing names by concatenation therefore
 * silently loses the home page's `rscData` — and with a `basePath` also its
 * `segmentData`, because `/prod` and `/prod/index` group apart. That is not a
 * cosmetic gap: `app-page-runtime.js` answers an RSC request for an entry with no
 * `rscData` by checking `cachedData.html.contentType`, and under `cacheComponents`
 * sends an empty `404`. Every client-side navigation to `/` breaks.
 *
 * The remap is conditional rather than unconditional so that an app with a real
 * page at `app/index/page.tsx` — whose HTML prerender genuinely is `/index` — keeps
 * its own group.
 */
export function groupPrerenders<T extends { pathname: string }>(
  prerenders: T[],
): Map<string, PrerenderVariants<T>> {
  const htmlPathnames = new Set(
    prerenders
      .map((p) => p.pathname)
      .filter(
        (p) =>
          !p.endsWith(".rsc") &&
          !p.includes(".segments/") &&
          !PAGES_DATA_PATHNAME.test(p),
      ),
  );
  const groups = new Map<string, PrerenderVariants<T>>();

  const variantsFor = (base: string): PrerenderVariants<T> => {
    let variants = groups.get(base);
    if (!variants) {
      variants = { segments: [] };
      groups.set(base, variants);
    }
    return variants;
  };

  /** `/index.rsc` belongs to `/`, `/prod/index.rsc` to `/prod`. */
  const routeOf = (base: string): string => {
    if (base.endsWith(INDEX_SUFFIX) && !htmlPathnames.has(base)) {
      const parent = base.slice(0, -INDEX_SUFFIX.length) || "/";
      if (htmlPathnames.has(parent)) {
        return parent;
      }
    }
    return base;
  };

  for (const prerender of prerenders) {
    const { pathname } = prerender;
    const dataRoute = PAGES_DATA_PATHNAME.exec(pathname);
    if (dataRoute) {
      variantsFor(routeOf(`${dataRoute[1]}/${dataRoute[2]}`)).data = prerender;
    } else if (pathname.includes(".segments/")) {
      variantsFor(routeOf(pathname.split(".segments/")[0])).segments.push(
        prerender,
      );
    } else if (pathname.endsWith(".rsc")) {
      variantsFor(routeOf(pathname.slice(0, -".rsc".length))).rsc = prerender;
    } else {
      variantsFor(pathname).html = prerender;
    }
  }

  return groups;
}

/**
 * Headers that must not be seeded into an `APP_PAGE` cache entry, even though the
 * adapter output lists them in `fallback.initialHeaders`.
 *
 * `initialHeaders` describes how a platform should serve the prerendered *file*
 * straight off a CDN. A cache entry is a different thing: `app-page-runtime.js`
 * `appendHeader`s `cachedData.headers` onto the response and *then* serves the
 * variant the request actually asked for, so anything presentational in there is
 * either wrong or doubled. At request time Next.js stores only what the render
 * put in `metadata.headers` — `x-nextjs-stale-time`, `x-next-cache-tags`, and
 * whatever the app set through `headers()`/`cookies()` — and never these four.
 *
 * `content-type` is the one that actually breaks. `send-payload.js` sets the type
 * only when the response does not already have one
 * (`if (!res.getHeader('Content-Type') && result.contentType)`), so a seeded
 * `text/html; charset=utf-8` makes every RSC request to a prerendered page answer
 * the flight payload labeled as HTML. The client router rejects that, and so does
 * Next.js itself: `createRedirectRenderResult` checks the content type of the
 * sub-response it fetches to stream an action `redirect()`, and on a mismatch
 * cancels the body and returns an empty result.
 *
 * `vary`, `x-nextjs-prerender`, and `x-nextjs-postponed` are all set by the
 * entrypoint itself, so seeding them only produces two of each.
 *
 * `APP_ROUTE` entries are deliberately *not* filtered: a route handler's
 * `content-type` is part of its cached response, and `app-route.js` replays those
 * headers verbatim.
 */
const NON_CACHEABLE_APP_PAGE_HEADERS = new Set([
  "content-type",
  "vary",
  "x-nextjs-prerender",
  "x-nextjs-postponed",
]);

/** See {@link NON_CACHEABLE_APP_PAGE_HEADERS}. */
export function appPageCacheHeaders<T>(
  initialHeaders: Record<string, T>,
): Record<string, T> {
  const headers: Record<string, T> = {};
  for (const [name, value] of Object.entries(initialHeaders)) {
    if (!NON_CACHEABLE_APP_PAGE_HEADERS.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }
  return headers;
}

/** `NEXT_CACHE_TAGS_HEADER`, inlined so this file imports no Next.js internals. */
export const NEXT_CACHE_TAGS_HEADER = "x-next-cache-tags";

/**
 * Name of the file the adapter writes into the init cache directory mapping each
 * cache tag to the cache keys of the build-time prerenders carrying it.
 *
 * It rides to S3 with the rest of the init cache, and the post-deploy custom
 * resource turns it into the DynamoDB `tag#cacheKey` rows a runtime `set` would
 * have written. Without those rows `revalidateTag` knows a prerender is stale
 * (see `checkIfRevalidated`) but not which CloudFront paths to invalidate, so
 * the CDN keeps serving the old response until its TTL expires - a year, for a
 * prerender.
 *
 * The leading underscore keeps it clear of cache keys, which are route paths.
 */
export const INIT_CACHE_TAG_MANIFEST = "_cdk-nextjs-tag-manifest.json";

/** Contents of {@link INIT_CACHE_TAG_MANIFEST}: tag -> init cache keys. */
export type InitCacheTagManifest = Record<string, string[]>;

/**
 * Helper to safely extract tags from context
 */
export function getTags(
  ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext,
): string[] | undefined {
  return "tags" in ctx ? ctx.tags : undefined;
}

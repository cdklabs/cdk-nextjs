/*
  Shared cache utility functions
*/
import { createHash } from "node:crypto";
import { sep } from "node:path";
import type { CacheHandler } from "next/dist/server/lib/incremental-cache";
import { hasPathPrefix } from "../utils/base-path";

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
  const route = (
    hasPathPrefix(pathname, basePath)
      ? pathname.slice(basePath.length)
      : pathname
  )
    // Leading slashes would make an S3 key with an empty first segment.
    .replace(/^\/+/, "");
  return route === "" ? "index" : route;
}

/** `buildS3Key` under the build prefix: `{cacheKey}.json`. */
export function cacheKeyFileName(cacheKey: string): string {
  let cleanCacheKey = cacheKey;
  if (cacheKey === "/" || cacheKey === "") {
    cleanCacheKey = "index";
  } else if (cacheKey.startsWith("/")) {
    cleanCacheKey = cacheKey.slice(1);
  }
  return `${cleanCacheKey}.json`;
}

/** `value`'s SHA-256 digest, in hex: 64 characters. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** S3's limit on an object key, in UTF-8 bytes. */
const MAX_S3_KEY_BYTES = 1024;

/**
 * The longest build ID cache entries are stored under, which
 * {@link cacheObjectName} leaves room for in front of it with its `/`: a
 * Next.js build ID is 21 characters, and the `-<deploymentId>` cdk-nextjs
 * appends is the app's own, so the adapter fails a build whose ID is longer
 * (see `assertBuildIdFits`) rather than leave long names unwritable.
 */
export const MAX_BUILD_ID_BYTES = 127;

/**
 * The folder under the build prefix that entries with an over-long key are
 * stored in. @see cacheObjectName
 */
export const LONG_KEY_PREFIX = "_long-key";

/**
 * Where the entry `buildS3Key` names is stored, under the build prefix:
 * its own name, or `_long-key/{sha256}.long` for a name that would leave the
 * whole object key past S3's 1024 bytes. next 16.3.8's route-scoped keys are
 * ~88 bytes longer than a pathname, enough to push a long one over, and a
 * rejected `PutObject` meant the page was never cached.
 *
 * Only the object is moved: `buildS3Key` stays the entry's name for tag
 * mappings and CloudFront paths, since a hash names no route. Decided on the
 * name alone rather than the whole key so the init cache, which is written
 * without the build ID it is deployed under, files a seed where the runtime
 * reads it. The `.long` suffix keeps these disjoint from every `.json` name.
 */
export function cacheObjectName(cacheKey: string): string {
  const name = cacheKeyFileName(cacheKey);
  if (Buffer.byteLength(name) <= MAX_S3_KEY_BYTES - (MAX_BUILD_ID_BYTES + 1)) {
    return name;
  }
  return `${LONG_KEY_PREFIX}/${sha256Hex(name)}.long`;
}

/**
 * The response-cache key next >= 16.3.8 stores a prerender under, read back off
 * the file `next build` wrote it to, or `undefined` before 16.3.8.
 *
 * From 16.3.8 Next.js scopes every page's cache key by its source route -
 * `/route-cache/<kind>/<sha256(sourceRoute)>/$<pathname>` (`getRouteCacheKey`
 * in `next/dist/server/lib/route-cache-key.js`) - and, with an adapter, writes
 * each prerender to `<distDir>/server/<key><ext>`. The file path is the only
 * place an adapter is handed that key, and re-deriving it would mean re-picking
 * the source route the way `build-complete.js` does.
 */
export function routeCacheKeyFromFilePath(
  filePath: string | undefined,
): string | undefined {
  // The first `/server/route-cache/`: a route's own pathname can contain one
  // after it. Before 16.3.8 a route of that name is all there is, which the
  // prefix check below rejects.
  const path = filePath?.split(sep).join("/");
  const at = path?.indexOf(ROUTE_CACHE_DIR) ?? -1;
  if (at < 0) {
    return undefined;
  }
  const key = path!.slice(at + "/server/".length).replace(/\.[^./]+$/, "");
  return ROUTE_CACHE_KEY_PREFIX.test(key) ? key : undefined;
}

const ROUTE_CACHE_DIR = "/server/route-cache/";

/**
 * The start of a next >= 16.3.8 response-cache key, leading slash dropped:
 * `route-cache/<kind>/<sha256(sourceRoute)>/$` (`getRouteCacheKey`), followed
 * by the pathname. Matched whole, so an older app's route that happens to be
 * named `/route-cache/...` is not read as one.
 */
export const ROUTE_CACHE_KEY_PREFIX =
  /^route-cache\/[A-Z_]+\/[0-9a-f]{64}\/\$(?=\/)/;

/**
 * `denormalizePagePath` (`next/dist/shared/lib/page-path/denormalize-page-path.js`),
 * the inverse of the `normalizePagePath` a route-cache key's pathname goes
 * through: `/index` back to `/`, and `/index/...` - how `/index` itself and
 * every path under it are spelled - back to `/...`. Restated without its
 * dynamic-route check: `s3KeyToInvalidationPath` has dropped those already.
 */
export function denormalizePagePath(pagePath: string): string {
  if (pagePath === "/index") {
    return "/";
  }
  return pagePath.startsWith("/index/")
    ? pagePath.slice("/index".length)
    : pagePath;
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
const NEXT_CACHE_TAGS_HEADER = "x-next-cache-tags";

/**
 * The tags a cache value's render was tagged with, as Next.js records them: in
 * its `x-next-cache-tags` header, comma separated, including the implicit
 * `_N_T_/…` path chain `revalidatePath` uses. One parser for the build's tag
 * manifest and the runtime's mapping rows, which have to agree.
 *
 * `value` is `unknown` because it arrives both as a stored entry read back from
 * S3 and as the `IncrementalCacheValue` union; only some members have headers.
 */
export function headerTags(value: unknown): string[] {
  const headers = (value as { headers?: Record<string, unknown> } | null)
    ?.headers;
  const header = headers?.[NEXT_CACHE_TAGS_HEADER];
  return typeof header === "string" ? header.split(",").filter(Boolean) : [];
}

/**
 * Name of the file the adapter writes into the init cache directory mapping each
 * cache tag to the cache keys of the build-time prerenders carrying it.
 *
 * It rides to S3 with the rest of the init cache, and `S3CacheHandler`'s
 * `revalidateTag` reads it alongside the `tag#cacheKey` rows a runtime `set`
 * writes. Without it `revalidateTag` knows a prerender is stale (see
 * `checkIfRevalidated`) but not which CloudFront paths to invalidate, so the CDN
 * keeps serving the old response until its TTL expires - a year, for a
 * prerender.
 *
 * The leading underscore keeps it clear of cache keys, which are route paths.
 */
export const INIT_CACHE_TAG_MANIFEST = "_cdk-nextjs-tag-manifest.json";

/** Contents of {@link INIT_CACHE_TAG_MANIFEST}: tag -> init cache keys. */
export type InitCacheTagManifest = Record<string, string[]>;

/**
 * The `ctx` Next.js passes a `CacheHandler`'s `get`, taken off its interface:
 * the fetch cache's, a route response's, or - since this handler is also
 * `ImageOptimizerCache`'s - an optimized image's.
 */
export type GetCacheHandlerContext = Parameters<CacheHandler["get"]>[1];

/** The `ctx` Next.js passes a `CacheHandler`'s `set`. See {@link GetCacheHandlerContext}. */
export type SetCacheHandlerContext = Parameters<CacheHandler["set"]>[2];

/**
 * Helper to safely extract tags from context
 */
export function getTags(ctx: SetCacheHandlerContext): string[] | undefined {
  return "tags" in ctx ? ctx.tags : undefined;
}

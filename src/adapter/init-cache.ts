/* eslint-disable import/no-extraneous-dependencies */
/**
 * The init cache: one response-cache entry per prerendered route, written by
 * `onBuildComplete` and seeded into S3 at deploy, so a fresh
 * deployment starts with what `next build` rendered instead of a cold cache.
 *
 * Separate from `adapter.mts` only so it can be tested without loading the
 * adapter itself (which resolves cdk-nextjs's own handlers off `import.meta`).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import getDebug from "debug";
import { CacheHandlerValue } from "next/dist/server/lib/incremental-cache";
import { CachedRouteKind } from "next/dist/server/response-cache/index.js";
import { LOG_PREFIX } from "../constants";
import type { BuildCompleteContext } from "./build-outputs";
import { cacheKindResolver } from "./cache-kinds";
import {
  appPageCacheHeaders,
  cacheObjectName,
  groupPrerenders,
  headerTags,
  INIT_CACHE_TAG_MANIFEST,
  InitCacheTagManifest,
  prerenderPathToCacheKey,
  routeCacheKeyFromFilePath,
  serializeCacheValue,
} from "./cache-utils";

const debug = getDebug("cdk-nextjs:adapter");

/**
 * Write a `<cacheKey>.json` per prerendered route under `cacheDir`, plus
 * {@link INIT_CACHE_TAG_MANIFEST} when any entry carries tags.
 */
export async function writeInitCache(
  ctx: Pick<
    BuildCompleteContext,
    "config" | "outputs" | "nextVersion" | "projectDir"
  >,
  cacheDir: string,
): Promise<void> {
  // Ensure cache directory exists
  await mkdir(cacheDir, { recursive: true });
  debug(`Init cache directory: ${cacheDir}`);

  // One entry per route, with its HTML, `.rsc` and segment outputs together
  const prerenderGroups = groupPrerenders(ctx.outputs.prerenders);
  debug(`Prerender groups: ${prerenderGroups.size} groups`);

  const cacheKindOf = cacheKindResolver(ctx.outputs);

  // Tag -> cache keys, standing in for the mapping rows a runtime `set` writes.
  // See `INIT_CACHE_TAG_MANIFEST`.
  const tagManifest: InitCacheTagManifest = {};

  // Routes seeded under their pathname by a `next` that reads route-cache keys:
  // see the `cacheKey` below.
  const scopesKeysByRoute = nextScopesKeysByRoute(ctx.projectDir);
  const unscopedRoutes: string[] = [];

  // Process each group and create cache entries
  for (const [basePath, variants] of prerenderGroups) {
    try {
      // A dynamic route template — `/[lang]/[slug]` — is not a dead entry: with
      // PPR it is the route's *fallback shell*, and the server looks it up in
      // the cache under exactly that key. `app-page-runtime` reads
      // `prerenderManifest.dynamicRoutes[route].fallback` (the literal template
      // string) and calls `handleResponse({ cacheKey, isFallback: true })`; the
      // Pages Router does the same with `srcPage` for an ISR fallback. Skipping
      // these groups made every such lookup a MISS, so the shell was rendered
      // per request instead of resumed from the build - visible in
      // `test/e2e/app-dir/sub-shell-generation`, where a `'use cache'` root
      // layout reported `(runtime)` where next start reports `(buildtime)`.
      //
      // A Pages Router template is seeded for the same reason: in production
      // its fill function only returns what the cache already holds, so with
      // nothing seeded there is no `fallback: true` shell to serve and
      // `router.isFallback` is never true (`test/e2e/fallback-route-params`).
      // Nothing extra is needed to keep non-PPR templates out: a route with no
      // shell emits no prerender output.
      const kind = cacheKindOf(variants);
      if (!kind) {
        debug(`SKIP: No route kind found for ${basePath}`);
        continue;
      }

      debug(`Processing ${basePath} (${kind})`);

      const {
        html: htmlPrerender,
        rsc: rscPrerender,
        segments: segmentPrerenders,
        data: dataPrerender,
      } = variants;

      if (!htmlPrerender && !rscPrerender && !dataPrerender) {
        debug(`SKIP: No prerender files found for ${basePath}`);
        continue; // Skip if we don't have the main files
      }

      // Create cache entry with the appropriate structure based on kind
      let cacheEntry: CacheHandlerValue;

      if (kind === CachedRouteKind.APP_PAGE) {
        // Read HTML file
        const html = await readPrerenderAsText(htmlPrerender);

        if (!html) {
          debug(`SKIP: No HTML content for APP_PAGE ${basePath}`);
          continue; // Skip if no HTML content
        }

        // Read RSC data
        const rscData = await readPrerenderAsBuffer(rscPrerender);

        // Read segment data
        const segmentData = await getSegmentData(segmentPrerenders);

        // Extract headers from the HTML or RSC prerender
        const headers = appPageCacheHeaders(
          htmlPrerender?.fallback?.initialHeaders ||
            rscPrerender?.fallback?.initialHeaders ||
            {},
        );

        cacheEntry = {
          lastModified: Date.now(),
          value: {
            kind: CachedRouteKind.APP_PAGE,
            html,
            rscData,
            headers,
            segmentData: segmentData,
            // postponedState from fallback appears to be the React postponed state
            // which matches what the cache expects for postponed
            postponed: htmlPrerender?.fallback?.postponedState,
            // initialStatus from prerender is the HTTP status of the prerendered page
            status: htmlPrerender?.fallback?.initialStatus,
          },
        };
      } else if (kind === CachedRouteKind.APP_ROUTE) {
        const body = await readPrerenderAsBuffer(htmlPrerender);

        if (!body) {
          debug(`SKIP: No body content for APP_ROUTE ${basePath}`);
          continue; // Skip if no content
        }

        // Extract headers
        const headers = htmlPrerender?.fallback?.initialHeaders || {};

        cacheEntry = {
          lastModified: Date.now(),
          value: {
            kind: CachedRouteKind.APP_ROUTE,
            body,
            headers,
            status: htmlPrerender?.fallback?.initialStatus || 200,
          },
        };
      } else if (kind === CachedRouteKind.PAGES) {
        // A build-time `notFound: true`. Next.js reports the route as
        // prerendered and hands us a prerender whose `filePath` is
        // `pages/404.html` and whose `initialStatus` is 404 - but it writes
        // *no* output for it (no `first.html`, `.json` or `.meta`), because a
        // Pages Router `notFound` is represented in the cache as an entry
        // whose `value` is `null` (`pages-handler.ts`, "isNotFound in
        // metadata"), and `FileSystemCache.set` keeps a null value in its LRU
        // only, never on disk. So `next start` misses, re-runs
        // `getStaticProps`, and answers 404 from `render404()`.
        //
        // Seeding it as an ordinary `PAGES` entry made that a 200: the entry
        // is a HIT carrying the 404 page's HTML, and the pages handler never
        // reads `value.status` on the HIT path, so the status stayed 200 while
        // the body said "404 page". Skipping it restores the miss, and with it
        // `next start`'s status. Costs one render per revalidate window, which
        // is what `next start` pays too.
        const initialStatus = htmlPrerender?.fallback?.initialStatus;
        if (initialStatus !== undefined && initialStatus !== 200) {
          debug(
            `SKIP: PAGES ${basePath} prerendered with status ${initialStatus} (build-time notFound)`,
          );
          continue;
        }

        const html = await readPrerenderAsText(htmlPrerender);

        if (!html) {
          debug(`SKIP: No HTML content for PAGES ${basePath}`);
          continue;
        }

        // `getStaticProps`' result, which the entrypoint answers
        // `/_next/data/<buildId>/<page>.json` with and the client router reads
        // on a navigation. A route's *fallback* template has no data file -
        // there are no params to run `getStaticProps` with yet - and
        // `FileSystemCache` skips the read for one too (`if (!ctx.isFallback)`),
        // leaving `pageData` an empty object.
        const pageDataJson = await readPrerenderAsText(dataPrerender);

        cacheEntry = {
          lastModified: Date.now(),
          value: {
            kind: CachedRouteKind.PAGES,
            html,
            pageData: pageDataJson ? JSON.parse(pageDataJson) : {},
            // Both `undefined`, which is what `FileSystemCache` hands back for
            // a `PAGES` entry: it reads a `.meta` sidecar for the App Router
            // kinds only, and `sendRenderResult` supplies the content type.
            // Seeding `fallback.initialHeaders` instead would put
            // `content-type: text/html` on the JSON data responses served from
            // this same entry.
            headers: undefined,
            status: undefined,
          },
        };
      } else {
        // Skip unsupported kinds
        debug(`SKIP: Unsupported route kind ${kind} for ${basePath}`);
        continue;
      }

      // Write cache entry to file, under the key Next.js reads it back with:
      // from next 16.3.8 the one `next build` filed the prerender under (see
      // `routeCacheKeyFromFilePath`), before that the route rather than the
      // URL it is served at (see `prerenderPathToCacheKey`).
      // Every kind seeded here has read its HTML prerender, so that is the
      // file to read the key off.
      const routeCacheKey = routeCacheKeyFromFilePath(
        prerenderFilePath(htmlPrerender),
      );
      if (!routeCacheKey && scopesKeysByRoute) unscopedRoutes.push(basePath);
      const cacheKey =
        routeCacheKey ??
        prerenderPathToCacheKey(basePath, ctx.config.basePath || "");
      const cacheFilePath = join(cacheDir, cacheObjectName(cacheKey));

      // Ensure parent directory exists
      await mkdir(dirname(cacheFilePath), { recursive: true });

      await writeFile(cacheFilePath, serializeCacheValue(cacheEntry));

      for (const tag of headerTags(cacheEntry.value)) {
        (tagManifest[tag] ??= []).push(cacheKey);
      }

      debug(`Created cache entry: ${cacheFilePath}`);
    } catch (error) {
      console.error(`Error processing prerender group ${basePath}:`, error);
    }
  }

  // A pathname key is one 16.3.8+ never reads, so each of these is a MISS
  // until it is first rendered - the regression the route-cache key fixed.
  if (unscopedRoutes.length > 0) {
    console.warn(
      `${LOG_PREFIX} Next.js ${ctx.nextVersion} wrote ${unscopedRoutes.length} ` +
        `prerender(s) outside <distDir>/server/route-cache/, so they were ` +
        `seeded under their pathname, which it does not read: ` +
        `${unscopedRoutes.slice(0, 5).join(", ")}` +
        `${unscopedRoutes.length > 5 ? ", ..." : ""}`,
    );
  }

  const taggedKeys = Object.keys(tagManifest).length;
  if (taggedKeys > 0) {
    await writeFile(
      join(cacheDir, INIT_CACHE_TAG_MANIFEST),
      JSON.stringify(tagManifest),
    );
    debug(`Wrote ${INIT_CACHE_TAG_MANIFEST} with ${taggedKeys} tags`);
  }
}

/**
 * Whether the app's `next` scopes response-cache keys by source route (16.3.8
 * on), found by whether it has the module that derives them, since a canary's
 * version says nothing of what it contains.
 */
function nextScopesKeysByRoute(projectDir: string): boolean {
  try {
    createRequire(join(projectDir, "package.json")).resolve(
      "next/dist/server/lib/route-cache-key.js",
    );
    return true;
  } catch {
    return false;
  }
}

/** The file `next build` wrote a prerender to, if it wrote one. */
function prerenderFilePath(
  prerender:
    | { fallback?: { filePath?: string } | { postponedState: string } }
    | undefined,
): string | undefined {
  return prerender?.fallback && "filePath" in prerender.fallback
    ? prerender.fallback.filePath
    : undefined;
}

/**
 * Read file content from a prerender as UTF-8 string
 */
async function readPrerenderAsText(
  prerender:
    | { fallback?: { filePath?: string } | { postponedState: string } }
    | undefined,
): Promise<string | undefined> {
  const filePath = prerenderFilePath(prerender);
  return filePath && existsSync(filePath)
    ? readFile(filePath, "utf-8")
    : undefined;
}

/**
 * Read file content from a prerender as Buffer
 */
async function readPrerenderAsBuffer(
  prerender:
    | { fallback?: { filePath?: string } | { postponedState: string } }
    | undefined,
): Promise<Buffer | undefined> {
  const filePath = prerenderFilePath(prerender);
  return filePath && existsSync(filePath) ? readFile(filePath) : undefined;
}

/**
 * Read segment data from segment prerenders
 */
async function getSegmentData<
  T extends {
    pathname: string;
    fallback?: { filePath?: string } | { postponedState: string };
  },
>(segmentPrerenders: T[]): Promise<Map<string, Buffer>> {
  const segmentData = new Map<string, Buffer>();

  for (const segmentPrerender of segmentPrerenders) {
    const filePath = prerenderFilePath(segmentPrerender);
    if (filePath && existsSync(filePath)) {
      const segmentContent = await readFile(filePath);
      // Extract segment name from pathname
      const segmentName =
        "/" +
        segmentPrerender.pathname
          .split(".segments/")[1]
          .replace(/\.segment\.rsc$/, "");
      segmentData.set(segmentName, segmentContent);
    }
  }

  return segmentData;
}

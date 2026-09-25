/* eslint-disable import/no-extraneous-dependencies */
import { NextAdapter } from "next";
import { CacheHandlerValue } from "next/dist/server/lib/incremental-cache";
import { CachedRouteKind } from "next/dist/server/response-cache/index.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  appPageCacheHeaders,
  groupPrerenders,
  prerenderPathToCacheKey,
  serializeCacheValue,
  INIT_CACHE_TAG_MANIFEST,
  InitCacheTagManifest,
  NEXT_CACHE_TAGS_HEADER,
} from "./cache-utils.js";
import { writeBuildOutputs } from "./build-outputs.js";
import { cacheKindResolver } from "./cache-kinds.js";
import { LOG_PREFIX } from "../constants.js";
import getDebug from "debug";

const debug = getDebug("cdk-nextjs:adapter");

const adapter: NextAdapter = {
  name: "cdk-nextjs-adapter",
  async modifyConfig(config, { phase }) {
    if (phase === "phase-production-build") {
      return {
        ...config,
        // No `output: "standalone"`. `onBuildComplete` stages the deployment
        // root from the same NFT traces `writeStandaloneDirectory` would have
        // used, so the two are alternatives rather than layers — `next build`
        // says as much itself, immediately above the `onBuildComplete` call:
        // "in the future `output: standalone` might not be allowed if an adapter
        // with `onBuildComplete` is configured."
        cacheHandler: config.cacheHandler
          ? config.cacheHandler
          : fileURLToPath(import.meta.resolve("cdk-nextjs/cache-handler")),
        images: {
          ...config.images,
          customCacheHandler: config.images.customCacheHandler
            ? config.images.customCacheHandler
            : true, // TODO: remove in Next.js 17
        },
      };
    }
    return config;
  },
  async onBuildComplete(ctx) {
    // Stage the deployment root and write the manifest the runtime dispatches
    // from. This is what replaces `output: "standalone"`.
    const { manifest, adapterDir, stagedGroups } = await writeBuildOutputs(ctx);
    const entrypointCount = Object.keys(manifest.entrypoints).length;
    for (const group of stagedGroups) {
      const routes = manifest.groups?.[group.name];
      console.log(
        `${LOG_PREFIX} Staged ${group.fileCount} files ` +
          `(${(group.stagedBytes / 1e6).toFixed(1)} MB) for ` +
          `${routes ? `${routes.length} of ${entrypointCount}` : entrypointCount} ` +
          `entrypoints in ${group.path}`,
      );
    }
    debug(`Adapter output directory: ${adapterDir}`);

    const cacheDir =
      process.env.CDK_NEXTJS_INIT_CACHE_DIR ||
      join(ctx.distDir, "cdk-nextjs-init-cache");

    // Ensure cache directory exists
    await mkdir(cacheDir, { recursive: true });
    debug(`Init cache directory: ${cacheDir}`);

    // One entry per route, with its HTML, `.rsc` and segment outputs together
    const prerenderGroups = groupPrerenders(ctx.outputs.prerenders);
    debug(`Prerender groups: ${prerenderGroups.size} groups`);

    const cacheKindOf = cacheKindResolver(ctx.outputs);

    // Tag -> cache keys, for the rows a runtime `set` would have written.
    // See `INIT_CACHE_TAG_MANIFEST`.
    const tagManifest: InitCacheTagManifest = {};

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

        // Write cache entry to file, under the route rather than the URL it is
        // served at - see `prerenderPathToCacheKey`.
        const cacheKey = prerenderPathToCacheKey(
          basePath,
          ctx.config.basePath || "",
        );
        const cacheFilePath = join(cacheDir, `${cacheKey}.json`);

        // Ensure parent directory exists
        await mkdir(
          join(cacheDir, cacheKey.split("/").slice(0, -1).join("/")),
          {
            recursive: true,
          },
        );

        await writeFile(cacheFilePath, serializeCacheValue(cacheEntry));

        for (const tag of cacheEntryTags(cacheEntry)) {
          (tagManifest[tag] ??= []).push(cacheKey);
        }

        debug(`Created cache entry: ${cacheFilePath}`);
      } catch (error) {
        console.error(`Error processing prerender group ${basePath}:`, error);
      }
    }

    const taggedKeys = Object.keys(tagManifest).length;
    if (taggedKeys > 0) {
      await writeFile(
        join(cacheDir, INIT_CACHE_TAG_MANIFEST),
        JSON.stringify(tagManifest),
      );
      debug(`Wrote ${INIT_CACHE_TAG_MANIFEST} with ${taggedKeys} tags`);
    }
  },
};

export default adapter;

/**
 * The tags a prerender was rendered with, as Next.js records them: in the
 * entry's own `x-next-cache-tags` header, comma separated, including the
 * implicit `_N_T_/…` path chain `revalidatePath` uses.
 */
function cacheEntryTags(entry: CacheHandlerValue): string[] {
  const headers =
    entry.value && "headers" in entry.value ? entry.value.headers : undefined;
  const header = headers?.[NEXT_CACHE_TAGS_HEADER];
  if (typeof header !== "string") {
    return [];
  }
  return header.split(",").filter(Boolean);
}

/**
 * Read file content from a prerender as UTF-8 string
 */
async function readPrerenderAsText(
  prerender:
    | { fallback?: { filePath?: string } | { postponedState: string } }
    | undefined,
): Promise<string | undefined> {
  if (
    prerender?.fallback &&
    "filePath" in prerender.fallback &&
    prerender.fallback.filePath &&
    existsSync(prerender.fallback.filePath)
  ) {
    return await readFile(prerender.fallback.filePath, "utf-8");
  }
  return undefined;
}

/**
 * Read file content from a prerender as Buffer
 */
async function readPrerenderAsBuffer(
  prerender:
    | { fallback?: { filePath?: string } | { postponedState: string } }
    | undefined,
): Promise<Buffer | undefined> {
  if (
    prerender?.fallback &&
    "filePath" in prerender.fallback &&
    prerender.fallback.filePath &&
    existsSync(prerender.fallback.filePath)
  ) {
    return await readFile(prerender.fallback.filePath);
  }
  return undefined;
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
    if (
      segmentPrerender.fallback &&
      "filePath" in segmentPrerender.fallback &&
      segmentPrerender.fallback.filePath &&
      existsSync(segmentPrerender.fallback.filePath)
    ) {
      const segmentContent = await readFile(segmentPrerender.fallback.filePath);
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

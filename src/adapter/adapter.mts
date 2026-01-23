/* eslint-disable import/no-extraneous-dependencies */
import { NextAdapter } from "next";
import { CacheHandlerValue } from "next/dist/server/lib/incremental-cache";
import { CachedRouteKind } from "next/dist/server/response-cache/index.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { serializeCacheValue } from "./cache-utils.js";
import getDebug from "debug";

const debug = getDebug("cdk-nextjs:adapter");

const adapter: NextAdapter = {
  name: "cdk-nextjs-adapter",
  async modifyConfig(config, { phase }) {
    if (phase === "phase-production-build") {
      return {
        ...config,
        output: "standalone",
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
    const cacheDir =
      process.env.CDK_NEXTJS_INIT_CACHE_DIR ||
      join(ctx.distDir, "cdk-nextjs-init-cache");

    // Ensure cache directory exists
    await mkdir(cacheDir, { recursive: true });
    debug(`Init cache directory: ${cacheDir}`);

    // Group prerenders by their base pathname
    type Prerender = (typeof ctx.outputs.prerenders)[number];
    const prerenderGroups = groupPrerendersByBasePath(ctx.outputs.prerenders);
    debug(`Prerender groups: ${prerenderGroups.size} groups`);

    // Build mapping of route paths to their cache kinds (needs prerender paths for dynamic routes)
    const prerenderPaths = Array.from(prerenderGroups.keys());
    const routeToCacheKind = getRouteToCacheKindMap(
      ctx.outputs,
      prerenderPaths,
    );
    debug(`Route mapping: ${routeToCacheKind.size} routes`);

    // Process each group and create cache entries
    for (const [basePath, prerenders] of prerenderGroups) {
      try {
        // Skip dynamic route templates (they don't have actual content)
        if (basePath.includes("[")) {
          debug(`SKIP: Dynamic route template ${basePath}`);
          continue;
        }

        // Determine the correct cache kind from our route mapping
        const kind = routeToCacheKind.get(basePath);
        if (!kind) {
          debug(`SKIP: No route kind found for ${basePath}`);
          continue;
        }

        debug(`Processing ${basePath} (${kind})`);

        const htmlPrerender = prerenders.find((p) => p.pathname === basePath);
        const rscPrerender = prerenders.find(
          (p) => p.pathname === `${basePath}.rsc`,
        );
        const segmentPrerenders = prerenders.filter((p) =>
          p.pathname.includes(".segments/"),
        );

        if (!htmlPrerender && !rscPrerender) {
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
          const headers =
            htmlPrerender?.fallback?.initialHeaders ||
            rscPrerender?.fallback?.initialHeaders ||
            {};

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
        } else {
          // Skip unsupported kinds
          debug(`SKIP: Unsupported route kind ${kind} for ${basePath}`);
          continue;
        }

        // Write cache entry to file
        const cacheKey =
          basePath === "/"
            ? "index"
            : basePath.replace(/^\//, "").replace(/\//g, "/");
        const cacheFilePath = join(cacheDir, `${cacheKey}.json`);

        // Ensure parent directory exists
        await mkdir(
          join(cacheDir, cacheKey.split("/").slice(0, -1).join("/")),
          {
            recursive: true,
          },
        );

        await writeFile(cacheFilePath, serializeCacheValue(cacheEntry));

        debug(`Created cache entry: ${cacheFilePath}`);
      } catch (error) {
        console.error(`Error processing prerender group ${basePath}:`, error);
      }
    }
  },
};

export default adapter;

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

/**
 * Build a mapping of route paths to their cache kinds based on build outputs
 */
function getRouteToCacheKindMap(
  outputs: {
    appPages: Array<{ pathname: string }>;
    appRoutes: Array<{ pathname: string }>;
  },
  prerenderPaths: string[],
): Map<string, CachedRouteKind> {
  const routeToCacheKind = new Map<string, CachedRouteKind>();

  // Helper to match a path to a dynamic route pattern
  const matchesDynamicRoute = (path: string, pattern: string): boolean => {
    // If pattern has no dynamic segments, must be exact match
    if (!pattern.includes("[")) {
      return path === pattern;
    }

    const patternParts = pattern.split("/");
    const pathParts = path.split("/");

    if (patternParts.length !== pathParts.length) {
      return false;
    }

    return patternParts.every((patternPart, i) => {
      // Dynamic segment matches anything
      if (patternPart.startsWith("[") && patternPart.endsWith("]")) {
        return true;
      }
      // Static segment must match exactly
      return patternPart === pathParts[i];
    });
  };

  // App Pages - map both templates and their prerendered instances
  for (const appPage of outputs.appPages) {
    routeToCacheKind.set(appPage.pathname, CachedRouteKind.APP_PAGE);

    // If it's a dynamic route, also map all matching prerendered paths
    if (appPage.pathname.includes("[")) {
      for (const prerenderPath of prerenderPaths) {
        if (matchesDynamicRoute(prerenderPath, appPage.pathname)) {
          routeToCacheKind.set(prerenderPath, CachedRouteKind.APP_PAGE);
        }
      }
    }
  }

  // App Routes - map both templates and their prerendered instances
  for (const appRoute of outputs.appRoutes) {
    routeToCacheKind.set(appRoute.pathname, CachedRouteKind.APP_ROUTE);

    // If it's a dynamic route, also map all matching prerendered paths
    if (appRoute.pathname.includes("[")) {
      for (const prerenderPath of prerenderPaths) {
        if (matchesDynamicRoute(prerenderPath, appRoute.pathname)) {
          routeToCacheKind.set(prerenderPath, CachedRouteKind.APP_ROUTE);
        }
      }
    }
  }

  return routeToCacheKind;
}

/**
 * Group prerenders by their base pathname (without .rsc, .segments, etc.)
 */
function groupPrerendersByBasePath<T extends { pathname: string }>(
  prerenders: T[],
): Map<string, T[]> {
  const prerenderGroups = new Map<string, T[]>();

  for (const prerender of prerenders) {
    // Extract base pathname (e.g., "/ssg/1" from "/ssg/1.rsc")
    let basePath = prerender.pathname;
    // Remove .rsc extension first
    if (basePath.endsWith(".rsc")) {
      basePath = basePath.replace(/\.rsc$/, "");
    }
    // Then check if it's a segment and extract the base
    if (basePath.includes(".segments/")) {
      basePath = basePath.split(".segments/")[0];
    }

    // Normalize /index to / (Next.js root route handling)
    if (basePath === "/index") {
      basePath = "/";
    }

    if (!prerenderGroups.has(basePath)) {
      prerenderGroups.set(basePath, []);
    }
    const group = prerenderGroups.get(basePath);
    if (group) {
      group.push(prerender);
    }
  }

  return prerenderGroups;
}

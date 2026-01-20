/* eslint-disable import/no-extraneous-dependencies */
import { NextAdapter } from "next";
import { CacheHandlerValue } from "next/dist/server/lib/incremental-cache";
import { CachedRouteKind } from "next/dist/server/response-cache/index.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { serializeCacheValue } from "./cache-utils.js";

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
    writeFile(join(ctx.distDir, "test.json"), JSON.stringify(ctx, null, 2));
    const cacheDir =
      process.env.CDK_NEXTJS_INIT_CACHE_DIR ||
      join(ctx.distDir, "cdk-nextjs-init-cache");

    // Ensure cache directory exists
    await mkdir(cacheDir, { recursive: true });

    // Group prerenders by their base pathname (without .rsc, .segments, etc.)
    type Prerender = (typeof ctx.outputs.prerenders)[number];
    const prerenderGroups = new Map<string, Prerender[]>();

    for (const prerender of ctx.outputs.prerenders) {
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

      if (!prerenderGroups.has(basePath)) {
        prerenderGroups.set(basePath, []);
      }
      const group = prerenderGroups.get(basePath);
      if (group) {
        group.push(prerender);
      }
    }

    // Process each group and create cache entries
    for (const [basePath, prerenders] of prerenderGroups) {
      try {
        const htmlPrerender = prerenders.find((p) => p.pathname === basePath);
        const rscPrerender = prerenders.find(
          (p) => p.pathname === `${basePath}.rsc`,
        );
        const segmentPrerenders = prerenders.filter((p) =>
          p.pathname.includes(".segments/"),
        );

        if (!htmlPrerender && !rscPrerender) {
          continue; // Skip if we don't have the main files
        }

        // Read HTML file
        let html: string | null = null;
        if (
          htmlPrerender?.fallback &&
          "filePath" in htmlPrerender.fallback &&
          htmlPrerender.fallback.filePath &&
          existsSync(htmlPrerender.fallback.filePath)
        ) {
          html = await readFile(htmlPrerender.fallback.filePath, "utf-8");
        }

        if (!html) {
          continue; // Skip if no HTML content
        }

        // Read RSC data
        let rscData: Buffer | null = null;
        if (
          rscPrerender?.fallback &&
          "filePath" in rscPrerender.fallback &&
          rscPrerender.fallback.filePath &&
          existsSync(rscPrerender.fallback.filePath)
        ) {
          rscData = await readFile(rscPrerender.fallback.filePath);
        }

        // Read segment data
        const segmentData = new Map<string, Buffer>();
        for (const segmentPrerender of segmentPrerenders) {
          if (
            segmentPrerender.fallback &&
            "filePath" in segmentPrerender.fallback &&
            segmentPrerender.fallback.filePath &&
            existsSync(segmentPrerender.fallback.filePath)
          ) {
            const segmentContent = await readFile(
              segmentPrerender.fallback.filePath,
            );
            // Extract segment name from pathname
            const segmentName =
              "/" +
              segmentPrerender.pathname
                .split(".segments/")[1]
                .replace(/\.segment\.rsc$/, "");
            segmentData.set(segmentName, segmentContent);
          }
        }

        // Extract headers from the HTML or RSC prerender
        const headers =
          htmlPrerender?.fallback?.initialHeaders ||
          rscPrerender?.fallback?.initialHeaders ||
          {};

        // Extract tags from x-next-cache-tags header
        const cacheTags = headers["x-next-cache-tags"];
        const tags = cacheTags
          ? typeof cacheTags === "string"
            ? cacheTags.split(",")
            : cacheTags
          : [];

        // Create cache entry
        const cacheEntry: CacheHandlerValue = {
          lastModified: Date.now(),
          value: {
            kind: CachedRouteKind.APP_PAGE,
            html,
            rscData: rscData || undefined,
            headers: headers,
            segmentData: segmentData,
            postponed: htmlPrerender?.fallback?.postponedState, // is this right?
            status: htmlPrerender?.fallback?.initialStatus, // is this right?
          },
        };

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

        console.log(`Created cache entry: ${cacheFilePath}`);
      } catch (error) {
        console.error(`Error processing prerender group ${basePath}:`, error);
      }
    }
  },
};

export default adapter;

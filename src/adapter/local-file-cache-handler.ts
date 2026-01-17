/*
  Local File Cache Handler for Next.js build-time pre-caching
  
  Writes cache entries to .next/cdk-nextjs-cache-handler/{cacheKey}.json
  during the build process so they can be deployed to S3 via BucketDeployment.
  BucketDeployment will add the buildId prefix when uploading to S3.
*/
/* eslint-disable import/no-extraneous-dependencies */
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { dirname, join } from "path";
import getDebug from "debug";
import { CacheHandlerValue } from "next/dist/server/lib/incremental-cache";
import type { IncrementalCacheValue } from "next/dist/server/response-cache";
import { serializeCacheValue } from "./cache-utils";

const debug = getDebug("cdk-nextjs:cache-handler:local-file");

/**
 * Local file cache handler that writes cache entries during Next.js build
 * to be deployed to S3 later via BucketDeployment
 */
export class LocalFileCacheHandler {
  private cacheDir: string;

  constructor() {
    // Always write to .next/cdk-nextjs-cache-handler in current working directory
    this.cacheDir = join(process.cwd(), ".next", "cdk-nextjs-init-cache");

    // Clean existing cache directory to avoid stale data from previous builds
    if (existsSync(this.cacheDir)) {
      rmSync(this.cacheDir, { recursive: true, force: true });
      debug(`Cleaned existing cache directory: ${this.cacheDir}`);
    }

    // Create fresh cache directory
    mkdirSync(this.cacheDir, { recursive: true });
    debug(`Created local cache directory: ${this.cacheDir}`);
  }

  /**
   * Build file path for cache entry
   * Structure: {cacheKey}.json (BucketDeployment will add buildId prefix)
   */
  private buildFilePath(cacheKey: string): string {
    const filePath = join(this.cacheDir, `${cacheKey}.json`);
    return filePath;
  }

  /**
   * Write cache entry to local file
   */
  async set(
    cacheKey: string,
    data: IncrementalCacheValue | null,
    tags?: string[],
  ): Promise<void> {
    try {
      if (!data) {
        return;
      }

      const filePath = this.buildFilePath(cacheKey);

      // Create directory if it doesn't exist
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Create CacheHandlerValue structure with tags
      const cacheHandlerValue: CacheHandlerValue = {
        lastModified: Date.now(),
        value: data,
      };

      // Store with tags for revalidation checking
      const storageValue = {
        ...cacheHandlerValue,
        tags: tags || [],
      };

      // Serialize to JSON with special handling for Map and Buffer
      const jsonString = serializeCacheValue(storageValue);

      // Write to file
      writeFileSync(filePath, jsonString, "utf-8");

      debug(`LOCAL FILE CACHE WRITE: ${cacheKey} -> ${filePath}`);
    } catch (error) {
      console.error(`Error writing local cache file for ${cacheKey}:`, error);
      // Don't throw - build should continue even if caching fails
    }
  }

  /**
   * Get cache directory path
   */
  getCacheDir(): string {
    return this.cacheDir;
  }
}

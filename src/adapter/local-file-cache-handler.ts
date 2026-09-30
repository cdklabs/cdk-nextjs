/*
  Local File Cache Handler for Next.js build-time pre-caching
  
  Writes cache entries to .next/cdk-nextjs-cache-handler/{cacheKey}.json
  during the build process so they can be deployed to S3 via BucketDeployment.
  BucketDeployment will add the buildId prefix when uploading to S3.
*/
/* eslint-disable import/no-extraneous-dependencies */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import getDebug from "debug";
import { CacheHandlerValue } from "next/dist/server/lib/incremental-cache";
import type { IncrementalCacheValue } from "next/dist/server/response-cache";
import { parseCacheValue, serializeCacheValue } from "./cache-utils";

const debug = getDebug("cdk-nextjs:cache-handler:local-file");

/**
 * Local file cache handler that writes cache entries during Next.js build
 * to be deployed to S3 later via BucketDeployment
 */
export class LocalFileCacheHandler {
  private cacheDir: string;
  /** What this process has written or read back; see {@link get}. */
  private entries = new Map<string, CacheHandlerValue>();

  constructor() {
    // Read cache directory from environment variable set by NextjsBuild
    // Falls back to default location for backward compatibility
    this.cacheDir = process.env.CDK_NEXTJS_INIT_CACHE_DIR
      ? process.env.CDK_NEXTJS_INIT_CACHE_DIR
      : join(process.cwd(), ".next", "cdk-nextjs-init-cache");

    // Create fresh cache directory; cache directory is cleaned before each build in NextjsBuild
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
   * Read back an entry this build already wrote.
   *
   * Required, not an optimization. Under `cacheComponents` a prerender runs
   * twice: a first pass that fills caches (every `fetch` misses, runs for real,
   * and is `set`), then a final pass in which every await must settle in a
   * microtask — anything still pending is by definition "runtime data", and
   * Next.js aborts the page with `Route "/": Next.js encountered uncached or
   * runtime data during prerendering`. The final pass only settles immediately
   * if `get` returns what the first pass `set`, so a write-only build-time
   * handler makes `fetch(url, { cache: 'force-cache' })` unprerenderable and
   * fails the build. Next.js's own `FileSystemCache` reads back for exactly
   * this reason. Measured against next.js's
   * `test/e2e/app-dir/resume-data-cache`, which is unbuildable without it.
   *
   * Entries are read through a process-local map because the two passes are the
   * same process, and because the deserialized value is what Next.js compares
   * by reference when deduping within a render.
   */
  async get(cacheKey: string): Promise<CacheHandlerValue | null> {
    const memoized = this.entries.get(cacheKey);
    if (memoized !== undefined) {
      return memoized;
    }
    try {
      const filePath = this.buildFilePath(cacheKey);
      if (!existsSync(filePath)) {
        return null;
      }
      // `tags` is stored alongside, not inside, the `CacheHandlerValue`; it is
      // only consulted for tag revalidation, which cannot happen mid-build.
      const stored = parseCacheValue(readFileSync(filePath, "utf-8"));
      const entry: CacheHandlerValue = {
        lastModified: stored.lastModified,
        value: stored.value,
      };
      this.entries.set(cacheKey, entry);
      debug(`LOCAL FILE CACHE HIT: ${cacheKey}`);
      return entry;
    } catch (error) {
      console.error(`Error reading local cache file for ${cacheKey}:`, error);
      // Don't throw - a miss only costs the build a re-fetch.
      return null;
    }
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
      // Serve the rest of this build from memory rather than re-reading; see
      // {@link get}.
      this.entries.set(cacheKey, cacheHandlerValue);

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

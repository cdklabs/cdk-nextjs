/*
  In-memory cache handler with tag management
*/
/* eslint-disable import/no-extraneous-dependencies */
import getDebug from "debug";
import {
  CacheHandler,
  CacheHandlerValue,
  CacheHandlerContext,
} from "next/dist/server/lib/incremental-cache";
import {
  IncrementalCacheValue,
  GetIncrementalFetchCacheContext,
  GetIncrementalResponseCacheContext,
  SetIncrementalFetchCacheContext,
  SetIncrementalResponseCacheContext,
} from "next/dist/server/response-cache";

// Helper to safely extract tags from context
const getTags = (
  ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext,
): string[] | undefined => ("tags" in ctx ? ctx.tags : undefined);

interface MemoryCacheEntry {
  value: CacheHandlerValue;
}

export interface MemoryCacheHandlerOptions {
  context: CacheHandlerContext;
}

export class MemoryCacheHandler implements CacheHandler {
  private inMemoryCache: Map<string, MemoryCacheEntry> = new Map();
  private inMemoryTagCache: Map<string, Set<string>> = new Map(); // tag -> Set of cache keys
  private debug = getDebug("cdk-nextjs:cache-handler:memory");

  constructor(options: MemoryCacheHandlerOptions) {
    // Log the options for debugging (optional usage to avoid unused parameter warning)
    if (options.context.dev) {
      this.debug("MemoryCacheHandler initialized in development mode");
    }
  }

  async get(
    cacheKey: string,
    ctx: GetIncrementalFetchCacheContext | GetIncrementalResponseCacheContext,
  ): Promise<CacheHandlerValue | null> {
    // Log context for debugging (optional usage to avoid unused parameter warning)
    if (ctx.kind) {
      this.debug(
        `Memory cache get operation for ${cacheKey} with kind: ${ctx.kind}`,
      );
    }

    // Check in-memory cache
    const memoryEntry = this.inMemoryCache.get(cacheKey);
    if (memoryEntry) {
      this.debug(`MEMORY CACHE HIT: ${cacheKey}`);
      return memoryEntry.value;
    }

    this.debug(`MEMORY CACHE MISS: ${cacheKey}`);
    return null;
  }

  async set(
    cacheKey: string,
    data: IncrementalCacheValue | null,
    ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext,
  ): Promise<void> {
    if (!data) {
      // Delete from memory cache
      this.debug(`MEMORY CACHE DELETE: ${cacheKey}`);
      this.inMemoryCache.delete(cacheKey);

      // Remove from tag cache
      for (const [tag, cacheKeys] of this.inMemoryTagCache.entries()) {
        if (cacheKeys.has(cacheKey)) {
          cacheKeys.delete(cacheKey);
          // Clean up empty tag sets
          if (cacheKeys.size === 0) {
            this.inMemoryTagCache.delete(tag);
          }
        }
      }

      return;
    }

    // Log tags for debugging if present (only in SetIncrementalFetchCacheContext)
    const tags = getTags(ctx);
    if (tags && tags.length > 0) {
      this.debug(`Memory cache entry for ${cacheKey} has tags:`, tags);
    }

    // Debug logging for memory cache set
    this.debug(`MEMORY CACHE SET: ${cacheKey} (${data.kind})`);

    // Store in memory cache with proper CacheHandlerValue structure
    const cacheHandlerValue: CacheHandlerValue = {
      lastModified: Date.now(),
      value: data,
    };

    this.inMemoryCache.set(cacheKey, {
      value: cacheHandlerValue,
    });

    // Track tags for this cache entry (only in SetIncrementalFetchCacheContext)
    if (tags && tags.length > 0) {
      this.debug(`MEMORY TAGS: ${cacheKey} -> [${tags.join(", ")}]`);
      for (const tag of tags) {
        let tagSet = this.inMemoryTagCache.get(tag);
        if (!tagSet) {
          tagSet = new Set();
          this.inMemoryTagCache.set(tag, tagSet);
        }
        tagSet.add(cacheKey);
      }
    }
  }

  async revalidateTag(tag: string | string[]): Promise<void> {
    const tags = Array.isArray(tag) ? tag : [tag];
    this.debug(`MEMORY REVALIDATING TAGS: [${tags.join(", ")}]`);

    // Clear memory cache for these tags
    for (const t of tags) {
      this.clearMemoryCacheByTag(t);
    }
  }

  async resetRequestCache(): Promise<void> {
    // Clear both in-memory caches
    this.inMemoryCache.clear();
    this.inMemoryTagCache.clear();
  }

  private clearMemoryCacheByTag(tag: string): void {
    // Get all cache keys associated with this tag
    const cacheKeys = this.inMemoryTagCache.get(tag);
    if (cacheKeys) {
      this.debug(`MEMORY TAG ${tag}: Clearing ${cacheKeys.size} cache entries`);

      // Remove each cache entry
      for (const cacheKey of cacheKeys) {
        this.inMemoryCache.delete(cacheKey);
      }

      // Remove the tag mapping
      this.inMemoryTagCache.delete(tag);

      // Clean up any references to these cache keys in other tags
      for (const [otherTag, otherKeys] of this.inMemoryTagCache.entries()) {
        for (const cacheKey of cacheKeys) {
          otherKeys.delete(cacheKey);
        }
        // Remove empty tag sets
        if (otherKeys.size === 0) {
          this.inMemoryTagCache.delete(otherTag);
        }
      }
    }
  }

  // Public methods for testing and monitoring
  public getCacheSize(): number {
    return this.inMemoryCache.size;
  }

  public getTagCacheSize(): number {
    return this.inMemoryTagCache.size;
  }

  public clearCache(): void {
    this.inMemoryCache.clear();
    this.inMemoryTagCache.clear();
  }
}

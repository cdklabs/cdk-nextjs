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
  expiresAt: number; // Timestamp in milliseconds
}

export interface MemoryCacheHandlerOptions {
  context: CacheHandlerContext;
}

export class MemoryCacheHandler implements CacheHandler {
  private inMemoryCache: Map<string, MemoryCacheEntry> = new Map();
  private inMemoryTagCache: Map<string, Set<string>> = new Map(); // tag -> Set of cache keys
  private debug = getDebug("cdk-nextjs:cache-handler:memory");
  private readonly ttlMs: number; // Time to live in milliseconds
  private readonly maxEntries: number; // Maximum number of cache entries

  constructor(options: MemoryCacheHandlerOptions) {
    // Default to 1 hour TTL and 1000 max entries
    this.ttlMs = 60 * 60 * 1000; // 1 hour
    this.maxEntries = 1000;

    // Log the options for debugging (optional usage to avoid unused parameter warning)
    if (options.context.dev) {
      this.debug("MemoryCacheHandler initialized in development mode");
    }
    this.debug(`TTL: ${this.ttlMs / 1000}s, Max entries: ${this.maxEntries}`);
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
      // Check if expired
      if (Date.now() > memoryEntry.expiresAt) {
        this.debug(`MEMORY CACHE EXPIRED: ${cacheKey}`);
        this.inMemoryCache.delete(cacheKey);
        this.removeFromTagCache(cacheKey);
        return null;
      }

      // Move to end (most recently used) by deleting and re-inserting
      this.inMemoryCache.delete(cacheKey);
      this.inMemoryCache.set(cacheKey, memoryEntry);

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
      this.removeFromTagCache(cacheKey);

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

    const entry: MemoryCacheEntry = {
      value: cacheHandlerValue,
      expiresAt: Date.now() + this.ttlMs,
    };

    // Clean up expired entries before adding new one
    this.cleanupExpired();

    // If we're at max capacity, evict oldest entry
    if (this.inMemoryCache.size >= this.maxEntries) {
      this.evictOldest();
    }

    // Add new entry
    this.inMemoryCache.set(cacheKey, entry);

    this.debug(`Cache entries: ${this.inMemoryCache.size}/${this.maxEntries}`);

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

  /**
   * Remove a cache key from all tag mappings
   */
  private removeFromTagCache(cacheKey: string): void {
    for (const [tag, cacheKeys] of this.inMemoryTagCache.entries()) {
      if (cacheKeys.has(cacheKey)) {
        cacheKeys.delete(cacheKey);
        // Clean up empty tag sets
        if (cacheKeys.size === 0) {
          this.inMemoryTagCache.delete(tag);
        }
      }
    }
  }

  /**
   * Remove all expired cache entries
   */
  private cleanupExpired(): void {
    const now = Date.now();
    let expiredCount = 0;

    for (const [key, entry] of this.inMemoryCache.entries()) {
      if (now > entry.expiresAt) {
        this.inMemoryCache.delete(key);
        this.removeFromTagCache(key);
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      this.debug(`Cleaned up ${expiredCount} expired entries`);
    }
  }

  /**
   * Evict the oldest (least recently used) cache entry
   * Map maintains insertion order, so first entry is oldest
   */
  private evictOldest(): void {
    const firstKey = this.inMemoryCache.keys().next().value;
    if (firstKey) {
      this.debug(`MAX CAPACITY EVICT (LRU): ${firstKey}`);
      this.inMemoryCache.delete(firstKey);
      this.removeFromTagCache(firstKey);
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

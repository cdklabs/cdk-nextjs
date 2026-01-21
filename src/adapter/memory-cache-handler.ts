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
  SetIncrementalResponseCacheContext,
  SetIncrementalFetchCacheContext,
} from "next/dist/server/response-cache";

interface MemoryCacheEntry {
  value: CacheHandlerValue;
  expiresAt: number; // Timestamp in milliseconds
}

export interface MemoryCacheHandlerOptions {
  context: CacheHandlerContext;
}

export class MemoryCacheHandler implements CacheHandler {
  private inMemoryCache: Map<string, MemoryCacheEntry> = new Map();
  private debug = getDebug("cdk-nextjs:cache-handler:memory");

  /**
   * Time to live in milliseconds for cache entries.
   * After this duration, entries expire and are removed from the cache.
   *
   * **Important**: Due to the distributed nature of compute instances (Lambda functions,
   * ECS Fargate containers, etc.), this cache only provides eventual consistency across
   * instances. Tag revalidations will clear the cache on the instance that processes
   * the revalidation, but other instances may serve stale data until their cache entries expire.
   *
   * @example
   * // Short TTL (5 minutes) - for frequently changing data
   * ttlMs = 5 * 60 * 1000;
   *
   * @example
   * // Medium TTL (1 hour) - balanced between freshness and performance
   * ttlMs = 60 * 60 * 1000;
   *
   * @example
   * // Long TTL (24 hours) - for mostly static content
   * ttlMs = 24 * 60 * 60 * 1000;
   *
   * **Why adjust this?**
   * - Lower values: More cache misses, fresher data, higher S3/DynamoDB costs
   * - Higher values: Fewer cache misses, better performance, but longer stale data windows
   *
   * Set via environment variable: `CDK_NEXTJS_MEMORY_CACHE_TTL_MS`
   */
  private readonly ttlMs: number;

  /**
   * Maximum number of cache entries to store in memory.
   * When this limit is reached, the least recently used (LRU) entry is evicted.
   *
   * @example
   * // Small cache (100 entries) - minimal memory footprint for simple apps
   * maxEntries = 100;
   *
   * @example
   * // Medium cache (1000 entries) - good balance for typical applications
   * maxEntries = 1000;
   *
   * @example
   * // Large cache (10000 entries) - for high-traffic apps with many unique pages
   * maxEntries = 10000;
   *
   * **Why adjust this?**
   * - Lower values: Less memory usage, more cache evictions
   * - Higher values: More memory usage, fewer cache evictions, better hit rates
   *
   * **Memory considerations**: Each entry stores the full cache value (HTML, JSON, etc.)
   * A typical page cache might be 10-100KB, so 1000 entries ≈ 10-100MB of memory.
   * Consider your compute environment's memory limits (Lambda: 128MB-10GB, Fargate: 512MB-30GB)
   * and size accordingly.
   *
   * Set via environment variable: `CDK_NEXTJS_MEMORY_CACHE_MAX_ENTRIES`
   */
  private readonly maxEntries: number;

  constructor(options: MemoryCacheHandlerOptions) {
    // Read configuration from environment variables with fallback defaults
    const ttlFromEnv = process.env.CDK_NEXTJS_MEMORY_CACHE_TTL_MS;
    const maxEntriesFromEnv = process.env.CDK_NEXTJS_MEMORY_CACHE_MAX_ENTRIES;

    // Default to 1 hour TTL and 1000 max entries
    this.ttlMs = ttlFromEnv ? parseInt(ttlFromEnv, 10) : 60 * 60 * 1000; // 1 hour
    this.maxEntries = maxEntriesFromEnv
      ? parseInt(maxEntriesFromEnv, 10)
      : 1000;

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
    _ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext,
  ): Promise<void> {
    if (!data) {
      // Delete from memory cache
      this.debug(`MEMORY CACHE DELETE: ${cacheKey}`);
      this.inMemoryCache.delete(cacheKey);
      return;
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
  }

  async revalidateTag(tag: string | string[]): Promise<void> {
    const tags = Array.isArray(tag) ? tag : [tag];
    this.debug(`MEMORY REVALIDATE TAGS (no-op): [${tags.join(", ")}]`);
    // Memory cache does not track tags because:
    // 1. In distributed environments (multiple Lambda functions or Fargate containers),
    //    tag revalidation only clears cache on the current instance. Other instances
    //    would continue serving stale data until their TTL expires anyway.
    // 2. The S3 cache handler with DynamoDB provides the authoritative source of truth
    //    for tag revalidations across all instances.
    // 3. Memory cache relies on TTL-based expiration for simplicity and consistency.
    //    If strong consistency is required, set CDK_NEXTJS_MEMORY_CACHE_TTL_MS=0.
  }

  async resetRequestCache(): Promise<void> {
    // Clear in-memory cache
    this.inMemoryCache.clear();
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
    }
  }

  // Public methods for testing and monitoring
  public getCacheSize(): number {
    return this.inMemoryCache.size;
  }

  public clearCache(): void {
    this.inMemoryCache.clear();
  }
}

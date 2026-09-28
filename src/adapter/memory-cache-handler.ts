/*
  In-memory cache handler
*/
/* eslint-disable import/no-extraneous-dependencies */
import getDebug from "debug";
import { CacheHandlerValue } from "next/dist/server/lib/incremental-cache";
import { IncrementalCacheValue } from "next/dist/server/response-cache";
import { markerClock } from "./aws-cache-store";
import { numberFromEnv } from "./use-cache-common";

interface MemoryCacheEntry {
  value: CacheHandlerValue;
  expiresAt: number; // Timestamp in milliseconds
}

/**
 * The in-memory layer the orchestrating handler puts in front of
 * `S3CacheHandler`. Not a `CacheHandler` of its own: it has no tags, since
 * every hit is checked against the tag markers before it is served.
 */
export class MemoryCacheHandler {
  private inMemoryCache: Map<string, MemoryCacheEntry> = new Map();
  private debug = getDebug("cdk-nextjs:cache-handler:memory");

  /**
   * Time to live in milliseconds for cache entries.
   * After this duration, entries expire and are removed from the cache.
   *
   * Tag revalidations never clear this cache: the orchestrating handler checks
   * each memory hit against the tag markers before serving it
   * (`S3CacheHandler.isRevalidated`), so a revalidated entry is not served from
   * memory anywhere.
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
   * - Lower values: More cache misses, higher S3 costs
   * - Higher values: Fewer cache misses, more memory held
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

  constructor() {
    // Default to 1 hour TTL and 1000 max entries. A value that is not a
    // number falls back too: as NaN, nothing would ever expire or be evicted.
    this.ttlMs = numberFromEnv(
      "CDK_NEXTJS_MEMORY_CACHE_TTL_MS",
      60 * 60 * 1000,
    );
    this.maxEntries = numberFromEnv(
      "CDK_NEXTJS_MEMORY_CACHE_MAX_ENTRIES",
      1000,
    );

    this.debug(`TTL: ${this.ttlMs / 1000}s, Max entries: ${this.maxEntries}`);
  }

  async get(cacheKey: string): Promise<CacheHandlerValue | null> {
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

  /**
   * `lastModified` is the time the entry was rendered, for an entry copied in
   * from a slower layer; a fresh render leaves it out and is stamped now - on
   * {@link markerClock}, like the S3 copy of the same render. A memory hit is
   * checked against the tag markers, which are stamped on that clock, and
   * `Date.now()` drifts from it for as long as the process lives: an entry
   * stamped ahead of it looked newer than a `revalidateTag` run within the
   * drift, and was served for the whole memory TTL.
   */
  async set(
    cacheKey: string,
    data: IncrementalCacheValue | null,
    lastModified?: number,
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
      lastModified: lastModified ?? markerClock(),
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

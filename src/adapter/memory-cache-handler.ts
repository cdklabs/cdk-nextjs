/*
  In-memory cache handler with TTL support and tag management
*/
/* eslint-disable import/no-extraneous-dependencies */
import getDebug from "debug";
import { CacheHandlerValue } from "next/dist/server/lib/incremental-cache";
import {
  IncrementalCacheValue,
  GetIncrementalFetchCacheContext,
  GetIncrementalResponseCacheContext,
} from "next/dist/server/response-cache";
import { CacheHandler, CacheHandlerOptions } from "./cache-handler-interface";

interface MemoryCacheEntry {
  value: CacheHandlerValue;
  timestamp: number;
}

export interface MemoryCacheHandlerOptions extends CacheHandlerOptions {
  ttlMs?: number; // Time to live in milliseconds, default 60000 (1 minute)
  fallbackHandler?: CacheHandler; // Optional fallback handler for cache misses
}

export class MemoryCacheHandler implements CacheHandler {
  private inMemoryCache: Map<string, MemoryCacheEntry> = new Map();
  private inMemoryTagCache: Map<string, Set<string>> = new Map(); // tag -> Set of cache keys
  private ttlMs: number;
  private fallbackHandler?: CacheHandler;
  private debug = getDebug("cdk-nextjs:cache-handler:memory");

  constructor(options: MemoryCacheHandlerOptions) {
    this.ttlMs = options.ttlMs || 60000; // Default 1 minute TTL
    this.fallbackHandler = options.fallbackHandler;

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

    // Check in-memory cache first
    const memoryEntry = this.inMemoryCache.get(cacheKey);
    if (memoryEntry && this.isEntryValid(memoryEntry)) {
      this.debug(`MEMORY CACHE HIT: ${cacheKey}`);
      return memoryEntry.value;
    }

    // Remove expired entry
    if (memoryEntry && !this.isEntryValid(memoryEntry)) {
      this.debug(`MEMORY CACHE EXPIRED: ${cacheKey}`);
      this.inMemoryCache.delete(cacheKey);
    }

    // If we have a fallback handler, try it
    if (this.fallbackHandler) {
      const fallbackValue = await this.fallbackHandler.get(cacheKey, ctx);
      if (fallbackValue) {
        this.debug(`MEMORY FALLBACK HIT: ${cacheKey}`);

        // Store the fallback result in memory for future requests
        this.inMemoryCache.set(cacheKey, {
          value: fallbackValue,
          timestamp: Date.now(),
        });
        return fallbackValue;
      } else {
        this.debug(`MEMORY FALLBACK MISS: ${cacheKey}`);
      }
    } else {
      this.debug(`MEMORY CACHE MISS: ${cacheKey} (no fallback)`);
    }

    return null;
  }

  async set(
    cacheKey: string,
    data: IncrementalCacheValue | null,
    ctx: { tags: string[] },
  ): Promise<void> {
    if (!data) {
      return;
    }

    // Log tags for debugging if present
    if (ctx.tags && ctx.tags.length > 0) {
      this.debug(`Memory cache entry for ${cacheKey} has tags:`, ctx.tags);
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
      timestamp: Date.now(),
    });

    // Track tags for this cache entry
    if (ctx.tags && ctx.tags.length > 0) {
      this.debug(`MEMORY TAGS: ${cacheKey} -> [${ctx.tags.join(", ")}]`);
      for (const tag of ctx.tags) {
        let tagSet = this.inMemoryTagCache.get(tag);
        if (!tagSet) {
          tagSet = new Set();
          this.inMemoryTagCache.set(tag, tagSet);
        }
        tagSet.add(cacheKey);
      }
    }

    // Also store in fallback handler if available
    if (this.fallbackHandler) {
      await this.fallbackHandler.set(cacheKey, data, ctx);
    }
  }

  async revalidateTag(tag: string | string[]): Promise<void> {
    const tags = Array.isArray(tag) ? tag : [tag];
    this.debug(`MEMORY REVALIDATING TAGS: [${tags.join(", ")}]`);

    // Clear memory cache for these tags
    for (const t of tags) {
      this.clearMemoryCacheByTag(t);
    }

    // Also revalidate in fallback handler if available
    if (this.fallbackHandler) {
      await this.fallbackHandler.revalidateTag(tag);
    }
  }

  async resetRequestCache(): Promise<void> {
    // Clear both in-memory caches
    this.inMemoryCache.clear();
    this.inMemoryTagCache.clear();

    // Also reset fallback handler if available
    if (this.fallbackHandler) {
      await this.fallbackHandler.resetRequestCache();
    }
  }

  private isEntryValid(entry: MemoryCacheEntry): boolean {
    return Date.now() - entry.timestamp < this.ttlMs;
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

  public getHealthStatus(): {
    memoryCacheSize: number;
    tagCacheSize: number;
    ttlMs: number;
    hasFallbackHandler: boolean;
  } {
    return {
      memoryCacheSize: this.inMemoryCache.size,
      tagCacheSize: this.inMemoryTagCache.size,
      ttlMs: this.ttlMs,
      hasFallbackHandler: !!this.fallbackHandler,
    };
  }
}

/* eslint-disable import/no-extraneous-dependencies */
import {
  CacheHandlerValue,
  CacheHandlerContext,
} from "next/dist/server/lib/incremental-cache";
import {
  IncrementalCacheValue,
  CachedRouteKind,
  IncrementalCacheKind,
} from "next/dist/server/response-cache";
import { CacheHandler } from "./cache-handler-interface";
import { MemoryCacheHandler } from "./memory-cache-handler";

// Mock fallback handler for testing
class MockFallbackHandler implements CacheHandler {
  private storage = new Map<string, CacheHandlerValue>();
  private tags = new Map<string, Set<string>>();

  async get(cacheKey: string): Promise<CacheHandlerValue | null> {
    return this.storage.get(cacheKey) || null;
  }

  async set(
    cacheKey: string,
    data: IncrementalCacheValue | null,
    ctx: { tags: string[] },
  ): Promise<void> {
    if (!data) return;

    const cacheValue: CacheHandlerValue = {
      lastModified: Date.now(),
      value: data,
    };

    this.storage.set(cacheKey, cacheValue);

    // Track tags
    for (const tag of ctx.tags) {
      if (!this.tags.has(tag)) {
        this.tags.set(tag, new Set());
      }
      this.tags.get(tag)!.add(cacheKey);
    }
  }

  async revalidateTag(tag: string): Promise<void> {
    const cacheKeys = this.tags.get(tag);
    if (cacheKeys) {
      for (const cacheKey of cacheKeys) {
        this.storage.delete(cacheKey);
      }
      this.tags.delete(tag);
    }
  }

  async resetRequestCache(): Promise<void> {
    this.storage.clear();
    this.tags.clear();
  }
}

describe("MemoryCacheHandler", () => {
  let handler: MemoryCacheHandler;
  let mockFallback: MockFallbackHandler;
  let mockContext: CacheHandlerContext;

  beforeEach(() => {
    mockFallback = new MockFallbackHandler();
    mockContext = { dev: false } as CacheHandlerContext;

    handler = new MemoryCacheHandler({
      context: mockContext,
      ttlMs: 1000, // 1 second TTL for testing
      fallbackHandler: mockFallback,
    });
  });

  afterEach(() => {
    handler.clearCache();
  });

  describe("get", () => {
    it("should return null for non-existent cache key", async () => {
      const result = await handler.get("non-existent", {
        kind: IncrementalCacheKind.APP_PAGE,
      });
      expect(result).toBeNull();
    });

    it("should return cached value from memory", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>test</html>",
        pageData: {},
      };

      await handler.set("test-key", testData, { tags: [] });
      const result = await handler.get("test-key", {
        kind: IncrementalCacheKind.APP_PAGE,
      });

      expect(result).not.toBeNull();
      expect(result?.value).toEqual(testData);
    });

    it("should fall back to fallback handler when not in memory", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>fallback</html>",
        pageData: {},
      };

      // Store directly in fallback handler
      await mockFallback.set("fallback-key", testData, { tags: [] });

      const result = await handler.get("fallback-key", {
        kind: IncrementalCacheKind.APP_PAGE,
      });

      expect(result).not.toBeNull();
      expect(result?.value).toEqual(testData);

      // Should now be cached in memory
      expect(handler.getCacheSize()).toBe(1);
    });

    it("should respect TTL and expire entries", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>expired</html>",
        pageData: {},
      };

      await handler.set("expire-key", testData, { tags: [] });

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const result = await handler.get("expire-key", {
        kind: CachedRouteKind.APP_PAGE,
      });

      // Should be null since TTL expired and not in fallback
      expect(result).toBeNull();
    });
  });

  describe("set", () => {
    it("should store value in memory cache", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>set test</html>",
        pageData: {},
      };

      await handler.set("set-key", testData, { tags: ["tag1"] });

      expect(handler.getCacheSize()).toBe(1);

      const result = await handler.get("set-key", {
        kind: CachedRouteKind.APP_PAGE,
      });
      expect(result?.value).toEqual(testData);
    });

    it("should track tags correctly", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>tagged</html>",
        pageData: {},
      };

      await handler.set("tagged-key", testData, { tags: ["tag1", "tag2"] });

      expect(handler.getTagCacheSize()).toBe(2);
    });

    it("should forward to fallback handler", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>forwarded</html>",
        pageData: {},
      };

      await handler.set("forward-key", testData, { tags: [] });

      // Should be in fallback handler
      const fallbackResult = await mockFallback.get("forward-key", {
        kind: CachedRouteKind.APP_PAGE,
      });
      expect(fallbackResult?.value).toEqual(testData);
    });
  });

  describe("revalidateTag", () => {
    it("should clear memory cache entries by tag", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>tagged</html>",
        pageData: {},
      };

      await handler.set("tagged-key-1", testData, { tags: ["revalidate-tag"] });
      await handler.set("tagged-key-2", testData, { tags: ["revalidate-tag"] });
      await handler.set("other-key", testData, { tags: ["other-tag"] });

      expect(handler.getCacheSize()).toBe(3);

      await handler.revalidateTag("revalidate-tag");

      expect(handler.getCacheSize()).toBe(1);

      const result = await handler.get("other-key", {
        kind: CachedRouteKind.APP_PAGE,
      });
      expect(result).not.toBeNull();
    });

    it("should forward revalidation to fallback handler", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>fallback tagged</html>",
        pageData: {},
      };

      await mockFallback.set("fallback-tagged", testData, {
        tags: ["fallback-tag"],
      });

      await handler.revalidateTag("fallback-tag");

      const result = await mockFallback.get("fallback-tagged", {
        kind: CachedRouteKind.APP_PAGE,
      });
      expect(result).toBeNull();
    });
  });

  describe("resetRequestCache", () => {
    it("should clear all caches", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>reset test</html>",
        pageData: {},
      };

      await handler.set("reset-key", testData, { tags: ["reset-tag"] });

      expect(handler.getCacheSize()).toBe(1);
      expect(handler.getTagCacheSize()).toBe(1);

      await handler.resetRequestCache();

      expect(handler.getCacheSize()).toBe(0);
      expect(handler.getTagCacheSize()).toBe(0);
    });
  });

  describe("health status", () => {
    it("should return correct health status", () => {
      const status = handler.getHealthStatus();

      expect(status).toEqual({
        memoryCacheSize: 0,
        tagCacheSize: 0,
        ttlMs: 1000,
        hasFallbackHandler: true,
      });
    });
  });

  describe("without fallback handler", () => {
    beforeEach(() => {
      handler = new MemoryCacheHandler({
        context: mockContext,
        ttlMs: 1000,
      });
    });

    it("should work without fallback handler", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>no fallback</html>",
        pageData: {},
      };

      await handler.set("no-fallback-key", testData, { tags: [] });
      const result = await handler.get("no-fallback-key", {
        kind: CachedRouteKind.APP_PAGE,
      });

      expect(result?.value).toEqual(testData);
    });

    it("should return null for cache miss without fallback", async () => {
      const result = await handler.get("missing-key", {
        kind: CachedRouteKind.APP_PAGE,
      });
      expect(result).toBeNull();
    });
  });
});

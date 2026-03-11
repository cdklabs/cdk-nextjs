/* eslint-disable import/no-extraneous-dependencies */
import { CacheHandlerContext } from "next/dist/server/lib/incremental-cache";
import {
  IncrementalCacheValue,
  CachedRouteKind,
  IncrementalCacheKind,
} from "next/dist/server/response-cache";
import { MemoryCacheHandler } from "./memory-cache-handler";

describe("MemoryCacheHandler", () => {
  let handler: MemoryCacheHandler;
  let mockContext: CacheHandlerContext;

  beforeEach(() => {
    mockContext = { dev: false } as CacheHandlerContext;

    handler = new MemoryCacheHandler({
      context: mockContext,
    });
  });

  afterEach(() => {
    handler.clearCache();
  });

  describe("get", () => {
    it("should return null for non-existent cache key", async () => {
      const result = await handler.get("non-existent", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });
      expect(result).toBeNull();
    });

    it("should return cached value from memory", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>test</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      await handler.set("test-key", testData, {
        fetchCache: true as const,
      });
      const result = await handler.get("test-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });

      expect(result).not.toBeNull();
      expect(result?.value).toEqual(testData);
    });
  });

  describe("set", () => {
    it("should store value in memory cache", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>set test</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      await handler.set("set-key", testData, {
        fetchCache: true as const,
      });

      expect(handler.getCacheSize()).toBe(1);

      const result = await handler.get("set-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });
      expect(result?.value).toEqual(testData);
    });
  });

  describe("resetRequestCache", () => {
    it("should clear all caches", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>reset test</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      await handler.set("reset-key", testData, {
        fetchCache: true as const,
      });

      expect(handler.getCacheSize()).toBe(1);

      await handler.resetRequestCache();

      expect(handler.getCacheSize()).toBe(0);
    });
  });
});

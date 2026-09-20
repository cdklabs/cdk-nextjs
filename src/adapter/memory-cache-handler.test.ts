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

  describe("revalidateTag", () => {
    const testData: IncrementalCacheValue = {
      kind: CachedRouteKind.APP_PAGE,
      html: "<html>tagged</html>",
      rscData: undefined,
      headers: undefined,
      postponed: undefined,
      segmentData: undefined,
      status: undefined,
    };

    it("should remove entries tagged with the revalidated tag", async () => {
      await handler.set("tagged-key", testData, {
        fetchCache: true as const,
        tags: ["collection"],
      });

      await handler.revalidateTag("collection");

      const result = await handler.get("tagged-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });
      expect(result).toBeNull();
      expect(handler.getCacheSize()).toBe(0);
    });

    it("should not remove entries with unrelated tags", async () => {
      await handler.set("unrelated-key", testData, {
        fetchCache: true as const,
        tags: ["other-tag"],
      });

      await handler.revalidateTag("collection");

      const result = await handler.get("unrelated-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });
      expect(result).not.toBeNull();
      expect(handler.getCacheSize()).toBe(1);
    });

    it("should accept an array of tags and remove any matching entries", async () => {
      await handler.set("key-a", testData, {
        fetchCache: true as const,
        tags: ["tag-a"],
      });
      await handler.set("key-b", testData, {
        fetchCache: true as const,
        tags: ["tag-b"],
      });

      await handler.revalidateTag(["tag-a", "tag-b"]);

      expect(handler.getCacheSize()).toBe(0);
    });

    it("should be a no-op when no entries match the tag", async () => {
      await handler.set("untagged-key", testData, {
        fetchCache: true as const,
      });

      await expect(
        handler.revalidateTag("nonexistent-tag"),
      ).resolves.not.toThrow();
      expect(handler.getCacheSize()).toBe(1);
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

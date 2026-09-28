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

      await handler.set("test-key", testData);
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

      await handler.set("set-key", testData);

      expect(handler.getCacheSize()).toBe(1);

      const result = await handler.get("set-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });
      expect(result?.value).toEqual(testData);
    });
  });

  describe("set", () => {
    it("keeps the lastModified an entry copied from a slower layer was rendered at", async () => {
      // Stamping the time of the copy made an entry due for regeneration, or
      // one a soft `revalidateTag` had made stale, look freshly rendered.
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>promoted</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };
      const renderedAt = Date.now() - 60_000;

      await handler.set("promoted", testData, renderedAt);

      expect(
        await handler.get("promoted", {
          kind: IncrementalCacheKind.APP_PAGE,
          isFallback: false,
        }),
      ).toEqual({ lastModified: renderedAt, value: testData });
    });

    it("stamps a fresh render on the tag markers' clock, not Date.now()", async () => {
      // A memory hit is judged against tag markers stamped with `markerClock`.
      // With `Date.now()` running ahead of it, a `revalidateTag` inside the
      // drift left the entry looking newer than the marker, and it was served
      // for the whole memory TTL.
      const markerNow = 1_000_000;
      jest.spyOn(performance, "now").mockReturnValue(markerNow);
      jest
        .spyOn(Date, "now")
        .mockReturnValue(performance.timeOrigin + 5 * 60_000 + markerNow);
      try {
        await handler.set("fresh", {
          kind: CachedRouteKind.APP_PAGE,
          html: "<html>fresh</html>",
          rscData: undefined,
          headers: undefined,
          postponed: undefined,
          segmentData: undefined,
          status: undefined,
        });

        const entry = await handler.get("fresh", {
          kind: IncrementalCacheKind.APP_PAGE,
          isFallback: false,
        });
        expect(entry?.lastModified).toBe(performance.timeOrigin + markerNow);
      } finally {
        jest.restoreAllMocks();
      }
    });
  });

  describe("resetRequestCache", () => {
    it("keeps the shared cache across requests", async () => {
      // Next.js calls this at the start of every request, and its own
      // `FileSystemCache` makes it a no-op; clearing here meant no entry ever
      // survived to a second request.
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>reset test</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      await handler.set("reset-key", testData);

      expect(handler.getCacheSize()).toBe(1);

      await handler.resetRequestCache();

      expect(handler.getCacheSize()).toBe(1);
    });
  });
});

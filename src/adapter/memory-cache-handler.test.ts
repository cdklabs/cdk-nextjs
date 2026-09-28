/* eslint-disable import/no-extraneous-dependencies */
import {
  IncrementalCacheValue,
  CachedRouteKind,
} from "next/dist/server/response-cache";
import { MemoryCacheHandler } from "./memory-cache-handler";

describe("MemoryCacheHandler", () => {
  let handler: MemoryCacheHandler;

  beforeEach(() => {
    handler = new MemoryCacheHandler();
  });

  afterEach(() => {
    handler.clearCache();
  });

  describe("get", () => {
    it("should return null for non-existent cache key", async () => {
      const result = await handler.get("non-existent");
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
      const result = await handler.get("test-key");

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

      const result = await handler.get("set-key");
      expect(result?.value).toEqual(testData);
    });

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

      expect(await handler.get("promoted")).toEqual({
        lastModified: renderedAt,
        value: testData,
      });
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

        const entry = await handler.get("fresh");
        expect(entry?.lastModified).toBe(performance.timeOrigin + markerNow);
      } finally {
        jest.restoreAllMocks();
      }
    });
  });

  describe("bounds", () => {
    const page = (html: string): IncrementalCacheValue => ({
      kind: CachedRouteKind.APP_PAGE,
      html,
      rscData: undefined,
      headers: undefined,
      postponed: undefined,
      segmentData: undefined,
      status: undefined,
    });
    const env = process.env;

    beforeEach(() => {
      process.env = { ...env };
    });
    afterEach(() => {
      process.env = env;
      jest.restoreAllMocks();
    });

    it("drops an entry past its TTL on read", async () => {
      process.env.CDK_NEXTJS_MEMORY_CACHE_TTL_MS = "1000";
      const clock = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
      handler = new MemoryCacheHandler();
      await handler.set("a", page("a"));

      clock.mockReturnValue(1_001_000);
      expect(await handler.get("a")).not.toBeNull();
      clock.mockReturnValue(1_001_001);
      expect(await handler.get("a")).toBeNull();
      expect(handler.getCacheSize()).toBe(0);
    });

    it("clears every expired entry on the next write", async () => {
      process.env.CDK_NEXTJS_MEMORY_CACHE_TTL_MS = "1000";
      const clock = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
      handler = new MemoryCacheHandler();
      await handler.set("a", page("a"));
      await handler.set("b", page("b"));

      clock.mockReturnValue(1_002_000);
      await handler.set("c", page("c"));
      expect(handler.getCacheSize()).toBe(1);
    });

    it("evicts the least recently used entry at the limit", async () => {
      process.env.CDK_NEXTJS_MEMORY_CACHE_MAX_ENTRIES = "2";
      handler = new MemoryCacheHandler();
      await handler.set("a", page("a"));
      await handler.set("b", page("b"));
      // A read makes `a` the most recently used.
      await handler.get("a");
      await handler.set("c", page("c"));

      expect(handler.getCacheSize()).toBe(2);
      expect(await handler.get("b")).toBeNull();
      expect(await handler.get("a")).not.toBeNull();
      expect(await handler.get("c")).not.toBeNull();
    });

    it("falls back to the defaults for values that are not numbers", async () => {
      // As NaN, nothing expired and nothing was evicted: an unbounded map.
      process.env.CDK_NEXTJS_MEMORY_CACHE_TTL_MS = "abc";
      process.env.CDK_NEXTJS_MEMORY_CACHE_MAX_ENTRIES = "abc";
      const clock = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
      handler = new MemoryCacheHandler();
      for (let i = 0; i <= 1000; i++) {
        await handler.set(`k${i}`, page("x"));
      }
      expect(handler.getCacheSize()).toBe(1000);

      clock.mockReturnValue(1_000_000 + 60 * 60 * 1000 + 1);
      expect(await handler.get("k1000")).toBeNull();
    });
  });
});

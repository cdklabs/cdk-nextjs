/* eslint-disable import/no-extraneous-dependencies */
import { CacheHandlerContext } from "next/dist/server/lib/incremental-cache";
import {
  IncrementalCacheValue,
  GetIncrementalResponseCacheContext,
  CachedRouteKind,
  IncrementalCacheKind,
} from "next/dist/server/response-cache";
import CdkNextjsCacheHandler from "./cdk-nextjs-cache-handler";

// Mock AWS SDK clients
jest.mock("@aws-sdk/client-s3");
jest.mock("@aws-sdk/client-dynamodb");

describe("CdkNextjsCacheHandler - Composable Cache", () => {
  let cacheHandler: CdkNextjsCacheHandler;

  // Create properly typed mock data using type assertions
  const createMockCacheData = (): IncrementalCacheValue => ({
    kind: CachedRouteKind.APP_PAGE,
    html: "test-html",
    rscData: undefined,
    headers: undefined,
    postponed: undefined,
    status: 200,
    segmentData: undefined,
  });

  const createMockContext = (): CacheHandlerContext => ({
    dev: false,
    revalidatedTags: [],
    _requestHeaders: {},
  });

  const createMockGetContext = (): GetIncrementalResponseCacheContext => ({
    kind: IncrementalCacheKind.APP_PAGE,
    isFallback: false,
  });

  beforeEach(() => {
    // Reset environment variables
    delete process.env.CDK_NEXTJS_CACHE_BUCKET_NAME;
    delete process.env.CDK_NEXTJS_REVALIDATION_TABLE_NAME;
    delete process.env.AWS_REGION;

    const mockContext = createMockContext();
    cacheHandler = new CdkNextjsCacheHandler(mockContext);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("Basic In-Memory Operations", () => {
    it("should store and retrieve cache entries in memory", async () => {
      const cacheKey = "test-cache-key";
      const testData = createMockCacheData();
      const ctx = { tags: ["test-tag"] };

      // Store data in cache
      await cacheHandler.set(cacheKey, testData, ctx);

      // Retrieve data from cache
      const getCtx = createMockGetContext();
      const result = await cacheHandler.get(cacheKey, getCtx);

      // Verify the data was stored and retrieved correctly
      expect(result).toBeDefined();
      expect(result?.value).toEqual(testData);
      expect(result?.lastModified).toBeGreaterThan(0);
    });

    it("should return null for non-existent cache keys", async () => {
      const getCtx = createMockGetContext();
      const result = await cacheHandler.get("non-existent-key", getCtx);

      expect(result).toBeNull();
    });
  });

  describe("Tag-based Cache Management", () => {
    it("should track tags for cache entries", async () => {
      const cacheKey1 = "cache-key-1";
      const cacheKey2 = "cache-key-2";
      const testData = createMockCacheData();

      // Store entries with tags
      await cacheHandler.set(cacheKey1, testData, {
        tags: ["tag1", "tag2"],
      });
      await cacheHandler.set(cacheKey2, testData, {
        tags: ["tag2", "tag3"],
      });

      // Verify entries are in memory cache
      const getCtx = createMockGetContext();

      expect(await cacheHandler.get(cacheKey1, getCtx)).toBeDefined();
      expect(await cacheHandler.get(cacheKey2, getCtx)).toBeDefined();

      // Revalidate tag2 (should clear both entries from memory)
      await cacheHandler.revalidateTag("tag2");

      // Both entries should be cleared from memory cache
      expect(await cacheHandler.get(cacheKey1, getCtx)).toBeNull();
      expect(await cacheHandler.get(cacheKey2, getCtx)).toBeNull();
    });

    it("should only clear cache entries with the revalidated tag", async () => {
      const cacheKey1 = "cache-key-1";
      const cacheKey2 = "cache-key-2";
      const cacheKey3 = "cache-key-3";
      const testData = createMockCacheData();

      // Store entries with different tags
      await cacheHandler.set(cacheKey1, testData, { tags: ["tag1"] });
      await cacheHandler.set(cacheKey2, testData, { tags: ["tag2"] });
      await cacheHandler.set(cacheKey3, testData, {
        tags: ["tag1", "tag2"],
      });

      // Revalidate only tag1
      await cacheHandler.revalidateTag("tag1");

      const getCtx = createMockGetContext();

      // Only entries with tag1 should be cleared
      expect(await cacheHandler.get(cacheKey1, getCtx)).toBeNull();
      expect(await cacheHandler.get(cacheKey2, getCtx)).toBeDefined(); // Should still exist
      expect(await cacheHandler.get(cacheKey3, getCtx)).toBeNull();
    });

    it("should handle cache entries without tags", async () => {
      const cacheKey = "no-tags-key";
      const testData = createMockCacheData();

      // Store entry without tags
      await cacheHandler.set(cacheKey, testData, { tags: [] });

      const getCtx = createMockGetContext();

      // Should be retrievable
      expect(await cacheHandler.get(cacheKey, getCtx)).toBeDefined();

      // Revalidating any tag shouldn't affect this entry
      await cacheHandler.revalidateTag("some-tag");
      expect(await cacheHandler.get(cacheKey, getCtx)).toBeDefined();
    });

    it("should handle array of tags for revalidation", async () => {
      const cacheKey1 = "cache-key-1";
      const cacheKey2 = "cache-key-2";
      const cacheKey3 = "cache-key-3";
      const testData = createMockCacheData();

      // Store entries with different tags
      await cacheHandler.set(cacheKey1, testData, { tags: ["tag1"] });
      await cacheHandler.set(cacheKey2, testData, { tags: ["tag2"] });
      await cacheHandler.set(cacheKey3, testData, { tags: ["tag3"] });

      // Verify entries are in memory cache
      const getCtx = createMockGetContext();
      expect(await cacheHandler.get(cacheKey1, getCtx)).toBeDefined();
      expect(await cacheHandler.get(cacheKey2, getCtx)).toBeDefined();
      expect(await cacheHandler.get(cacheKey3, getCtx)).toBeDefined();

      // Revalidate multiple tags at once
      await cacheHandler.revalidateTag(["tag1", "tag2"]);

      // Only entries with tag1 and tag2 should be cleared
      expect(await cacheHandler.get(cacheKey1, getCtx)).toBeNull();
      expect(await cacheHandler.get(cacheKey2, getCtx)).toBeNull();
      expect(await cacheHandler.get(cacheKey3, getCtx)).toBeDefined(); // Should still exist
    });

    it("should handle single tag as string for backward compatibility", async () => {
      const cacheKey = "single-tag-key";
      const testData = createMockCacheData();

      // Store entry with tag
      await cacheHandler.set(cacheKey, testData, { tags: ["single-tag"] });

      const getCtx = createMockGetContext();
      expect(await cacheHandler.get(cacheKey, getCtx)).toBeDefined();

      // Revalidate single tag as string
      await cacheHandler.revalidateTag("single-tag");

      // Entry should be cleared
      expect(await cacheHandler.get(cacheKey, getCtx)).toBeNull();
    });
  });

  describe("Cache Reset", () => {
    it("should clear all memory caches on reset", async () => {
      const cacheKey = "reset-test-key";
      const testData = createMockCacheData();

      // Store data with tags
      await cacheHandler.set(cacheKey, testData, { tags: ["test-tag"] });

      // Verify data is cached
      const getCtx = createMockGetContext();
      expect(await cacheHandler.get(cacheKey, getCtx)).toBeDefined();

      // Reset cache
      await cacheHandler.resetRequestCache();

      // Data should be cleared
      expect(await cacheHandler.get(cacheKey, getCtx)).toBeNull();

      // Health status should show empty caches
      const health = cacheHandler.getCompositeHealthStatus();
      expect(health.memoryLayer.memoryCacheSize).toBe(0);
      expect(health.memoryLayer.tagCacheSize).toBe(0);
    });
  });

  describe("Health Status", () => {
    it("should report correct cache sizes", async () => {
      const testData = createMockCacheData();

      // Initially empty
      let health = cacheHandler.getCompositeHealthStatus();
      expect(health.memoryLayer.memoryCacheSize).toBe(0);
      expect(health.memoryLayer.tagCacheSize).toBe(0);

      // Add some cache entries
      await cacheHandler.set("key1", testData, { tags: ["tag1"] });
      await cacheHandler.set("key2", testData, {
        tags: ["tag1", "tag2"],
      });
      await cacheHandler.set("key3", testData, { tags: [] });

      health = cacheHandler.getCompositeHealthStatus();
      expect(health.memoryLayer.memoryCacheSize).toBe(3);
      expect(health.memoryLayer.tagCacheSize).toBe(2); // tag1 and tag2
    });

    it("should report circuit breaker status", () => {
      const health = cacheHandler.getCompositeHealthStatus();

      expect(health.s3DynamoLayer.s3Available).toBe(true);
      expect(health.s3DynamoLayer.dynamoAvailable).toBe(true);
      expect(health.s3DynamoLayer.circuitBreakerStatus.s3Failures).toBe(0);
      expect(health.s3DynamoLayer.circuitBreakerStatus.dynamoFailures).toBe(0);
    });
  });

  describe("Manual Operations", () => {
    it("should allow manual circuit breaker reset", () => {
      // Reset circuit breakers
      cacheHandler.resetCircuitBreakers();

      const health = cacheHandler.getCompositeHealthStatus();
      expect(health.s3DynamoLayer.circuitBreakerStatus.s3Failures).toBe(0);
      expect(health.s3DynamoLayer.circuitBreakerStatus.dynamoFailures).toBe(0);
      expect(health.s3DynamoLayer.circuitBreakerStatus.lastFailureTime).toBe(0);
    });

    it("should allow manual tag cache clearing", async () => {
      const testData = createMockCacheData();

      // Add tagged entries
      await cacheHandler.set("key1", testData, { tags: ["tag1"] });

      expect(
        cacheHandler.getCompositeHealthStatus().memoryLayer.tagCacheSize,
      ).toBe(1);

      // Clear cache (using the available method)
      cacheHandler.clearCache();

      expect(
        cacheHandler.getCompositeHealthStatus().memoryLayer.tagCacheSize,
      ).toBe(0);
    });
  });
});

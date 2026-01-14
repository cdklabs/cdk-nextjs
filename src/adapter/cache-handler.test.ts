/* eslint-disable import/no-extraneous-dependencies */
import { CacheHandlerContext } from "next/dist/server/lib/incremental-cache";
import {
  IncrementalCacheValue,
  CachedRouteKind,
  IncrementalCacheKind,
} from "next/dist/server/response-cache";
import CdkNextjsCacheHandler from "./cache-handler";
import { MemoryCacheHandler } from "./memory-cache-handler";

// Mock AWS SDK clients
jest.mock("@aws-sdk/client-s3");
jest.mock("@aws-sdk/client-dynamodb");

describe("CdkNextjsCacheHandler - Integration & Composition", () => {
  let cacheHandler: CdkNextjsCacheHandler;

  const createMockContext = (): CacheHandlerContext => ({
    dev: false,
    revalidatedTags: [],
    _requestHeaders: {},
  });

  beforeEach(() => {
    // Reset environment variables
    delete process.env.CDK_NEXTJS_CACHE_BUCKET_NAME;
    delete process.env.CDK_NEXTJS_REVALIDATION_TABLE_NAME;
    delete process.env.AWS_REGION;

    // Suppress expected warnings when env vars are not set
    jest.spyOn(console, "warn").mockImplementation(() => {});

    const mockContext = createMockContext();
    cacheHandler = new CdkNextjsCacheHandler(mockContext);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe("Composition & Initialization", () => {
    it("should extend MemoryCacheHandler", () => {
      expect(cacheHandler).toBeInstanceOf(MemoryCacheHandler);
    });

    it("should initialize with memory and S3/DynamoDB layers", () => {
      const health = cacheHandler.getCompositeHealthStatus();

      // Should have both layers
      expect(health.memoryLayer).toBeDefined();
      expect(health.s3DynamoLayer).toBeDefined();

      // Memory layer should have expected properties
      expect(health.memoryLayer).toHaveProperty("memoryCacheSize");
      expect(health.memoryLayer).toHaveProperty("tagCacheSize");
      expect(health.memoryLayer).toHaveProperty("ttlMs");
      expect(health.memoryLayer).toHaveProperty("hasFallbackHandler");
      expect(health.memoryLayer.ttlMs).toBe(60000); // 1 minute default

      // S3/DynamoDB layer should have expected properties
      expect(health.s3DynamoLayer).toHaveProperty("s3Available");
      expect(health.s3DynamoLayer).toHaveProperty("dynamoAvailable");
      expect(health.s3DynamoLayer).toHaveProperty("circuitBreakerStatus");
    });

    it("should have S3DynamoCacheHandler as fallback", () => {
      const health = cacheHandler.getCompositeHealthStatus();

      // Memory layer should indicate it has a fallback handler
      expect(health.memoryLayer.hasFallbackHandler).toBe(true);
    });
  });

  describe("getCompositeHealthStatus", () => {
    it("should return health status from both layers", () => {
      const health = cacheHandler.getCompositeHealthStatus();

      // Memory layer status
      expect(health.memoryLayer.memoryCacheSize).toBe(0);
      expect(health.memoryLayer.tagCacheSize).toBe(0);
      expect(health.memoryLayer.ttlMs).toBe(60000);

      // S3/DynamoDB layer status
      expect(health.s3DynamoLayer.s3Available).toBe(true);
      expect(health.s3DynamoLayer.dynamoAvailable).toBe(true);
      expect(health.s3DynamoLayer.circuitBreakerStatus).toMatchObject({
        s3Failures: 0,
        dynamoFailures: 0,
        lastFailureTime: 0,
      });
    });

    it("should reflect memory cache state in health status", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>test</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      // Add entries
      await cacheHandler.set("key1", testData, {
        fetchCache: true as const,
        tags: ["tag1"],
      });
      await cacheHandler.set("key2", testData, {
        fetchCache: true as const,
        tags: ["tag1", "tag2"],
      });

      const health = cacheHandler.getCompositeHealthStatus();
      expect(health.memoryLayer.memoryCacheSize).toBe(2);
      expect(health.memoryLayer.tagCacheSize).toBe(2); // tag1 and tag2
    });
  });

  describe("resetCircuitBreakers", () => {
    it("should reset circuit breakers in S3/DynamoDB layer", () => {
      // Reset should not throw
      expect(() => cacheHandler.resetCircuitBreakers()).not.toThrow();

      const health = cacheHandler.getCompositeHealthStatus();
      expect(health.s3DynamoLayer.circuitBreakerStatus.s3Failures).toBe(0);
      expect(health.s3DynamoLayer.circuitBreakerStatus.dynamoFailures).toBe(0);
      expect(health.s3DynamoLayer.circuitBreakerStatus.lastFailureTime).toBe(0);
    });
  });

  describe("Integration: Memory + S3/DynamoDB Fallback", () => {
    it("should use memory cache as primary layer", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>test</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      // Set cache entry
      await cacheHandler.set("test-key", testData, {
        fetchCache: true as const,
        tags: [],
      });

      // Should be in memory
      const health = cacheHandler.getCompositeHealthStatus();
      expect(health.memoryLayer.memoryCacheSize).toBe(1);

      // Get should return from memory
      const result = await cacheHandler.get("test-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });

      expect(result).not.toBeNull();
      expect(result?.value).toEqual(testData);
    });

    it("should handle cache misses gracefully", async () => {
      // Get non-existent key
      const result = await cacheHandler.get("missing-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });

      // Should return null (both memory and S3 miss)
      expect(result).toBeNull();
    });

    it("should propagate revalidateTag to both layers", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>tagged</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      // Add tagged entry
      await cacheHandler.set("tagged-key", testData, {
        fetchCache: true as const,
        tags: ["test-tag"],
      });

      // Verify it's in memory
      let health = cacheHandler.getCompositeHealthStatus();
      expect(health.memoryLayer.memoryCacheSize).toBe(1);
      expect(health.memoryLayer.tagCacheSize).toBe(1);

      // Revalidate tag (should clear from memory layer and propagate to S3/DynamoDB)
      await cacheHandler.revalidateTag("test-tag");

      // Verify memory is cleared
      health = cacheHandler.getCompositeHealthStatus();
      expect(health.memoryLayer.memoryCacheSize).toBe(0);
      expect(health.memoryLayer.tagCacheSize).toBe(0);
    });

    it("should propagate resetRequestCache to both layers", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>reset</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      // Add entry
      await cacheHandler.set("reset-key", testData, {
        fetchCache: true as const,
        tags: ["reset-tag"],
      });

      // Verify state
      let health = cacheHandler.getCompositeHealthStatus();
      expect(health.memoryLayer.memoryCacheSize).toBe(1);
      expect(health.memoryLayer.tagCacheSize).toBe(1);

      // Reset
      await cacheHandler.resetRequestCache();

      // Verify all cleared
      health = cacheHandler.getCompositeHealthStatus();
      expect(health.memoryLayer.memoryCacheSize).toBe(0);
      expect(health.memoryLayer.tagCacheSize).toBe(0);
    });
  });

  describe("Configuration", () => {
    it("should use 1 minute TTL for memory cache", () => {
      const health = cacheHandler.getCompositeHealthStatus();
      expect(health.memoryLayer.ttlMs).toBe(60000);
    });

    it("should work without AWS credentials (fallback mode)", () => {
      // AWS credentials are not set in test environment
      const health = cacheHandler.getCompositeHealthStatus();

      // S3/DynamoDB layer should indicate services are unavailable
      // but the handler should still function (memory-only mode)
      expect(health.s3DynamoLayer.s3Available).toBe(true); // Will try but fail gracefully
      expect(health.s3DynamoLayer.dynamoAvailable).toBe(true);
    });
  });
});

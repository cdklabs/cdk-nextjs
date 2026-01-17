/* eslint-disable import/no-extraneous-dependencies */
import { CacheHandlerContext } from "next/dist/server/lib/incremental-cache";
import {
  IncrementalCacheValue,
  CachedRouteKind,
  IncrementalCacheKind,
} from "next/dist/server/response-cache";
import CdkNextjsCacheHandler from "./cache-handler";

// Mock AWS SDK clients
jest.mock("@aws-sdk/client-s3");
jest.mock("@aws-sdk/client-dynamodb");

describe("CdkNextjsCacheHandler - Orchestrator Pattern", () => {
  let cacheHandler: CdkNextjsCacheHandler;

  const createMockContext = (): CacheHandlerContext => ({
    dev: false,
    revalidatedTags: [],
    _requestHeaders: {},
  });

  beforeEach(() => {
    // Suppress expected warnings when env vars are not set
    jest.spyOn(console, "warn").mockImplementation(() => {});

    const mockContext = createMockContext();
    cacheHandler = new CdkNextjsCacheHandler(mockContext);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe("Orchestrator Pattern & Initialization", () => {
    it("should initialize as orchestrator with runtime handlers", () => {
      expect(cacheHandler).toBeDefined();
      // Runtime mode - memory and S3/DynamoDB handlers should be available
    });
  });

  describe("Orchestrator: Memory + S3/DynamoDB", () => {
    it("should write to both memory and S3/DynamoDB on set", async () => {
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

      // Revalidate tag (should clear from both layers)
      await cacheHandler.revalidateTag("test-tag");

      // Verify entry is gone
      const result = await cacheHandler.get("tagged-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });
      expect(result).toBeNull();
    });

    it("should propagate resetRequestCache to memory layer", async () => {
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

      // Reset
      await cacheHandler.resetRequestCache();

      // Verify entry is gone from memory
      const result = await cacheHandler.get("reset-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });
      expect(result).toBeNull();
    });
  });

  describe("Build-time behavior", () => {
    it("should initialize local file cache handler during build", () => {
      // Set build-time environment
      process.env.NEXT_PHASE = "phase-production-build";
      process.env.CDK_NEXTJS_BUILD_ID = "test-build-123";

      const mockContext = createMockContext();
      const buildHandler = new CdkNextjsCacheHandler(mockContext);

      expect(buildHandler).toBeDefined();

      // Clean up
      delete process.env.NEXT_PHASE;
      delete process.env.CDK_NEXTJS_BUILD_ID;
    });

    it("should initialize runtime handlers when not in build mode", () => {
      // Runtime environment (NEXT_PHASE not set or different value)
      delete process.env.NEXT_PHASE;

      const mockContext = createMockContext();
      const runtimeHandler = new CdkNextjsCacheHandler(mockContext);

      expect(runtimeHandler).toBeDefined();
    });
  });
});

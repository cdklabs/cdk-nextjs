/* eslint-disable import/no-extraneous-dependencies */
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CacheHandlerContext } from "next/dist/server/lib/incremental-cache";
import {
  IncrementalCacheValue,
  CachedRouteKind,
  IncrementalCacheKind,
} from "next/dist/server/response-cache";
import type { GetIncrementalFetchCacheContext } from "next/dist/server/response-cache";
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
    // Clean up env vars
    delete process.env.CDK_NEXTJS_MEMORY_CACHE_TTL_MS;
    // Reset singleton handlers by accessing the class's static properties
    // This ensures each test gets fresh handlers
    (CdkNextjsCacheHandler as any).sharedMemoryHandler = null;
    (CdkNextjsCacheHandler as any).sharedS3DynamoHandler = null;
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

    it("does not copy a tag-expired S3 entry into memory", async () => {
      // `lastModified: -1` is the S3 layer saying "a tag revalidation expired
      // this, re-render before answering". `MemoryCacheHandler.set` stamps
      // `lastModified: Date.now()`, so copying it into memory would present the
      // expired body as fresh and hide the revalidation from Next.js until the
      // memory entry's TTL ran out.
      const value: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>expired</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };
      const getCtx = {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      } as const;

      (cacheHandler as any).s3DynamoHandler = {
        get: jest.fn().mockResolvedValue({ lastModified: -1, value }),
      };
      expect(await cacheHandler.get("isr/1", getCtx)).toEqual({
        lastModified: -1,
        value,
      });

      // With the S3 layer now silent, a memory copy would answer this as a hit.
      (cacheHandler as any).s3DynamoHandler = {
        get: jest.fn().mockResolvedValue(null),
      };
      expect(await cacheHandler.get("isr/1", getCtx)).toBeNull();
    });

    it("copies a live S3 entry into memory", async () => {
      const value: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>live</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };
      const getCtx = {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      } as const;

      (cacheHandler as any).s3DynamoHandler = {
        get: jest.fn().mockResolvedValue({ lastModified: Date.now(), value }),
      };
      await cacheHandler.get("isr/2", getCtx);

      const s3 = { get: jest.fn().mockResolvedValue(null) };
      (cacheHandler as any).s3DynamoHandler = s3;
      expect(await cacheHandler.get("isr/2", getCtx)).toMatchObject({ value });
      expect(s3.get).not.toHaveBeenCalled();
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

    it("reads back a fetch entry it wrote, from memory and from disk", async () => {
      // `cacheComponents` prerenders each page twice: the first pass runs the
      // `fetch` and `set`s it, the second must find it already cached or Next.js
      // fails the build with "encountered uncached or runtime data during
      // prerendering". A write-only build-time handler therefore makes
      // `cache: 'force-cache'` unbuildable - measured against next.js's
      // `test/e2e/app-dir/resume-data-cache`.
      process.env.NEXT_PHASE = "phase-production-build";
      process.env.CDK_NEXTJS_INIT_CACHE_DIR = mkdtempSync(
        join(tmpdir(), "cdk-nextjs-init-cache-"),
      );
      try {
        const data: IncrementalCacheValue = {
          kind: CachedRouteKind.FETCH,
          data: {
            headers: {},
            body: "eyJyYW5kb20iOjF9",
            status: 200,
            url: "https://example.test/api/random",
          },
          revalidate: 31536000,
        };
        const fetchUrl = "https://example.test/api/random";
        const setCtx = {
          fetchCache: true as const,
          tags: ["test"],
          fetchUrl,
          fetchIdx: 1,
        };
        const getCtx: GetIncrementalFetchCacheContext = {
          kind: IncrementalCacheKind.FETCH,
          revalidate: 31536000,
          fetchUrl,
          fetchIdx: 1,
          tags: ["test"],
        };
        const buildHandler = new CdkNextjsCacheHandler(createMockContext());
        await buildHandler.set("fetch-key", data, setCtx);
        expect(await buildHandler.get("fetch-key", getCtx)).toMatchObject({
          value: data,
        });

        // A second instance reads the file rather than the map: `next build`
        // renders pages in worker processes, so the pass that writes and the
        // pass that reads are not always the same process.
        const otherWorker = new CdkNextjsCacheHandler(createMockContext());
        expect(await otherWorker.get("fetch-key", getCtx)).toMatchObject({
          value: data,
        });
        expect(await otherWorker.get("never-written", getCtx)).toBeNull();
      } finally {
        delete process.env.NEXT_PHASE;
        delete process.env.CDK_NEXTJS_INIT_CACHE_DIR;
      }
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

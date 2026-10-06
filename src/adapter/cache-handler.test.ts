/* eslint-disable import/no-extraneous-dependencies */
import { existsSync, mkdtempSync } from "fs";
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
import { cacheObjectName } from "./cache-utils";

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

      const s3 = {
        set: jest.fn().mockResolvedValue(undefined),
        get: jest.fn().mockResolvedValue(null),
        isRevalidated: jest.fn().mockResolvedValue(false),
      };
      (cacheHandler as any).s3DynamoHandler = s3;
      const setCtx = { fetchCache: true as const, tags: [] };

      // Set cache entry
      await cacheHandler.set("test-key", testData, setCtx);

      // S3/DynamoDB got the write, with the context it needs for tags.
      expect(s3.set).toHaveBeenCalledWith("test-key", testData, setCtx);

      // Get should return from memory, without asking S3.
      const result = await cacheHandler.get("test-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });

      expect(result).not.toBeNull();
      expect(result?.value).toEqual(testData);
      expect(s3.get).not.toHaveBeenCalled();
    });

    it("deletes from both layers on set(key, null)", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>gone</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };
      const s3 = {
        set: jest.fn().mockResolvedValue(undefined),
        get: jest.fn().mockResolvedValue(null),
        isRevalidated: jest.fn().mockResolvedValue(false),
      };
      (cacheHandler as any).s3DynamoHandler = s3;
      const setCtx = { fetchCache: true as const, tags: [] };
      await cacheHandler.set("gone-key", testData, setCtx);

      await cacheHandler.set("gone-key", null, setCtx);

      // The S3 layer is told to delete, not skipped.
      expect(s3.set).toHaveBeenLastCalledWith("gone-key", null, setCtx);
      // And memory no longer answers: the read falls through to S3.
      expect(
        await cacheHandler.get("gone-key", {
          kind: IncrementalCacheKind.APP_PAGE,
          isFallback: false,
        }),
      ).toBeNull();
      expect(s3.get).toHaveBeenCalledTimes(1);
    });

    it("revalidates a tag in S3/DynamoDB, passing the durations through", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>tagged</html>",
        rscData: undefined,
        headers: { "x-next-cache-tags": "posts" },
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };
      const s3 = {
        set: jest.fn().mockResolvedValue(undefined),
        get: jest.fn().mockResolvedValue(null),
        isRevalidated: jest.fn().mockResolvedValue(false),
        revalidateTag: jest.fn().mockResolvedValue(undefined),
      };
      (cacheHandler as any).s3DynamoHandler = s3;

      await cacheHandler.set("tagged-key", testData, {
        fetchCache: true as const,
        tags: ["posts"],
      });
      // `revalidateTag(tag, profile)`: the durations decide stale vs expired,
      // so dropping them turns every soft revalidation into a hard one.
      await cacheHandler.revalidateTag(["posts"], { expire: 60 });

      expect(s3.revalidateTag).toHaveBeenCalledWith(["posts"], { expire: 60 });

      await cacheHandler.revalidateTag("posts");
      expect(s3.revalidateTag).toHaveBeenLastCalledWith("posts", undefined);
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
      // this, re-render before answering". Copied into memory, the expired body
      // would be answered from there instead of from the re-render.
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

      const s3 = {
        get: jest.fn().mockResolvedValue(null),
        isRevalidated: jest.fn().mockResolvedValue(false),
      };
      (cacheHandler as any).s3DynamoHandler = s3;
      expect(await cacheHandler.get("isr/2", getCtx)).toMatchObject({ value });
      expect(s3.get).not.toHaveBeenCalled();
    });

    it("keeps the S3 entry's lastModified when copying it into memory", async () => {
      // Next.js ages the entry from `lastModified`, and the tag markers are
      // compared against it. Stamping the time of the copy made a page a soft
      // `revalidateTag` had made stale look newer than the stale mark.
      const value: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>old</html>",
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
      const renderedAt = Date.now() - 60_000;

      (cacheHandler as any).s3DynamoHandler = {
        get: jest.fn().mockResolvedValue({ lastModified: renderedAt, value }),
      };
      await cacheHandler.get("isr/3", getCtx);

      const s3 = {
        get: jest.fn().mockResolvedValue(null),
        isRevalidated: jest.fn().mockResolvedValue(false),
      };
      (cacheHandler as any).s3DynamoHandler = s3;
      expect(await cacheHandler.get("isr/3", getCtx)).toEqual({
        lastModified: renderedAt,
        value,
      });
      expect(s3.isRevalidated).toHaveBeenCalledWith(
        { lastModified: renderedAt, value },
        getCtx,
        "isr/3",
      );
    });

    it("does not serve a memory hit another instance's revalidateTag expired", async () => {
      // `revalidateTag` clears only the memory of the instance that ran it. Any
      // other instance holding the page in memory answered from it for the
      // whole memory TTL, and CloudFront - just invalidated - cached the stale
      // page again. So a memory hit is checked against the tag markers too.
      const value: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>stale</html>",
        rscData: undefined,
        headers: { "x-next-cache-tags": "_N_T_/blog" },
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
      await cacheHandler.get("blog", getCtx);

      // Another instance revalidated `_N_T_/blog`: the marker is newer than the
      // memory copy, and S3 now answers with the entry expired.
      const s3 = {
        get: jest.fn().mockResolvedValue({ lastModified: -1, value }),
        isRevalidated: jest.fn().mockResolvedValue(true),
      };
      (cacheHandler as any).s3DynamoHandler = s3;
      expect(await cacheHandler.get("blog", getCtx)).toEqual({
        lastModified: -1,
        value,
      });
      expect(s3.isRevalidated).toHaveBeenCalledWith(
        expect.objectContaining({ value }),
        getCtx,
        "blog",
      );
      expect(s3.get).toHaveBeenCalledTimes(1);

      // And the memory copy is gone rather than checked again next time.
      s3.get.mockResolvedValue(null);
      expect(await cacheHandler.get("blog", getCtx)).toBeNull();
    });

    it("keeps memory entries across resetRequestCache", async () => {
      // Next.js calls it at the start of every request; clearing the shared
      // memory cache there sent every read to S3.
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

      // Still answered from memory, without asking S3.
      const s3 = {
        get: jest.fn().mockResolvedValue(null),
        isRevalidated: jest.fn().mockResolvedValue(false),
      };
      (cacheHandler as any).s3DynamoHandler = s3;
      const result = await cacheHandler.get("reset-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });
      expect(result?.value).toEqual(testData);
      expect(s3.get).not.toHaveBeenCalled();
    });
  });

  describe("Build-time behavior", () => {
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

    // The seed is uploaded as written, so it must be filed under the name the
    // runtime's `get` reads: for a name too long for S3, `cacheObjectName`'s.
    it("files an over-long key where the runtime reads it", async () => {
      process.env.NEXT_PHASE = "phase-production-build";
      const cacheDir = mkdtempSync(join(tmpdir(), "cdk-nextjs-init-cache-"));
      process.env.CDK_NEXTJS_INIT_CACHE_DIR = cacheDir;
      try {
        const key = `/route-cache/APP_PAGE/${"a".repeat(64)}/$/${"x".repeat(900)}`;
        expect(cacheObjectName(key)).toMatch(/^_long-key\//);
        const data: IncrementalCacheValue = {
          kind: CachedRouteKind.FETCH,
          data: { headers: {}, body: "e30=", status: 200, url: "" },
          revalidate: 60,
        };
        const setCtx = { fetchCache: true as const, tags: [] };
        await new CdkNextjsCacheHandler(createMockContext()).set(
          key,
          data,
          setCtx,
        );
        expect(existsSync(join(cacheDir, cacheObjectName(key)))).toBe(true);
        const getCtx: GetIncrementalFetchCacheContext = {
          kind: IncrementalCacheKind.FETCH,
          revalidate: 60,
          tags: [],
        };
        expect(
          await new CdkNextjsCacheHandler(createMockContext()).get(key, getCtx),
        ).toMatchObject({ value: data });
      } finally {
        delete process.env.NEXT_PHASE;
        delete process.env.CDK_NEXTJS_INIT_CACHE_DIR;
      }
    });
  });
});

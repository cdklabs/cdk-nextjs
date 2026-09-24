/* eslint-disable import/no-extraneous-dependencies */
// Mock AWS SDK
jest.mock("@aws-sdk/client-s3");
jest.mock("@aws-sdk/client-dynamodb");
jest.mock("@aws-sdk/client-cloudfront");
jest.mock("@aws-sdk/client-ssm");

import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";
import { CacheHandlerContext } from "next/dist/server/lib/incremental-cache";
import {
  IncrementalCacheValue,
  CachedRouteKind,
  IncrementalCacheKind,
} from "next/dist/server/response-cache";
import { S3CacheHandler } from "./s3-cache-handler";

const mockS3Send = jest.fn();
const mockDynamoSend = jest.fn();
const mockCloudFrontSend = jest.fn();
const mockSsmSend = jest.fn();

(S3Client as jest.Mock).mockImplementation(() => ({
  send: mockS3Send,
}));

(DynamoDBClient as jest.Mock).mockImplementation(() => ({
  send: mockDynamoSend,
}));

(CloudFrontClient as jest.Mock).mockImplementation(() => ({
  send: mockCloudFrontSend,
}));

(SSMClient as jest.Mock).mockImplementation(() => ({
  send: mockSsmSend,
}));

describe("S3DynamoCacheHandler", () => {
  let handler: S3CacheHandler;
  let mockContext: CacheHandlerContext;

  // Helper to create set context with tags
  const createSetContext = (tags: string[]) => ({
    fetchCache: true as const,
    tags,
  });

  /**
   * Answer DynamoDB by command type rather than by call order: `revalidateTag`
   * writes its tag marker before querying the tag's mapping rows, and which of
   * those comes first is an implementation detail.
   */
  const dynamoResponses = (responses: { query?: unknown; get?: unknown }) => {
    mockDynamoSend.mockImplementation((command: unknown) => {
      if (command instanceof QueryCommand) {
        return Promise.resolve(responses.query ?? {});
      }
      if (command instanceof GetItemCommand) {
        return Promise.resolve(responses.get ?? {});
      }
      return Promise.resolve({});
    });
  };

  beforeEach(() => {
    mockContext = { dev: false } as CacheHandlerContext;

    // Set up environment variables
    process.env.CDK_NEXTJS_CACHE_BUCKET_NAME = "test-bucket";
    process.env.CDK_NEXTJS_REVALIDATION_TABLE_NAME = "test-table";
    process.env.CDK_NEXTJS_BUILD_ID = "test-build-id";
    process.env.AWS_REGION = "us-east-1";

    // Suppress expected warnings globally (tests deliberately trigger warnings)
    jest.spyOn(console, "warn").mockImplementation();

    handler = new S3CacheHandler({
      context: mockContext,
    });

    // Reset mocks
    mockS3Send.mockReset();
    mockDynamoSend.mockReset();
    mockCloudFrontSend.mockReset();
    mockSsmSend.mockReset();
  });

  afterEach(() => {
    // Clean up environment variables
    delete process.env.CDK_NEXTJS_CACHE_BUCKET_NAME;
    delete process.env.CDK_NEXTJS_REVALIDATION_TABLE_NAME;
    delete process.env.CDK_NEXTJS_BUILD_ID;
    delete process.env.AWS_REGION;
    delete process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME;
    delete process.env.CDK_NEXTJS_BASE_PATH;

    // Restore console.warn
    jest.restoreAllMocks();
  });

  describe("get", () => {
    it("should return null when S3 bucket is not configured", async () => {
      delete process.env.CDK_NEXTJS_CACHE_BUCKET_NAME;

      const handlerWithoutBucket = new S3CacheHandler({
        context: mockContext,
      });

      const result = await handlerWithoutBucket.get("test-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });
      expect(result).toBeNull();
    });

    it("should retrieve and parse cache value from S3", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>test</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      const cacheValue = {
        lastModified: Date.now(),
        value: testData,
      };

      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: jest
            .fn()
            .mockResolvedValue(JSON.stringify(cacheValue)),
        },
        ContentType: "application/json",
      });

      const result = await handler.get("test-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });

      expect(result).toEqual(cacheValue);
      expect(mockS3Send).toHaveBeenCalledWith(expect.any(GetObjectCommand));
    });

    it("should return null when S3 object not found", async () => {
      mockS3Send.mockResolvedValueOnce({
        Body: null,
      });

      const result = await handler.get("missing-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });
      expect(result).toBeNull();
    });

    it("invalidates a seeded prerender only when its tag marker is newer", async () => {
      // A build-time prerender is written as a file by the adapter's
      // `onBuildComplete`, never through `set`, so it has no `tags` array and no
      // DynamoDB mapping rows - its tags live in the render's
      // `x-next-cache-tags` header. Two bugs met here: those header tags were
      // ignored, so `revalidateTag` could not reach any static page; and the
      // mapping rows `set` writes were stamped `revalidatedAt = now`, which is
      // *after* the entry's own `lastModified`, so a tagged entry looked
      // revalidated the moment it was stored and every request re-rendered.
      // Measured against next.js's `test/e2e/app-dir/resume-data-cache`.
      const lastModified = Date.now();
      const seeded = {
        lastModified,
        value: {
          kind: CachedRouteKind.APP_PAGE,
          html: "<html>seeded</html>",
          headers: { "x-next-cache-tags": "_N_T_/,_N_T_/page,test" },
        },
      };
      const s3Body = () => ({
        Body: {
          transformToString: jest
            .fn()
            .mockResolvedValue(JSON.stringify(seeded)),
        },
        ContentType: "application/json",
      });
      mockS3Send.mockImplementation((command: unknown) =>
        Promise.resolve(command instanceof GetObjectCommand ? s3Body() : {}),
      );
      const getCtx = {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      } as const;

      // No marker at all: the tag was never revalidated.
      dynamoResponses({});
      expect(await handler.get("index", getCtx)).toMatchObject({
        lastModified,
      });

      // A marker older than the entry means the entry already reflects it.
      dynamoResponses({
        get: { Item: { revalidatedAt: { N: String(lastModified - 1000) } } },
      });
      expect(await handler.get("index", getCtx)).toMatchObject({
        lastModified,
      });
      expect(mockS3Send).not.toHaveBeenCalledWith(
        expect.any(DeleteObjectCommand),
      );

      // A newer marker: the entry comes back marked expired, and stays in S3.
      dynamoResponses({
        get: { Item: { revalidatedAt: { N: String(lastModified + 1000) } } },
      });
      expect(await handler.get("index", getCtx)).toMatchObject({
        lastModified: -1,
        value: seeded.value,
      });
      expect(mockS3Send).not.toHaveBeenCalledWith(
        expect.any(DeleteObjectCommand),
      );
    });

    it("reports a revalidated response entry as expired rather than as a miss", async () => {
      // `lastModified: -1` is how a cache handler says "expired, re-render
      // before answering": `IncrementalCache.get` turns it into `isStale: -1`,
      // which `app-page-runtime` reads as an on-demand revalidation and answers
      // with a blocking render of this route, then stores it. Returning `null`
      // is not equivalent. A miss on a PPR route whose `prerender-manifest.json`
      // entry has a `fallback` (`compute: "resuming"`) is answered from the
      // route's fallback shell - `cache-control: private, no-store`, no
      // `x-nextjs-cache` - and without `partialPrefetching` nothing ever
      // upgrades that back into a concrete entry. So the first `revalidateTag`
      // to reach a page left it uncacheable and dynamically resumed per request
      // for the rest of the deployment's life, which is what the isr e2e's
      // missing `x-nextjs-cache` header was.
      const lastModified = Date.now();
      const stored = {
        lastModified,
        tags: ["collection"],
        value: {
          kind: CachedRouteKind.APP_PAGE,
          html: "<html>isr</html>",
          headers: { "x-next-cache-tags": "collection" },
        },
      };
      mockS3Send.mockImplementation((command: unknown) =>
        Promise.resolve(
          command instanceof GetObjectCommand
            ? {
                Body: {
                  transformToString: jest
                    .fn()
                    .mockResolvedValue(JSON.stringify(stored)),
                },
                ContentType: "application/json",
              }
            : {},
        ),
      );
      dynamoResponses({
        get: { Item: { revalidatedAt: { N: String(lastModified + 1000) } } },
      });

      const result = await handler.get("isr/1", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });

      expect(result).toEqual({ lastModified: -1, value: stored.value });
      // The body is still there for the render that fails, and `set` overwrites
      // it with a `lastModified` past the marker.
      expect(mockS3Send).not.toHaveBeenCalledWith(
        expect.any(DeleteObjectCommand),
      );
    });

    it("reports a revalidated fetch entry as a miss so the request refetches", async () => {
      // The opposite of a response entry: reusing a revalidated `fetch` body is
      // serving stale data, so this reads as a miss, like Next.js's own
      // `FileSystemCache` does for its `revalidatedTags`.
      const lastModified = Date.now();
      const stored = {
        lastModified,
        tags: ["collection"],
        value: {
          kind: CachedRouteKind.FETCH,
          data: { headers: {}, body: "stale", status: 200, url: "/api" },
          revalidate: 10,
        },
      };
      mockS3Send.mockImplementation((command: unknown) =>
        Promise.resolve(
          command instanceof GetObjectCommand
            ? {
                Body: {
                  transformToString: jest
                    .fn()
                    .mockResolvedValue(JSON.stringify(stored)),
                },
                ContentType: "application/json",
              }
            : {},
        ),
      );
      dynamoResponses({
        get: { Item: { revalidatedAt: { N: String(lastModified + 1000) } } },
      });

      const result = await handler.get("fetch-key", {
        kind: IncrementalCacheKind.FETCH,
        revalidate: 10,
        fetchUrl: "https://example.test/api",
        fetchIdx: 1,
        tags: ["collection"],
        softTags: [],
      });

      expect(result).toBeNull();
      expect(mockS3Send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
    });

    it("checks a fetch entry against the request's implicit tags, not its own", async () => {
      // An untagged `cache: "force-cache"` fetch is stored with no tags at all -
      // the implicit `_N_T_/<path>` chain reaches the handler only as
      // `ctx.softTags`, which is the source Next.js's own `FileSystemCache` reads
      // for a `FETCH` get. Checking the stored tags instead left this entry with
      // nothing to check and no `revalidatePath` could ever evict it.
      const lastModified = Date.now();
      const stored = {
        lastModified,
        tags: [],
        value: {
          kind: CachedRouteKind.FETCH,
          data: { headers: {}, body: "stale", status: 200, url: "/api" },
          revalidate: 10,
        },
      };
      mockS3Send.mockImplementation((command: unknown) =>
        Promise.resolve(
          command instanceof GetObjectCommand
            ? {
                Body: {
                  transformToString: jest
                    .fn()
                    .mockResolvedValue(JSON.stringify(stored)),
                },
                ContentType: "application/json",
              }
            : {},
        ),
      );
      dynamoResponses({
        get: { Item: { revalidatedAt: { N: String(lastModified + 1000) } } },
      });

      const result = await handler.get("fetch-key", {
        kind: IncrementalCacheKind.FETCH,
        revalidate: 10,
        fetchUrl: "https://next-data-api-endpoint.test/api/random",
        fetchIdx: 1,
        tags: [],
        softTags: ["_N_T_/layout", "_N_T_/dynamic"],
      });

      expect(result).toBeNull();
      expect(mockS3Send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
    });

    it("should handle S3 errors and return null", async () => {
      mockS3Send.mockRejectedValueOnce(new Error("S3 Error"));

      const result = await handler.get("error-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });
      expect(result).toBeNull();
    });
  });

  describe("set", () => {
    it("should store cache value in S3", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>set test</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      mockS3Send.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValue({});

      await handler.set("set-key", testData, createSetContext(["tag1"]));

      expect(mockS3Send).toHaveBeenCalledWith(expect.any(PutObjectCommand));
      expect(mockDynamoSend).toHaveBeenCalledWith(
        expect.any(UpdateItemCommand),
      );
    });

    it("should not store when S3 bucket is not configured", async () => {
      delete process.env.CDK_NEXTJS_CACHE_BUCKET_NAME;

      const handlerWithoutBucket = new S3CacheHandler({
        context: mockContext,
      });

      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>no bucket</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      await handlerWithoutBucket.set(
        "no-bucket-key",
        testData,
        createSetContext([]),
      );

      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it("maps the tags a page carries only in its x-next-cache-tags header", async () => {
      // `ResponseCache.set` builds a page's `ctx` without tags, so the render's
      // header is the only place they exist. No mapping row meant `revalidateTag`
      // found nothing to invalidate and CloudFront kept the stale HTML.
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>tagged</html>",
        rscData: undefined,
        headers: { "x-next-cache-tags": "header-tag,other-tag" },
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      mockS3Send.mockResolvedValue({});
      mockDynamoSend.mockResolvedValue({});

      await handler.set("/isr/1", testData, createSetContext([]));

      const mappingKeys = (UpdateItemCommand as unknown as jest.Mock).mock.calls
        .map(([input]) => input.Key.sk.S)
        .sort();
      expect(mappingKeys).toEqual([
        "header-tag#test-build-id/isr/1.json",
        "other-tag#test-build-id/isr/1.json",
      ]);
    });

    it("prefers the context's tags over the header when both are present", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>tagged</html>",
        rscData: undefined,
        headers: { "x-next-cache-tags": "header-tag" },
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      mockS3Send.mockResolvedValue({});
      mockDynamoSend.mockResolvedValue({});

      await handler.set("/isr/1", testData, createSetContext(["ctx-tag"]));

      const mappingKeys = (UpdateItemCommand as unknown as jest.Mock).mock.calls
        .map(([input]) => input.Key.sk.S)
        .sort();
      expect(mappingKeys).toEqual(["ctx-tag#test-build-id/isr/1.json"]);
    });

    it("should handle S3 errors gracefully", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>error test</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      mockS3Send.mockRejectedValueOnce(new Error("S3 Put Error"));

      // Should not throw
      await expect(
        handler.set("error-key", testData, createSetContext([])),
      ).resolves.not.toThrow();
    });
  });

  describe("revalidateTag", () => {
    it("should record the revalidation without deleting the tag's S3 entries", async () => {
      const mockQueryResponse = {
        Items: [
          { sk: { S: "test-tag#cache-key-1" } },
          { sk: { S: "test-tag#cache-key-2" } },
        ],
      };

      dynamoResponses({ query: mockQueryResponse });
      mockS3Send.mockResolvedValue({});

      await handler.revalidateTag("test-tag");

      expect(mockDynamoSend).toHaveBeenCalledWith(expect.any(QueryCommand));
      expect(mockDynamoSend).toHaveBeenCalledWith(
        expect.any(UpdateItemCommand),
      );
      // The marker row is the invalidation; `get` reads it and hands the entry
      // back expired so Next.js re-renders the route and replaces the object.
      // Deleting the objects here made the next request a hard miss, which on a
      // PPR route is answered from the uncacheable fallback shell for good.
      expect(mockS3Send).not.toHaveBeenCalledWith(
        expect.any(DeleteObjectCommand),
      );

      // The tag marker `checkIfRevalidated` reads: keyed by the bare tag, so
      // entries with no mapping row of their own still see the revalidation.
      const markerWrite = (UpdateItemCommand as unknown as jest.Mock).mock.calls
        .map(([input]) => input)
        .find((input) => input.Key.sk.S === "test-tag");
      expect(markerWrite).toMatchObject({
        UpdateExpression: "SET revalidatedAt = :timestamp",
      });
    });

    it("should not revalidate when DynamoDB table is not configured", async () => {
      delete process.env.CDK_NEXTJS_REVALIDATION_TABLE_NAME;

      const handlerWithoutTable = new S3CacheHandler({
        context: mockContext,
      });

      await handlerWithoutTable.revalidateTag("test-tag");

      expect(mockDynamoSend).not.toHaveBeenCalled();
    });

    it("should handle DynamoDB errors gracefully", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DynamoDB Error"));

      // Should not throw
      await expect(handler.revalidateTag("error-tag")).resolves.not.toThrow();
    });

    it("should create a CloudFront invalidation for affected paths when a distribution parameter is configured", async () => {
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });

      const mockQueryResponse = {
        Items: [
          { sk: { S: "test-tag#test-build-id/isr/1.json" } },
          { sk: { S: "test-tag#test-build-id/isr/2.json" } },
        ],
      };

      dynamoResponses({ query: mockQueryResponse });
      mockS3Send.mockResolvedValue({}); // For delete commands
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithDistribution.revalidateTag("test-tag");

      expect(mockSsmSend).toHaveBeenCalledWith(expect.any(Object));
      expect(mockCloudFrontSend).toHaveBeenCalledWith(
        expect.any(CreateInvalidationCommand),
      );
      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      expect(invalidationInput.DistributionId).toBe("test-distribution-id");
      expect(invalidationInput.InvalidationBatch.Paths.Items).toEqual(
        // `?*` too: an invalidation path matches only the query string it
        // spells out, and a page's RSC payload is cached under `?_rsc=<hash>`.
        expect.arrayContaining(["/isr/1", "/isr/1?*", "/isr/2", "/isr/2?*"]),
      );
    });

    it("splits a mapping row at the tag's length, so a tag containing # still resolves", async () => {
      // A tag is app-defined: `revalidateTag("user#42")` is legal. Splitting at
      // the first "#" left "42#test-build-id/account.json" as the S3 key, whose
      // invalidation path names nothing CloudFront cached, so the page stayed
      // stale while the row was stamped revalidated and never retried.
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });

      dynamoResponses({
        query: { Items: [{ sk: { S: "user#42#test-build-id/account.json" } }] },
      });
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithDistribution.revalidateTag("user#42");

      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      expect(invalidationInput.InvalidationBatch.Paths.Items.sort()).toEqual([
        "/account",
        "/account/",
        "/account/?*",
        "/account?*",
      ]);
    });

    it("invalidates the path a revalidatePath tag names even with no mapping rows", async () => {
      // A build-time prerender has no mapping rows, so the query comes back
      // empty and there is nothing to derive a CloudFront path from - except the
      // tag, which for `revalidatePath` is `_N_T_<path>`. Without this the CDN
      // answers with the pre-revalidation page until `s-maxage=31536000`
      // expires. Measured against next.js's `test/e2e/app-dir/trailingslash`.
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });

      dynamoResponses({ query: { Items: [] } });
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithDistribution.revalidateTag("_N_T_/en/legacy/");

      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      // Both slash variants: a `trailingSlash` app's cached URI is the redirect
      // target, not the route.
      expect(invalidationInput.InvalidationBatch.Paths.Items.sort()).toEqual([
        "/en/legacy",
        "/en/legacy/",
        "/en/legacy/?*",
        "/en/legacy?*",
      ]);
    });

    it("invalidates the URI under the app's basePath, not the bare route", async () => {
      // CloudFront cached `/base/isr/1`; the cache key and the `revalidatePath`
      // tag both name `/isr/1`, because Next.js strips `basePath` before routing
      // and never shows it to the cache handler. Invalidating the bare route
      // matches nothing at the edge, so the stale page survives until
      // `s-maxage` expires.
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      // The bare segment the constructs pass, to pin that the runtime adds the
      // leading slash rather than requiring one.
      process.env.CDK_NEXTJS_BASE_PATH = "base";
      const handlerWithBasePath = new S3CacheHandler({
        context: mockContext,
      });

      dynamoResponses({
        query: {
          Items: [
            { sk: { S: "test-tag#test-build-id/isr/1.json" } },
            { sk: { S: "test-tag#test-build-id/index.json" } },
          ],
        },
      });
      mockS3Send.mockResolvedValue({});
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithBasePath.revalidateTag("test-tag");

      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      expect(invalidationInput.InvalidationBatch.Paths.Items).toEqual(
        expect.arrayContaining([
          "/base/isr/1",
          "/base/isr/1?*",
          // The app's root under a `basePath` is `/base`, not `/base/`.
          "/base",
          "/base?*",
        ]),
      );
      expect(invalidationInput.InvalidationBatch.Paths.Items).not.toContain(
        "/isr/1",
      );
    });

    it("adds the basePath to a revalidatePath tag's path too", async () => {
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      process.env.CDK_NEXTJS_BASE_PATH = "base";
      const handlerWithBasePath = new S3CacheHandler({
        context: mockContext,
      });

      dynamoResponses({ query: { Items: [] } });
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithBasePath.revalidateTag("_N_T_/blog");

      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      expect(invalidationInput.InvalidationBatch.Paths.Items.sort()).toEqual([
        "/base/blog",
        "/base/blog/",
        "/base/blog/?*",
        "/base/blog?*",
      ]);
    });

    it("does not invalidate a CloudFront path for an app tag", async () => {
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });

      dynamoResponses({ query: { Items: [] } });

      await handlerWithDistribution.revalidateTag("posts");

      // Nothing to invalidate: an app tag names no path, and no entry is mapped
      // to it.
      expect(mockCloudFrontSend).not.toHaveBeenCalled();
    });

    it("should not call SSM or CloudFront when no distribution parameter is configured", async () => {
      const mockQueryResponse = {
        Items: [{ sk: { S: "test-tag#test-build-id/isr/1.json" } }],
      };

      dynamoResponses({ query: mockQueryResponse });
      mockS3Send.mockResolvedValue({});

      await handler.revalidateTag("test-tag");

      expect(mockSsmSend).not.toHaveBeenCalled();
      expect(mockCloudFrontSend).not.toHaveBeenCalled();
    });

    it("should handle SSM/CloudFront invalidation errors gracefully", async () => {
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });

      const mockQueryResponse = {
        Items: [{ sk: { S: "test-tag#test-build-id/isr/1.json" } }],
      };

      dynamoResponses({ query: mockQueryResponse });
      mockS3Send.mockResolvedValue({});
      mockSsmSend.mockRejectedValueOnce(new Error("SSM Error"));

      await expect(
        handlerWithDistribution.revalidateTag("test-tag"),
      ).resolves.not.toThrow();
    });

    it("invalidates the page itself for a revalidatePath(path, 'page') tag", async () => {
      // `revalidatePath(path, type)` appends the type to the implicit tag, so the
      // tag reads `_N_T_/pricing/page` - a path no URL has. Taking it literally
      // invalidated nothing that existed, which is the whole of the bug: the
      // second argument silently turned CDN invalidation off.
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });

      dynamoResponses({ query: { Items: [] } });
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithDistribution.revalidateTag("_N_T_/pricing/page");

      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      expect(invalidationInput.InvalidationBatch.Paths.Items).toEqual(
        expect.arrayContaining(["/pricing", "/pricing?*"]),
      );
    });

    it("skips mapping rows that name no cached URI", async () => {
      // A dynamic template and a fetch-cache entry are both rows a real tag
      // carries, and neither is a URL: `/blog/[slug]` matches nothing at the edge
      // (CloudFront has no such URI), and a fetch key is a hash of the request.
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });

      dynamoResponses({
        query: {
          Items: [
            { sk: { S: "test-tag#test-build-id/blog/[slug].json" } },
            {
              sk: {
                S: "test-tag#test-build-id/0123456789abcdef0123456789abcdef.json",
              },
            },
            { sk: { S: "test-tag#test-build-id/blog/hello.json" } },
          ],
        },
      });
      mockS3Send.mockResolvedValue({});
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithDistribution.revalidateTag("test-tag");

      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      const items: string[] = invalidationInput.InvalidationBatch.Paths.Items;
      expect(items).toEqual(expect.arrayContaining(["/blog/hello"]));
      expect(items.some((path) => path.includes("["))).toBe(false);
      expect(items.some((path) => path.includes("0123456789abcdef"))).toBe(
        false,
      );
    });

    it("walks every Query page of a tag's mapping rows", async () => {
      // One `Query` answers with at most 1 MB. A tag on a large app runs past
      // that, and taking only the first page deleted some of the tag's entries
      // and invalidated only some of its paths - a partial revalidation that
      // looks like a cache bug.
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });

      let queries = 0;
      mockDynamoSend.mockImplementation((command: unknown) => {
        if (command instanceof QueryCommand) {
          queries++;
          return Promise.resolve(
            queries === 1
              ? {
                  Items: [{ sk: { S: "test-tag#test-build-id/isr/1.json" } }],
                  LastEvaluatedKey: { pk: { S: "test-build-id" } },
                }
              : { Items: [{ sk: { S: "test-tag#test-build-id/isr/2.json" } }] },
          );
        }
        return Promise.resolve({});
      });
      mockS3Send.mockResolvedValue({});
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithDistribution.revalidateTag("test-tag");

      expect(queries).toBe(2);
      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      expect(invalidationInput.InvalidationBatch.Paths.Items).toEqual(
        expect.arrayContaining(["/isr/1", "/isr/2"]),
      );
    });

    it("collapses to one app-wide wildcard rather than sending many invalidations", async () => {
      // CloudFront caps a request at 15 wildcard paths and allows 15
      // invalidations in progress. A tag covering hundreds of pages therefore
      // cannot be spelled out: sending a request per 15 paths throttles, and a
      // throttled request is a page that stays stale.
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });

      dynamoResponses({
        query: {
          Items: Array.from({ length: 200 }, (_, i) => ({
            sk: { S: `test-tag#test-build-id/isr/${i}.json` },
          })),
        },
      });
      mockS3Send.mockResolvedValue({});
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithDistribution.revalidateTag("test-tag");

      expect(mockCloudFrontSend).toHaveBeenCalledTimes(1);
      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      expect(invalidationInput.InvalidationBatch.Paths.Items).toEqual(["/*"]);
    });
  });

  describe("resetRequestCache", () => {
    it("should complete without errors", async () => {
      await expect(handler.resetRequestCache()).resolves.not.toThrow();
    });
  });

  describe("custom configuration", () => {
    it("should accept custom configuration options", () => {
      const customHandler = new S3CacheHandler({
        context: mockContext,
        s3Config: {
          bucketName: "custom-bucket",
          region: "eu-west-1",
          buildId: "custom-build",
        },
        dynamoConfig: {
          tableName: "custom-table",
          region: "eu-west-1",
          buildId: "custom-build",
        },
      });

      expect(customHandler).toBeDefined();
    });
  });
});

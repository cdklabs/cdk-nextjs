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

      // A newer marker: miss, and drop the stale object so the re-render's entry
      // replaces it.
      dynamoResponses({
        get: { Item: { revalidatedAt: { N: String(lastModified + 1000) } } },
      });
      expect(await handler.get("index", getCtx)).toBeNull();
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
    it("should query DynamoDB and delete S3 entries", async () => {
      const mockQueryResponse = {
        Items: [
          { sk: { S: "test-tag#cache-key-1" } },
          { sk: { S: "test-tag#cache-key-2" } },
        ],
      };

      dynamoResponses({ query: mockQueryResponse });
      mockS3Send.mockResolvedValue({}); // For delete commands

      await handler.revalidateTag("test-tag");

      expect(mockDynamoSend).toHaveBeenCalledWith(expect.any(QueryCommand));
      expect(mockDynamoSend).toHaveBeenCalledWith(
        expect.any(UpdateItemCommand),
      );
      expect(mockS3Send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));

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
        expect.arrayContaining(["/isr/1", "/isr/2"]),
      );
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

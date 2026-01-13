/* eslint-disable import/no-extraneous-dependencies */
// Mock AWS SDK
jest.mock("@aws-sdk/client-s3");
jest.mock("@aws-sdk/client-dynamodb");

import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { CacheHandlerContext } from "next/dist/server/lib/incremental-cache";
import {
  IncrementalCacheValue,
  CachedRouteKind,
  IncrementalCacheKind,
} from "next/dist/server/response-cache";
import { S3DynamoCacheHandler } from "./s3-dynamo-cache-handler";

const mockS3Send = jest.fn();
const mockDynamoSend = jest.fn();

(S3Client as jest.Mock).mockImplementation(() => ({
  send: mockS3Send,
}));

(DynamoDBClient as jest.Mock).mockImplementation(() => ({
  send: mockDynamoSend,
}));

describe("S3DynamoCacheHandler", () => {
  let handler: S3DynamoCacheHandler;
  let mockContext: CacheHandlerContext;

  beforeEach(() => {
    mockContext = { dev: false } as CacheHandlerContext;

    // Set up environment variables
    process.env.CDK_NEXTJS_CACHE_BUCKET_NAME = "test-bucket";
    process.env.CDK_NEXTJS_REVALIDATION_TABLE_NAME = "test-table";
    process.env.CDK_NEXTJS_BUILD_ID = "test-build-id";
    process.env.AWS_REGION = "us-east-1";

    // Suppress expected warnings globally (tests deliberately trigger warnings)
    jest.spyOn(console, "warn").mockImplementation();

    handler = new S3DynamoCacheHandler({
      context: mockContext,
    });

    // Reset mocks
    mockS3Send.mockReset();
    mockDynamoSend.mockReset();
  });

  afterEach(() => {
    // Clean up environment variables
    delete process.env.CDK_NEXTJS_CACHE_BUCKET_NAME;
    delete process.env.CDK_NEXTJS_REVALIDATION_TABLE_NAME;
    delete process.env.CDK_NEXTJS_BUILD_ID;
    delete process.env.AWS_REGION;

    // Restore console.warn
    jest.restoreAllMocks();
  });

  describe("get", () => {
    it("should return null when S3 bucket is not configured", async () => {
      delete process.env.CDK_NEXTJS_CACHE_BUCKET_NAME;

      const handlerWithoutBucket = new S3DynamoCacheHandler({
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

    it("should handle S3 errors and return null", async () => {
      mockS3Send.mockRejectedValueOnce(new Error("S3 Error"));

      const result = await handler.get("error-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });
      expect(result).toBeNull();
    });

    it("should respect circuit breaker for S3", async () => {
      // Trigger multiple failures to open circuit breaker
      for (let i = 0; i < 5; i++) {
        mockS3Send.mockRejectedValueOnce(new Error("S3 Error"));
        await handler.get(`error-key-${i}`, {
          kind: IncrementalCacheKind.APP_PAGE,
          isFallback: false,
        });
      }

      // Circuit breaker should now be open
      const result = await handler.get("circuit-open-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });
      expect(result).toBeNull();

      // S3 should not be called due to circuit breaker
      expect(mockS3Send).toHaveBeenCalledTimes(5); // Only the failed calls
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

      await handler.set("set-key", testData, { tags: ["tag1"] });

      expect(mockS3Send).toHaveBeenCalledWith(expect.any(PutObjectCommand));
      expect(mockDynamoSend).toHaveBeenCalledWith(
        expect.any(UpdateItemCommand),
      );
    });

    it("should not store when S3 bucket is not configured", async () => {
      delete process.env.CDK_NEXTJS_CACHE_BUCKET_NAME;

      const handlerWithoutBucket = new S3DynamoCacheHandler({
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

      await handlerWithoutBucket.set("no-bucket-key", testData, { tags: [] });

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
        handler.set("error-key", testData, { tags: [] }),
      ).resolves.not.toThrow();
    });

    it("should skip S3 when circuit breaker is open", async () => {
      // Open circuit breaker
      for (let i = 0; i < 5; i++) {
        mockS3Send.mockRejectedValueOnce(new Error("S3 Error"));
        await handler.get(`error-key-${i}`, {
          kind: IncrementalCacheKind.APP_PAGE,
          isFallback: false,
        });
      }

      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>circuit open</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      await handler.set("circuit-open-key", testData, { tags: [] });

      // Should not attempt S3 put due to circuit breaker
      expect(mockS3Send).toHaveBeenCalledTimes(5); // Only the failed get calls
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

      mockDynamoSend.mockResolvedValueOnce(mockQueryResponse);
      mockDynamoSend.mockResolvedValue({}); // For update commands
      mockS3Send.mockResolvedValue({}); // For delete commands

      await handler.revalidateTag("test-tag");

      expect(mockDynamoSend).toHaveBeenCalledWith(expect.any(QueryCommand));
      expect(mockDynamoSend).toHaveBeenCalledWith(
        expect.any(UpdateItemCommand),
      );
      expect(mockS3Send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
    });

    it("should not revalidate when DynamoDB table is not configured", async () => {
      delete process.env.CDK_NEXTJS_REVALIDATION_TABLE_NAME;

      const handlerWithoutTable = new S3DynamoCacheHandler({
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

    it("should skip DynamoDB when circuit breaker is open", async () => {
      // Open DynamoDB circuit breaker
      for (let i = 0; i < 5; i++) {
        mockDynamoSend.mockRejectedValueOnce(new Error("DynamoDB Error"));
        await handler.revalidateTag(`error-tag-${i}`);
      }

      await handler.revalidateTag("circuit-open-tag");

      // Should not attempt additional DynamoDB calls due to circuit breaker
      expect(mockDynamoSend).toHaveBeenCalledTimes(5); // Only the failed calls
    });
  });

  describe("resetRequestCache", () => {
    it("should complete without errors", async () => {
      await expect(handler.resetRequestCache()).resolves.not.toThrow();
    });
  });

  describe("health status", () => {
    it("should return correct health status", () => {
      const status = handler.getHealthStatus();

      expect(status).toEqual({
        s3Available: true,
        dynamoAvailable: true,
        circuitBreakerStatus: {
          s3Failures: 0,
          dynamoFailures: 0,
          lastFailureTime: 0,
        },
        config: {
          s3Config: {
            bucketName: "test-bucket",
            region: "us-east-1",
            buildId: "test-build-id",
          },
          dynamoConfig: {
            tableName: "test-table",
            region: "us-east-1",
            buildId: "test-build-id",
          },
          circuitBreakerThreshold: 5,
          circuitBreakerTimeoutMs: 300000,
        },
      });
    });
  });

  describe("circuit breaker reset", () => {
    it("should reset circuit breakers", () => {
      handler.resetCircuitBreakers();

      const status = handler.getHealthStatus();
      expect(status.circuitBreakerStatus.s3Failures).toBe(0);
      expect(status.circuitBreakerStatus.dynamoFailures).toBe(0);
      expect(status.circuitBreakerStatus.lastFailureTime).toBe(0);
    });
  });

  describe("custom configuration", () => {
    it("should accept custom configuration options", () => {
      const customHandler = new S3DynamoCacheHandler({
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
        circuitBreakerThreshold: 3,
        circuitBreakerTimeoutMs: 60000,
      });

      const status = customHandler.getHealthStatus();
      expect(status.config.s3Config.bucketName).toBe("custom-bucket");
      expect(status.config.circuitBreakerThreshold).toBe(3);
      expect(status.config.circuitBreakerTimeoutMs).toBe(60000);
    });
  });
});

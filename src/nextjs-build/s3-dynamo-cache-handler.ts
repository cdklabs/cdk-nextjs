/*
  S3 and DynamoDB cache handler with circuit breaker pattern
*/
/* eslint-disable import/no-extraneous-dependencies */
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
import { CacheHandlerValue } from "next/dist/server/lib/incremental-cache";
import {
  IncrementalCacheValue,
  GetIncrementalFetchCacheContext,
  GetIncrementalResponseCacheContext,
} from "next/dist/server/response-cache";
import { CacheHandler, CacheHandlerOptions } from "./cache-handler-interface";
import getDebug from "debug";
import { join } from "path";

/**
 * Check if code is running as a result of `next build`
 */
function isNextBuild() {
  return process.env["NEXT_PHASE"] === "phase-production-build";
}

interface S3CacheConfig {
  bucketName: string;
  region: string;
  buildId: string;
}

interface DynamoDBRevalidationConfig {
  tableName: string;
  region: string;
  buildId: string;
}

interface CircuitBreakerState {
  s3Failures: number;
  dynamoFailures: number;
  lastFailureTime: number;
}

export interface S3DynamoCacheHandlerOptions extends CacheHandlerOptions {
  s3Config?: Partial<S3CacheConfig>;
  dynamoConfig?: Partial<DynamoDBRevalidationConfig>;
  circuitBreakerThreshold?: number; // Default 5
  circuitBreakerTimeoutMs?: number; // Default 300000 (5 minutes)
}

export class S3DynamoCacheHandler implements CacheHandler {
  private s3Client: S3Client;
  private dynamoClient: DynamoDBClient;
  private s3Config: S3CacheConfig;
  private dynamoConfig: DynamoDBRevalidationConfig;
  private circuitBreaker: CircuitBreakerState = {
    s3Failures: 0,
    dynamoFailures: 0,
    lastFailureTime: 0,
  };
  private circuitBreakerThreshold: number;
  private circuitBreakerTimeoutMs: number;
  private debug = getDebug("cdk-nextjs-cache-handler:s3-dynamo");

  constructor(options: S3DynamoCacheHandlerOptions) {
    const buildId = process.env.CDK_NEXTJS_BUILD_ID || "";

    // Initialize S3 configuration from environment variables and options
    this.s3Config = {
      bucketName:
        options.s3Config?.bucketName ||
        process.env.CDK_NEXTJS_CACHE_BUCKET_NAME ||
        "",
      region: options.s3Config?.region || process.env.AWS_REGION || "us-east-1",
      buildId: options.s3Config?.buildId || buildId,
    };

    // Initialize DynamoDB configuration from environment variables and options
    this.dynamoConfig = {
      tableName:
        options.dynamoConfig?.tableName ||
        process.env.CDK_NEXTJS_REVALIDATION_TABLE_NAME ||
        "",
      region:
        options.dynamoConfig?.region || process.env.AWS_REGION || "us-east-1",
      buildId: options.dynamoConfig?.buildId || buildId,
    };

    // Circuit breaker configuration
    this.circuitBreakerThreshold = options.circuitBreakerThreshold || 5;
    this.circuitBreakerTimeoutMs = options.circuitBreakerTimeoutMs || 300000; // 5 minutes

    // Initialize AWS clients
    this.s3Client = new S3Client({ region: this.s3Config.region });
    this.dynamoClient = new DynamoDBClient({
      region: this.dynamoConfig.region,
    });

    // Only show warnings during runtime, not during Next.js build
    if (!isNextBuild()) {
      if (!this.s3Config.bucketName) {
        console.warn(
          "CDK_NEXTJS_CACHE_BUCKET_NAME environment variable not set, S3 cache disabled",
        );
      }

      if (!this.dynamoConfig.tableName) {
        console.warn(
          "CDK_NEXTJS_REVALIDATION_TABLE_NAME environment variable not set, revalidation tracking disabled",
        );
      }

      if (!buildId) {
        console.warn(
          "CDK_NEXTJS_BUILD_ID environment variable not set, cache isolation may not work correctly",
        );
      }
    }

    // Log the options for debugging (optional usage to avoid unused parameter warning)
    if (options.context.dev) {
      this.debug("S3DynamoCacheHandler initialized in development mode");
    }
  }

  async get(
    cacheKey: string,
    ctx: GetIncrementalFetchCacheContext | GetIncrementalResponseCacheContext,
  ): Promise<CacheHandlerValue | null> {
    try {
      // Skip S3 cache for APP_PAGE routes as they contain complex streaming objects
      // that can't be properly serialized/deserialized
      if (ctx.kind === "APP_PAGE") {
        this.debug(`Skipping S3 cache for APP_PAGE route: ${cacheKey}`);
        return null;
      }

      // Log context for debugging (optional usage to avoid unused parameter warning)
      if (ctx.kind) {
        this.debug(
          `S3 cache get operation for ${cacheKey} with kind: ${ctx.kind}`,
        );
      }

      // If S3 is unavailable due to circuit breaker, return null
      if (this.isS3CircuitOpen()) {
        this.debug("S3 circuit breaker is open, returning cache miss");
        return null;
      }

      if (!this.s3Config.bucketName) {
        return null;
      }

      const s3Key = this.buildS3Key(cacheKey, ctx.kind);

      const command = new GetObjectCommand({
        Bucket: this.s3Config.bucketName,
        Key: s3Key,
      });

      const response = await this.s3Client.send(command);

      if (!response.Body) {
        return null;
      }

      // Handle different content types appropriately for documented formats
      let cacheValue: CacheHandlerValue;
      const contentType = response.ContentType || "application/json";

      // Handle text-based data (JSON, HTML, plain text) - all documented formats are text-based
      const bodyString = await response.Body.transformToString("utf-8");

      if (contentType.includes("application/json")) {
        // Parse the stored CacheHandlerValue directly
        const parsedValue = JSON.parse(bodyString, (_key, value) => {
          // Restore Map objects that were serialized with __type marker
          if (value && typeof value === "object" && value.__type === "Map") {
            return new Map(Object.entries(value.data));
          }
          // Restore Buffer objects that were serialized with __type marker
          if (value && typeof value === "object" && value.__type === "Buffer") {
            return Buffer.from(value.data, "base64");
          }
          return value;
        });

        cacheValue = parsedValue;
      } else {
        // This shouldn't happen since we always store as JSON now, but handle legacy data
        // Since we don't know the exact structure, return null for legacy non-JSON data
        return null;
      }

      // Reset S3 circuit breaker on success
      this.circuitBreaker.s3Failures = 0;

      return cacheValue;
    } catch (error) {
      const errorType = this.categorizeError(error);

      // Cache misses are normal behavior, not errors
      if (errorType === "cache-miss") {
        this.debug(`Cache miss for key: ${cacheKey}`);
        return null;
      }

      // Only log actual errors and handle circuit breaker for real failures
      console.error(`Error retrieving cache from S3 (${errorType}):`, error);
      this.handleS3Failure();
      return null;
    }
  }

  async set(
    cacheKey: string,
    data: IncrementalCacheValue | null,
    ctx: { tags: string[] },
  ): Promise<void> {
    try {
      if (!data) {
        return;
      }

      // Skip caching for APP_PAGE routes as they contain complex streaming objects
      // that can't be properly serialized/deserialized
      if (data.kind === "APP_PAGE") {
        this.debug(`Skipping S3 cache for APP_PAGE route: ${cacheKey}`);
        return;
      }

      // Note: ctx.tags are available but revalidation is handled separately in revalidateTag method
      // Log tags for debugging if present
      if (ctx.tags && ctx.tags.length > 0) {
        this.debug(`S3 cache entry for ${cacheKey} has tags:`, ctx.tags);
      }

      // If S3 is unavailable due to circuit breaker, skip storage
      if (this.isS3CircuitOpen()) {
        this.debug("S3 circuit breaker is open, skipping S3 storage");
        return;
      }

      if (!this.s3Config.bucketName) {
        return;
      }

      const s3Key = this.buildS3Key(cacheKey, data.kind);

      // Create CacheHandlerValue structure for S3 storage
      const cacheHandlerValue: CacheHandlerValue = {
        lastModified: Date.now(),
        value: data,
      };

      // Custom serialization to handle Map and Buffer objects
      const body = JSON.stringify(cacheHandlerValue, (_key, value) => {
        // Convert Map objects to plain objects for JSON serialization
        if (value instanceof Map) {
          return {
            __type: "Map",
            data: Object.fromEntries(value),
          };
        }
        // Convert Buffer objects to a restorable format
        if (Buffer.isBuffer(value)) {
          return {
            __type: "Buffer",
            data: value.toString("base64"),
          };
        }
        return value;
      });

      const command = new PutObjectCommand({
        Bucket: this.s3Config.bucketName,
        Key: s3Key,
        Body: body,
        ContentType: "application/json; charset=utf-8", // Always JSON since we store CacheHandlerValue
        ContentEncoding: "utf-8",
        Metadata: {
          cacheKey,
          buildId: this.s3Config.buildId,
          timestamp: Date.now().toString(),
        },
      });

      await this.s3Client.send(command);

      // Store tag-to-cache-key mappings in DynamoDB for revalidation
      if (ctx.tags && ctx.tags.length > 0 && this.dynamoConfig.tableName) {
        await this.storeDynamoDBTagMappings(s3Key, ctx.tags);
      }

      // Reset S3 circuit breaker on success
      this.circuitBreaker.s3Failures = 0;
    } catch (error) {
      const errorType = this.categorizeError(error);
      console.error(`Error storing cache to S3 (${errorType}):`, error);
      this.handleS3Failure();
    }
  }

  async revalidateTag(tag: string | string[]): Promise<void> {
    const tags = Array.isArray(tag) ? tag : [tag];

    try {
      if (this.isDynamoCircuitOpen()) {
        this.debug(
          "DynamoDB circuit breaker is open, skipping revalidation tracking",
        );
        return;
      }

      if (!this.dynamoConfig.tableName) {
        return;
      }

      // Process all tags in parallel for better performance
      await Promise.all(tags.map((t) => this.revalidateSingleTag(t)));

      // Reset DynamoDB circuit breaker on success
      this.circuitBreaker.dynamoFailures = 0;
    } catch (error) {
      console.error("Error updating revalidation metadata:", error);
      this.handleDynamoFailure();
    }
  }

  private async revalidateSingleTag(tag: string): Promise<void> {
    // Query all paths associated with this tag (with BUILD_ID prefix)
    const tagWithBuildId = `${this.dynamoConfig.buildId}#${tag}`;
    const queryCommand = new QueryCommand({
      TableName: this.dynamoConfig.tableName,
      KeyConditionExpression: "tag = :tag",
      ExpressionAttributeValues: {
        ":tag": { S: tagWithBuildId },
      },
    });

    const queryResponse = await this.dynamoClient.send(queryCommand);

    if (queryResponse.Items) {
      // Update revalidation timestamp for all cache keys with this tag
      const updatePromises = queryResponse.Items.map(async (item) => {
        const cacheKey = item.cacheKey?.S;
        if (cacheKey) {
          const updateCommand = new UpdateItemCommand({
            TableName: this.dynamoConfig.tableName,
            Key: {
              tag: { S: tagWithBuildId },
              cacheKey: { S: cacheKey },
            },
            UpdateExpression: "SET revalidatedAt = :timestamp",
            ExpressionAttributeValues: {
              ":timestamp": { N: Date.now().toString() },
            },
          });

          return this.dynamoClient.send(updateCommand);
        }
        return Promise.resolve();
      });

      await Promise.all(updatePromises.filter(Boolean));

      // Delete the corresponding S3 cache entries to invalidate them
      if (this.s3Config.bucketName) {
        const deletePromises = queryResponse.Items.map(async (item) => {
          const s3Key = item.cacheKey?.S; // This is now the full S3 key
          if (s3Key) {
            const deleteCommand = new DeleteObjectCommand({
              Bucket: this.s3Config.bucketName,
              Key: s3Key,
            });

            try {
              await this.s3Client.send(deleteCommand);
            } catch (error) {
              // Log but don't fail - the entry might not exist in S3
              console.warn(`Failed to delete S3 cache entry ${s3Key}:`, error);
            }
          }
        });

        await Promise.all(deletePromises.filter(Boolean));
      }
    }
  }

  async resetRequestCache(): Promise<void> {
    // This handler doesn't maintain request-level cache state
    // The actual cache clearing is handled by the memory cache handler
  }

  private buildS3Key(cacheKey: string, kind: string): string {
    // Use BUILD_ID prefixing with kind: {buildId}/{kind}/{cacheKey}.json
    // Next.js provides the cacheKey, we add BUILD_ID isolation, kind categorization

    // Handle edge cases:
    // - Root path "/" should become "index" or similar
    // - Remove leading slashes to prevent empty folders
    let cleanCacheKey = cacheKey;

    if (cacheKey === "/" || cacheKey === "") {
      cleanCacheKey = "index";
    } else if (cacheKey.startsWith("/")) {
      cleanCacheKey = cacheKey.slice(1);
    }

    // Include kind in the S3 key structure for better organization
    const kindPrefix = kind.toLowerCase();

    return join(this.s3Config.buildId, kindPrefix, `${cleanCacheKey}.json`);
  }

  private async storeDynamoDBTagMappings(
    s3Key: string,
    tags: string[],
  ): Promise<void> {
    try {
      if (this.isDynamoCircuitOpen()) {
        this.debug(
          "DynamoDB circuit breaker is open, skipping tag mapping storage",
        );
        return;
      }

      const updatePromises = tags.map(async (tag) => {
        const tagWithBuildId = `${this.dynamoConfig.buildId}#${tag}`;
        const updateCommand = new UpdateItemCommand({
          TableName: this.dynamoConfig.tableName,
          Key: {
            tag: { S: tagWithBuildId },
            cacheKey: { S: s3Key }, // Store the full S3 key for easy deletion
          },
          UpdateExpression:
            "SET createdAt = if_not_exists(createdAt, :now), revalidatedAt = :now",
          ExpressionAttributeValues: {
            ":now": { N: Date.now().toString() },
          },
        });

        await this.dynamoClient.send(updateCommand);
      });

      await Promise.all(updatePromises);

      // Reset DynamoDB circuit breaker on success
      this.circuitBreaker.dynamoFailures = 0;
    } catch (error) {
      console.error("Error storing DynamoDB tag mappings:", error);
      this.handleDynamoFailure();
      // Don't throw - cache storage should continue even if tag mapping fails
    }
  }

  private isS3CircuitOpen(): boolean {
    const now = Date.now();
    const timeSinceLastFailure = now - this.circuitBreaker.lastFailureTime;

    // Circuit breaker: if more than threshold failures in the timeout period, open circuit
    if (
      this.circuitBreaker.s3Failures >= this.circuitBreakerThreshold &&
      timeSinceLastFailure < this.circuitBreakerTimeoutMs
    ) {
      return true;
    }

    // Reset failures if enough time has passed
    if (timeSinceLastFailure > this.circuitBreakerTimeoutMs) {
      this.circuitBreaker.s3Failures = 0;
    }

    return false;
  }

  private isDynamoCircuitOpen(): boolean {
    const now = Date.now();
    const timeSinceLastFailure = now - this.circuitBreaker.lastFailureTime;

    // Circuit breaker: if more than threshold failures in the timeout period, open circuit
    if (
      this.circuitBreaker.dynamoFailures >= this.circuitBreakerThreshold &&
      timeSinceLastFailure < this.circuitBreakerTimeoutMs
    ) {
      return true;
    }

    // Reset failures if enough time has passed
    if (timeSinceLastFailure > this.circuitBreakerTimeoutMs) {
      this.circuitBreaker.dynamoFailures = 0;
    }

    return false;
  }

  private handleS3Failure(): void {
    this.circuitBreaker.s3Failures++;
    this.circuitBreaker.lastFailureTime = Date.now();

    // Log detailed error information for monitoring
    console.error(
      `S3 Cache Handler: Failure count ${this.circuitBreaker.s3Failures}/${this.circuitBreakerThreshold}. Circuit breaker will open at ${this.circuitBreakerThreshold} failures.`,
    );

    if (this.circuitBreaker.s3Failures >= this.circuitBreakerThreshold) {
      console.error(
        "S3 Cache Handler: Circuit breaker opened due to repeated failures.",
      );
    }
  }

  private handleDynamoFailure(): void {
    this.circuitBreaker.dynamoFailures++;
    this.circuitBreaker.lastFailureTime = Date.now();

    // Log detailed error information for monitoring
    console.error(
      `DynamoDB Revalidation: Failure count ${this.circuitBreaker.dynamoFailures}/${this.circuitBreakerThreshold}. Circuit breaker will open at ${this.circuitBreakerThreshold} failures.`,
    );

    if (this.circuitBreaker.dynamoFailures >= this.circuitBreakerThreshold) {
      console.error(
        "DynamoDB Revalidation: Circuit breaker opened due to repeated failures. Revalidation tracking disabled.",
      );
    }
  }

  // Enhanced error categorization
  private categorizeError(
    error: any,
  ): "network" | "permission" | "throttling" | "cache-miss" | "unknown" {
    // Cache miss is not an error - it's expected behavior
    // Check multiple ways NoSuchKey can be represented
    if (
      error.name === "NoSuchKey" ||
      error.Code === "NoSuchKey" ||
      error.$metadata?.httpStatusCode === 404 ||
      (error.message && error.message.includes("NoSuchKey"))
    ) {
      return "cache-miss";
    }

    if (
      error.name === "NetworkingError" ||
      error.code === "ENOTFOUND" ||
      error.code === "ECONNREFUSED"
    ) {
      return "network";
    }

    if (
      error.name === "AccessDenied" ||
      error.code === "AccessDenied" ||
      error.statusCode === 403
    ) {
      return "permission";
    }

    if (
      error.name === "ThrottlingException" ||
      error.code === "ThrottlingException" ||
      error.statusCode === 429
    ) {
      return "throttling";
    }

    return "unknown";
  }

  // Public methods for testing and monitoring
  public getHealthStatus(): {
    s3Available: boolean;
    dynamoAvailable: boolean;
    circuitBreakerStatus: CircuitBreakerState;
    config: {
      s3Config: S3CacheConfig;
      dynamoConfig: DynamoDBRevalidationConfig;
      circuitBreakerThreshold: number;
      circuitBreakerTimeoutMs: number;
    };
  } {
    return {
      s3Available: !this.isS3CircuitOpen(),
      dynamoAvailable: !this.isDynamoCircuitOpen(),
      circuitBreakerStatus: {
        s3Failures: this.circuitBreaker.s3Failures,
        dynamoFailures: this.circuitBreaker.dynamoFailures,
        lastFailureTime: this.circuitBreaker.lastFailureTime,
      },
      config: {
        s3Config: this.s3Config,
        dynamoConfig: this.dynamoConfig,
        circuitBreakerThreshold: this.circuitBreakerThreshold,
        circuitBreakerTimeoutMs: this.circuitBreakerTimeoutMs,
      },
    };
  }

  // Method to manually reset circuit breakers (for operational purposes)
  public resetCircuitBreakers(): void {
    this.circuitBreaker.s3Failures = 0;
    this.circuitBreaker.dynamoFailures = 0;
    this.circuitBreaker.lastFailureTime = 0;
    console.info("S3DynamoCacheHandler: Circuit breakers manually reset");
  }
}

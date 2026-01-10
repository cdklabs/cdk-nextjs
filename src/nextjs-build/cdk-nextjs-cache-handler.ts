/*
  This file is compiled as defined in .projenrc.ts to be used as Next.js
  Custom Cache Handler. See: https://nextjs.org/docs/app/api-reference/next-config-js/incrementalCacheHandlerPath
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
import {
  CacheHandlerValue,
  CacheHandlerContext,
} from "next/dist/server/lib/incremental-cache";
import {
  IncrementalCacheValue,
  GetIncrementalFetchCacheContext,
  GetIncrementalResponseCacheContext,
} from "next/dist/server/response-cache";

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

export default class S3CacheHandler {
  private s3Client: S3Client;
  private dynamoClient: DynamoDBClient;
  private s3Config: S3CacheConfig;
  private dynamoConfig: DynamoDBRevalidationConfig;
  private inMemoryCache: Map<
    string,
    { value: CacheHandlerValue; timestamp: number }
  > = new Map();
  private inMemoryTagCache: Map<string, Set<string>> = new Map(); // tag -> Set of cache keys
  private circuitBreaker: {
    s3Failures: number;
    dynamoFailures: number;
    lastFailureTime: number;
  } = {
    s3Failures: 0,
    dynamoFailures: 0,
    lastFailureTime: 0,
  };

  constructor(options: CacheHandlerContext) {
    const buildId = process.env.CDK_NEXTJS_BUILD_ID || "";

    // Initialize S3 configuration from environment variables
    this.s3Config = {
      bucketName: process.env.CDK_NEXTJS_CACHE_BUCKET_NAME || "",
      region: process.env.AWS_REGION || "us-east-1",
      buildId,
    };

    // Initialize DynamoDB configuration from environment variables
    this.dynamoConfig = {
      tableName: process.env.CDK_NEXTJS_REVALIDATION_TABLE_NAME || "",
      region: process.env.AWS_REGION || "us-east-1",
      buildId,
    };

    // Initialize AWS clients
    this.s3Client = new S3Client({ region: this.s3Config.region });
    this.dynamoClient = new DynamoDBClient({
      region: this.dynamoConfig.region,
    });

    if (!this.s3Config.bucketName) {
      console.warn(
        "CDK_NEXTJS_CACHE_BUCKET_NAME environment variable not set, falling back to in-memory cache",
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

    // Log the options for debugging (optional usage to avoid unused parameter warning)
    if (options.dev) {
      console.log("S3CacheHandler initialized in development mode");
    }
  }

  async get(
    cacheKey: string,
    ctx: GetIncrementalFetchCacheContext | GetIncrementalResponseCacheContext,
  ): Promise<CacheHandlerValue | null> {
    try {
      // Log context for debugging (optional usage to avoid unused parameter warning)
      if (ctx.kind) {
        console.debug(
          `Cache get operation for ${cacheKey} with kind: ${ctx.kind}`,
        );
      }

      // Check in-memory cache first for recent entries
      const memoryEntry = this.inMemoryCache.get(cacheKey);
      if (memoryEntry && Date.now() - memoryEntry.timestamp < 60000) {
        // 1 minute TTL
        return memoryEntry.value;
      }

      // If S3 is unavailable due to circuit breaker, return null
      if (this.isS3CircuitOpen()) {
        console.warn("S3 circuit breaker is open, returning cache miss");
        return null;
      }

      if (!this.s3Config.bucketName) {
        return null;
      }

      const s3Key = this.buildS3Key(cacheKey);

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
        cacheValue = JSON.parse(bodyString);
      } else {
        // This shouldn't happen since we always store as JSON now, but handle legacy data
        // Since we don't know the exact structure, return null for legacy non-JSON data
        return null;
      }

      // Store in memory cache for quick access
      this.inMemoryCache.set(cacheKey, {
        value: cacheValue,
        timestamp: Date.now(),
      });

      // Reset S3 circuit breaker on success
      this.circuitBreaker.s3Failures = 0;

      return cacheValue;
    } catch (error) {
      const errorType = this.categorizeError(error);
      console.error(`Error retrieving cache from S3 (${errorType}):`, error);
      this.handleS3Failure();

      // Return from memory cache if available
      const memoryEntry = this.inMemoryCache.get(cacheKey);
      return memoryEntry ? memoryEntry.value : null;
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

      // Note: ctx.tags are available but revalidation is handled separately in revalidateTag method
      // Log tags for debugging if present
      if (ctx.tags && ctx.tags.length > 0) {
        console.debug(`Cache entry for ${cacheKey} has tags:`, ctx.tags);
      }

      // Store in memory cache immediately with proper CacheHandlerValue structure
      const cacheHandlerValue: CacheHandlerValue = {
        lastModified: Date.now(),
        value: data,
      };
      this.inMemoryCache.set(cacheKey, {
        value: cacheHandlerValue,
        timestamp: Date.now(),
      });

      // Track tags for this cache entry
      if (ctx.tags && ctx.tags.length > 0) {
        for (const tag of ctx.tags) {
          let tagSet = this.inMemoryTagCache.get(tag);
          if (!tagSet) {
            tagSet = new Set();
            this.inMemoryTagCache.set(tag, tagSet);
          }
          tagSet.add(cacheKey);
        }
      }

      // If S3 is unavailable due to circuit breaker, only store in memory
      if (this.isS3CircuitOpen()) {
        console.warn("S3 circuit breaker is open, storing only in memory");
        return;
      }

      if (!this.s3Config.bucketName) {
        return;
      }

      const s3Key = this.buildS3Key(cacheKey);

      // Use the same CacheHandlerValue structure for S3 storage
      const body = JSON.stringify(cacheHandlerValue);

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
        await this.storeDynamoDBTagMappings(cacheKey, ctx.tags);
      }

      // Reset S3 circuit breaker on success
      this.circuitBreaker.s3Failures = 0;
    } catch (error) {
      const errorType = this.categorizeError(error);
      console.error(`Error storing cache to S3 (${errorType}):`, error);
      this.handleS3Failure();
      // Data is still available in memory cache
    }
  }

  async revalidateTag(tag: string): Promise<void> {
    try {
      // Always clear memory cache first, regardless of DynamoDB configuration
      this.clearMemoryCacheByTag(tag);

      if (this.isDynamoCircuitOpen()) {
        console.warn(
          "DynamoDB circuit breaker is open, skipping revalidation tracking",
        );
        return;
      }

      if (!this.dynamoConfig.tableName) {
        return;
      }

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
            const cacheKey = item.cacheKey?.S;
            if (cacheKey) {
              const s3Key = this.buildS3Key(cacheKey);
              const deleteCommand = new DeleteObjectCommand({
                Bucket: this.s3Config.bucketName,
                Key: s3Key,
              });

              try {
                await this.s3Client.send(deleteCommand);
              } catch (error) {
                // Log but don't fail - the entry might not exist in S3
                console.warn(
                  `Failed to delete S3 cache entry ${s3Key}:`,
                  error,
                );
              }
            }
          });

          await Promise.all(deletePromises.filter(Boolean));
        }
      }

      // Reset DynamoDB circuit breaker on success
      this.circuitBreaker.dynamoFailures = 0;
    } catch (error) {
      console.error("Error updating revalidation metadata:", error);
      this.handleDynamoFailure();
    }
  }

  async resetRequestCache(): Promise<void> {
    // Clear both in-memory caches
    this.inMemoryCache.clear();
    this.inMemoryTagCache.clear();
  }

  private buildS3Key(cacheKey: string): string {
    // Use BUILD_ID prefixing: /{buildId}/{cacheKey}
    // Next.js provides the cacheKey, we just add BUILD_ID isolation
    return `/${this.s3Config.buildId}/${cacheKey}`;
  }

  private async storeDynamoDBTagMappings(
    cacheKey: string,
    tags: string[],
  ): Promise<void> {
    try {
      if (this.isDynamoCircuitOpen()) {
        console.warn(
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
            cacheKey: { S: cacheKey },
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

  private clearMemoryCacheByTag(tag: string): void {
    // Get all cache keys associated with this tag
    const cacheKeys = this.inMemoryTagCache.get(tag);
    if (cacheKeys) {
      // Remove each cache entry
      for (const cacheKey of cacheKeys) {
        this.inMemoryCache.delete(cacheKey);
      }

      // Remove the tag mapping
      this.inMemoryTagCache.delete(tag);

      // Clean up any references to these cache keys in other tags
      for (const [otherTag, otherKeys] of this.inMemoryTagCache.entries()) {
        for (const cacheKey of cacheKeys) {
          otherKeys.delete(cacheKey);
        }
        // Remove empty tag sets
        if (otherKeys.size === 0) {
          this.inMemoryTagCache.delete(otherTag);
        }
      }
    }
  }

  private isS3CircuitOpen(): boolean {
    const now = Date.now();
    const timeSinceLastFailure = now - this.circuitBreaker.lastFailureTime;

    // Circuit breaker: if more than 5 failures in the last 5 minutes, open circuit
    if (this.circuitBreaker.s3Failures >= 5 && timeSinceLastFailure < 300000) {
      return true;
    }

    // Reset failures if enough time has passed
    if (timeSinceLastFailure > 300000) {
      this.circuitBreaker.s3Failures = 0;
    }

    return false;
  }

  private isDynamoCircuitOpen(): boolean {
    const now = Date.now();
    const timeSinceLastFailure = now - this.circuitBreaker.lastFailureTime;

    // Circuit breaker: if more than 5 failures in the last 5 minutes, open circuit
    if (
      this.circuitBreaker.dynamoFailures >= 5 &&
      timeSinceLastFailure < 300000
    ) {
      return true;
    }

    // Reset failures if enough time has passed
    if (timeSinceLastFailure > 300000) {
      this.circuitBreaker.dynamoFailures = 0;
    }

    return false;
  }

  private handleS3Failure(): void {
    this.circuitBreaker.s3Failures++;
    this.circuitBreaker.lastFailureTime = Date.now();

    // Log detailed error information for monitoring
    console.error(
      `S3 Cache Handler: Failure count ${this.circuitBreaker.s3Failures}/5. Circuit breaker will open at 5 failures.`,
    );

    if (this.circuitBreaker.s3Failures >= 5) {
      console.error(
        "S3 Cache Handler: Circuit breaker opened due to repeated failures. Falling back to in-memory cache.",
      );
    }
  }

  private handleDynamoFailure(): void {
    this.circuitBreaker.dynamoFailures++;
    this.circuitBreaker.lastFailureTime = Date.now();

    // Log detailed error information for monitoring
    console.error(
      `DynamoDB Revalidation: Failure count ${this.circuitBreaker.dynamoFailures}/5. Circuit breaker will open at 5 failures.`,
    );

    if (this.circuitBreaker.dynamoFailures >= 5) {
      console.error(
        "DynamoDB Revalidation: Circuit breaker opened due to repeated failures. Revalidation tracking disabled.",
      );
    }
  }

  // Add method for health check and monitoring
  public getHealthStatus(): {
    s3Available: boolean;
    dynamoAvailable: boolean;
    memoryCacheSize: number;
    tagCacheSize: number;
    circuitBreakerStatus: {
      s3Failures: number;
      dynamoFailures: number;
      lastFailureTime: number;
    };
  } {
    return {
      s3Available: !this.isS3CircuitOpen(),
      dynamoAvailable: !this.isDynamoCircuitOpen(),
      memoryCacheSize: this.inMemoryCache.size,
      tagCacheSize: this.inMemoryTagCache.size,
      circuitBreakerStatus: {
        s3Failures: this.circuitBreaker.s3Failures,
        dynamoFailures: this.circuitBreaker.dynamoFailures,
        lastFailureTime: this.circuitBreaker.lastFailureTime,
      },
    };
  }

  // Add method to manually reset circuit breakers (for operational purposes)
  public resetCircuitBreakers(): void {
    this.circuitBreaker.s3Failures = 0;
    this.circuitBreaker.dynamoFailures = 0;
    this.circuitBreaker.lastFailureTime = 0;
    console.info("Cache Handler: Circuit breakers manually reset");
  }

  // Add method to manually clear tag cache (for operational purposes)
  public clearTagCache(): void {
    this.inMemoryTagCache.clear();
    console.info("Cache Handler: Tag cache manually cleared");
  }

  // Enhanced error categorization
  private categorizeError(
    error: any,
  ): "network" | "permission" | "throttling" | "unknown" {
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
}

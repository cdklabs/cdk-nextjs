/*
  S3 and DynamoDB cache handler for Next.js incremental cache
*/
/* eslint-disable import/no-extraneous-dependencies */
import { join } from "node:path";
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
  NoSuchKey,
} from "@aws-sdk/client-s3";
import getDebug from "debug";
import {
  CacheHandler,
  CacheHandlerValue,
  CacheHandlerContext,
} from "next/dist/server/lib/incremental-cache";
import {
  IncrementalCacheValue,
  GetIncrementalFetchCacheContext,
  GetIncrementalResponseCacheContext,
  SetIncrementalFetchCacheContext,
  SetIncrementalResponseCacheContext,
} from "next/dist/server/response-cache";
import { serializeCacheValue, parseCacheValue, getTags } from "./cache-utils";

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

export interface S3DynamoCacheHandlerOptions {
  context: CacheHandlerContext;
  s3Config?: Partial<S3CacheConfig>;
  dynamoConfig?: Partial<DynamoDBRevalidationConfig>;
}

export class S3DynamoCacheHandler implements CacheHandler {
  private s3Client: S3Client;
  private dynamoClient: DynamoDBClient;
  private s3Config: S3CacheConfig;
  private dynamoConfig: DynamoDBRevalidationConfig;
  private debug = getDebug("cdk-nextjs:cache-handler:s3-dynamo");

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

    // Initialize AWS clients
    this.s3Client = new S3Client({ region: this.s3Config.region });
    this.dynamoClient = new DynamoDBClient({
      region: this.dynamoConfig.region,
    });

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
      // Log context for debugging (optional usage to avoid unused parameter warning)
      if (ctx.kind) {
        this.debug(
          `S3 cache get operation for ${cacheKey} with kind: ${ctx.kind}`,
        );
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
        const parsedValue = parseCacheValue(bodyString);

        // Extract the actual CacheHandlerValue (without tags) for return
        cacheValue = {
          lastModified: parsedValue.lastModified,
          value: parsedValue.value,
        };

        // Check if cache has been invalidated by tag revalidation
        const storedTags = parsedValue.tags || [];
        if (storedTags.length > 0 && this.dynamoConfig.tableName) {
          const isInvalidated = await this.checkIfRevalidated(
            cacheValue.lastModified,
            storedTags,
          );
          if (isInvalidated) {
            this.debug(`S3 CACHE INVALIDATED BY TAG: ${cacheKey}`);
            // Delete the stale S3 entry
            await this.deleteS3Entry(s3Key);
            return null;
          }
        }
      } else {
        console.log(`Invalid content type: ${contentType}`);
        // This shouldn't happen since we always store as JSON now, but handle legacy data
        // Since we don't know the exact structure, return null for legacy non-JSON data
        return null;
      }

      this.debug(`S3 CACHE HIT: ${cacheKey} (${s3Key})`);

      return cacheValue;
    } catch (error) {
      if (error instanceof NoSuchKey) {
        this.debug(`S3 CACHE MISS: ${cacheKey}`);
        return null;
      }

      // Log actual errors (not cache misses)
      console.error(`Error retrieving cache from S3:`, error);
      return null;
    }
  }

  async set(
    cacheKey: string,
    data: IncrementalCacheValue | null,
    ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext,
  ): Promise<void> {
    try {
      if (!data) {
        // Delete from S3 and DynamoDB
        this.debug(`S3 CACHE DELETE: ${cacheKey}`);

        if (!this.s3Config.bucketName) {
          return;
        }

        // Build S3 key without needing to know the kind
        const s3Key = this.buildS3Key(cacheKey);

        try {
          const deleteCommand = new DeleteObjectCommand({
            Bucket: this.s3Config.bucketName,
            Key: s3Key,
          });
          await this.s3Client.send(deleteCommand);
          this.debug(`S3 CACHE DELETED: ${s3Key}`);
        } catch (error) {
          if (error instanceof NoSuchKey) {
            this.debug(`Failed to delete S3 key ${s3Key}:`, error);
          }
        }

        // TODO: Also delete tag associations from DynamoDB if needed
        return;
      }

      // Debug logging to understand what data is being cached
      const tags = getTags(ctx);
      this.debug(`S3 CACHE SET: Key: ${cacheKey}, tags: ${tags || "none"}`);

      // Note: ctx.tags are available but revalidation is handled separately in revalidateTag method
      // Log tags for debugging if present (only in SetIncrementalFetchCacheContext)
      if (tags && tags.length > 0) {
        this.debug(`S3 cache entry for ${cacheKey} has tags:`, tags);
      }

      if (!this.s3Config.bucketName) {
        return;
      }

      const s3Key = this.buildS3Key(cacheKey);

      // Create CacheHandlerValue structure for S3 storage with tags
      const cacheHandlerValue: CacheHandlerValue = {
        lastModified: Date.now(),
        value: data,
      };

      // Store tags with the cache entry for revalidation checking
      const cacheEntryWithTags = {
        ...cacheHandlerValue,
        tags: tags || [],
      };

      // Serialize with custom handling for Map and Buffer objects
      const body = serializeCacheValue(cacheEntryWithTags);

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

      this.debug(`S3 CACHE STORED: ${cacheKey} (${data.kind})`);

      // Store tag-to-cache-key mappings in DynamoDB for revalidation
      if (tags && tags.length > 0 && this.dynamoConfig.tableName) {
        this.debug(`STORING TAGS: ${cacheKey} -> [${tags.join(", ")}]`);
        await this.storeDynamoDBTagMappings(s3Key, tags);
      }
    } catch (error) {
      console.error("Error storing cache to S3:", error);
    }
  }

  async revalidateTag(tag: string | string[]): Promise<void> {
    const tags = Array.isArray(tag) ? tag : [tag];
    this.debug(`REVALIDATING TAGS: [${tags.join(", ")}]`);

    try {
      if (!this.dynamoConfig.tableName) {
        return;
      }

      // Process all tags in parallel for better performance
      await Promise.all(tags.map((t) => this.revalidateSingleTag(t)));
    } catch (error) {
      console.error("Error updating revalidation metadata:", error);
    }
  }

  private async revalidateSingleTag(tag: string): Promise<void> {
    // Query all paths associated with this tag
    const queryCommand = new QueryCommand({
      TableName: this.dynamoConfig.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :skPrefix)",
      ExpressionAttributeValues: {
        ":pk": { S: this.dynamoConfig.buildId },
        ":skPrefix": { S: `${tag}#` },
      },
    });

    const queryResponse = await this.dynamoClient.send(queryCommand);

    if (queryResponse.Items) {
      // Extract S3 keys from sort keys (format: "tag#s3Key")
      const cacheKeys = queryResponse.Items.map((item) => {
        const sk = item.sk?.S;
        if (sk) {
          const hashIndex = sk.indexOf("#");
          return hashIndex !== -1 ? sk.substring(hashIndex + 1) : null;
        }
        return null;
      }).filter(Boolean);

      this.debug(
        `TAG ${tag}: Found ${cacheKeys.length} cache entries to invalidate`,
      );

      // Update revalidation timestamp for all cache keys with this tag
      const updatePromises = queryResponse.Items.map(async (item) => {
        const sk = item.sk?.S;
        if (sk) {
          const updateCommand = new UpdateItemCommand({
            TableName: this.dynamoConfig.tableName,
            Key: {
              pk: { S: this.dynamoConfig.buildId },
              sk: { S: sk },
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
        const deletePromises = cacheKeys.map(async (s3Key) => {
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

  private buildS3Key(cacheKey: string): string {
    // Use BUILD_ID prefixing: {buildId}/{cacheKey}.json

    // Handle edge cases:
    // - Root path "/" should become "index" or similar
    // - Remove leading slashes to prevent empty folders
    let cleanCacheKey = cacheKey;

    if (cacheKey === "/" || cacheKey === "") {
      cleanCacheKey = "index";
    } else if (cacheKey.startsWith("/")) {
      cleanCacheKey = cacheKey.slice(1);
    }

    return join(this.s3Config.buildId, `${cleanCacheKey}.json`);
  }

  private async storeDynamoDBTagMappings(
    s3Key: string,
    tags: string[],
  ): Promise<void> {
    try {
      const updatePromises = tags.map(async (tag) => {
        const tagCacheKey = `${tag}#${s3Key}`;
        const updateCommand = new UpdateItemCommand({
          TableName: this.dynamoConfig.tableName,
          Key: {
            pk: { S: this.dynamoConfig.buildId },
            sk: { S: tagCacheKey },
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
    } catch (error) {
      console.error("Error storing DynamoDB tag mappings:", error);
      // Don't throw - cache storage should continue even if tag mapping fails
    }
  }

  private async checkIfRevalidated(
    cacheLastModified: number,
    tags: string[],
  ): Promise<boolean> {
    try {
      // Check each tag to see if it has been revalidated after the cache was created
      for (const tag of tags) {
        const queryCommand = new QueryCommand({
          TableName: this.dynamoConfig.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :skPrefix)",
          ExpressionAttributeValues: {
            ":pk": { S: this.dynamoConfig.buildId },
            ":skPrefix": { S: `${tag}#` },
          },
          ProjectionExpression: "revalidatedAt",
          Limit: 1, // We only need to check if any entry exists with this tag
        });

        const queryResponse = await this.dynamoClient.send(queryCommand);

        if (queryResponse.Items && queryResponse.Items.length > 0) {
          const revalidatedAt = queryResponse.Items[0].revalidatedAt?.N;
          if (revalidatedAt && parseInt(revalidatedAt) > cacheLastModified) {
            this.debug(
              `Tag ${tag} was revalidated at ${revalidatedAt}, cache created at ${cacheLastModified}`,
            );
            return true; // Cache is invalidated
          }
        }
      }

      return false; // Cache is still valid
    } catch (error) {
      console.error("Error checking cache revalidation:", error);
      // On error, assume cache is valid to avoid unnecessary cache misses
      return false;
    }
  }

  private async deleteS3Entry(s3Key: string): Promise<void> {
    try {
      if (!this.s3Config.bucketName) {
        return;
      }

      const deleteCommand = new DeleteObjectCommand({
        Bucket: this.s3Config.bucketName,
        Key: s3Key,
      });

      await this.s3Client.send(deleteCommand);
      this.debug(`Deleted stale S3 cache entry: ${s3Key}`);
    } catch (error) {
      // Log but don't fail - the entry might not exist in S3
      console.warn(`Failed to delete stale S3 cache entry ${s3Key}:`, error);
    }
  }
}

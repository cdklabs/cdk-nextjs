/*
  Next.js Custom Cache Handler. See: https://nextjs.org/docs/app/api-reference/next-config-js/incrementalCacheHandlerPath
  
  Orchestrator cache handler that conditionally uses different caching strategies:
  - Build time: LocalFileCacheHandler for pre-caching
  - Runtime: MemoryCacheHandler (fast) + S3DynamoCacheHandler (persistent)
*/
/* eslint-disable import/no-extraneous-dependencies */
import getDebug from "debug";
import {
  CacheHandler,
  CacheHandlerValue,
  CacheHandlerContext,
} from "next/dist/server/lib/incremental-cache";
import type {
  IncrementalCacheValue,
  GetIncrementalFetchCacheContext,
  GetIncrementalResponseCacheContext,
  SetIncrementalFetchCacheContext,
  SetIncrementalResponseCacheContext,
} from "next/dist/server/response-cache";
import { LocalFileCacheHandler } from "./local-file-cache-handler";
import { MemoryCacheHandler } from "./memory-cache-handler";
import { S3CacheHandler } from "./s3-cache-handler";

// Helper to safely extract tags from context
const getTags = (
  ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext,
): string[] | undefined => ("tags" in ctx ? ctx.tags : undefined);

/**
 * Orchestrator cache handler that conditionally instantiates handlers based on environment
 */
export default class CdkNextjsCacheHandler implements CacheHandler {
  private readonly isBuildTime =
    process.env.NEXT_PHASE === "phase-production-build";
  private readonly debug = getDebug("cdk-nextjs:cache-handler:orchestrator");

  // Build-time handler
  private localFileHandler: LocalFileCacheHandler | null = null;

  // Runtime handlers (shared across all instances)
  private memoryHandler: MemoryCacheHandler | null = null;
  private s3DynamoHandler: S3CacheHandler | null = null;

  /**
   * Shared singleton handlers for runtime.
   *
   * Next.js creates multiple cache handler instances (one each for APP_PAGE, APP_ROUTE, FETCH, etc).
   * Using singleton pattern provides:
   * - Single S3 client connection pool shared across all cache types
   * - Unified memory cache accessible by all instances (cache hits benefit all)
   * - Lower memory footprint and faster initialization
   * - Same CacheHandlerContext for all instances, so no configuration loss
   */
  private static sharedMemoryHandler: MemoryCacheHandler | null = null;
  private static sharedS3DynamoHandler: S3CacheHandler | null = null;

  constructor(options: CacheHandlerContext) {
    if (this.isBuildTime) {
      // Build time: only local file cache
      this.localFileHandler = new LocalFileCacheHandler();

      this.debug("Build-time mode: LocalFileCacheHandler initialized");
      this.debug(`Cache directory: ${this.localFileHandler.getCacheDir()}`);
    } else {
      // Runtime: reuse shared handlers (singleton pattern)
      // Initialize once on first construction
      if (!CdkNextjsCacheHandler.sharedS3DynamoHandler) {
        CdkNextjsCacheHandler.sharedS3DynamoHandler = new S3CacheHandler({
          context: options,
        });
        this.debug("Initialized shared S3/DynamoDB handler");
      }

      if (!CdkNextjsCacheHandler.sharedMemoryHandler) {
        CdkNextjsCacheHandler.sharedMemoryHandler = new MemoryCacheHandler({
          context: options,
        });
        this.debug("Initialized shared Memory handler");
      }

      // Reference shared instances
      this.s3DynamoHandler = CdkNextjsCacheHandler.sharedS3DynamoHandler;
      this.memoryHandler = CdkNextjsCacheHandler.sharedMemoryHandler;
    }
  }

  /**
   * Get cache entry
   * - Build time: Not implemented (build doesn't read cache)
   * - Runtime: Try memory first, then S3/DynamoDB
   */
  async get(
    cacheKey: string,
    ctx: GetIncrementalFetchCacheContext | GetIncrementalResponseCacheContext,
  ): Promise<CacheHandlerValue | null> {
    if (this.isBuildTime) {
      // Build time doesn't read from cache
      return null;
    }

    // Runtime: try memory first
    if (this.memoryHandler) {
      const memoryResult = await this.memoryHandler.get(cacheKey, ctx);
      if (memoryResult) {
        this.debug(`Memory cache HIT: ${cacheKey}`);
        return memoryResult;
      }
    }

    // Memory miss - try S3/DynamoDB
    if (this.s3DynamoHandler) {
      const s3Result = await this.s3DynamoHandler.get(cacheKey, ctx);
      if (s3Result) {
        this.debug(`S3 cache HIT: ${cacheKey}`);
        // Populate memory cache for next time
        if (this.memoryHandler) {
          await this.memoryHandler.set(cacheKey, s3Result.value, ctx as any);
        }
        return s3Result;
      }
    }

    this.debug(`Cache MISS: ${cacheKey}`);
    return null;
  }

  /**
   * Set cache entry
   * - Build time: Write to local file cache only (or delete if data is null)
   * - Runtime: Write to both memory and S3/DynamoDB (or delete if data is null)
   */
  async set(
    cacheKey: string,
    data: IncrementalCacheValue | null,
    ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext,
  ): Promise<void> {
    if (this.isBuildTime) {
      // Build time: write or delete from local file cache
      if (this.localFileHandler) {
        if (data) {
          const tags = getTags(ctx);
          await this.localFileHandler.set(cacheKey, data, tags);
          this.debug(`Build cache write: ${cacheKey}`);
        } else {
          // Delete not implemented for local file cache (build-time only creates files)
          this.debug(`Build cache delete ignored: ${cacheKey}`);
        }
      }
    } else {
      // Runtime: write or delete from memory and S3/DynamoDB
      if (data) {
        // Write to memory
        if (this.memoryHandler) {
          await this.memoryHandler.set(cacheKey, data, ctx);
          this.debug(`Memory cache write: ${cacheKey}`);
        }

        // Also write to S3/DynamoDB for persistence
        if (this.s3DynamoHandler) {
          await this.s3DynamoHandler.set(cacheKey, data, ctx);
          this.debug(`S3 cache write: ${cacheKey}`);
        }
      } else {
        // Delete from both layers
        this.debug(`Cache delete: ${cacheKey}`);

        // Delete from memory (removes from cache Map)
        if (this.memoryHandler) {
          await this.memoryHandler.set(cacheKey, null, ctx);
        }

        // Delete from S3/DynamoDB
        if (this.s3DynamoHandler) {
          await this.s3DynamoHandler.set(cacheKey, null, ctx);
        }
      }
    }
  }

  /**
   * Revalidate tags
   * - Build time: Not implemented
   * - Runtime: Delegate to S3/DynamoDB handler
   */
  async revalidateTag(tag: string): Promise<void> {
    if (this.isBuildTime) {
      return;
    }

    // Clear from memory
    if (this.memoryHandler) {
      await this.memoryHandler.revalidateTag(tag);
    }

    // Clear from S3/DynamoDB
    if (this.s3DynamoHandler) {
      await this.s3DynamoHandler.revalidateTag(tag);
    }
  }

  /**
   * Reset request cache (called between requests)
   */
  async resetRequestCache(): Promise<void> {
    if (this.memoryHandler) {
      await this.memoryHandler.resetRequestCache();
    }
  }
}

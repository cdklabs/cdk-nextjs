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
import { getTags } from "./cache-utils";
import { LocalFileCacheHandler } from "./local-file-cache-handler";
import { MemoryCacheHandler } from "./memory-cache-handler";
import { S3CacheHandler } from "./s3-cache-handler";
import { isBuildPhase } from "./use-cache-common";

/**
 * Orchestrator cache handler that conditionally instantiates handlers based on environment
 */
export default class CdkNextjsCacheHandler implements CacheHandler {
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

  private readonly isBuildTime = isBuildPhase();
  private readonly debug = getDebug("cdk-nextjs:cache-handler:orchestrator");

  // Set only at build time.
  private localFileHandler!: LocalFileCacheHandler;

  // Set only at runtime, shared across all instances.
  private memoryHandler!: MemoryCacheHandler;
  private s3DynamoHandler!: S3CacheHandler;

  constructor(options: CacheHandlerContext) {
    if (this.isBuildTime) {
      this.localFileHandler = new LocalFileCacheHandler();
      this.debug(
        `Build-time cache directory: ${this.localFileHandler.getCacheDir()}`,
      );
    } else {
      this.s3DynamoHandler = CdkNextjsCacheHandler.sharedS3DynamoHandler ??=
        new S3CacheHandler({ context: options });
      this.memoryHandler = CdkNextjsCacheHandler.sharedMemoryHandler ??=
        new MemoryCacheHandler({ context: options });
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
      // Reads back what this build wrote, which `cacheComponents` prerendering
      // requires; see {@link LocalFileCacheHandler.get}.
      return this.localFileHandler.get(cacheKey);
    }

    // Runtime: try memory first
    const memoryResult = await this.memoryHandler.get(cacheKey, ctx);
    // A memory hit is checked against the same tag markers an S3 read is.
    // `revalidateTag` can only clear the memory of the instance that ran it,
    // so skipping the check left every other instance answering from memory
    // for the whole memory TTL - and CloudFront, whose copy that
    // `revalidateTag` had just invalidated, cached the stale page again.
    // The check is one DynamoDB `BatchGetItem`; what the memory layer still
    // saves is the S3 read and the parse of the body. A revalidated entry is
    // dropped and read from S3, which hands it back expired or as a miss.
    if (
      memoryResult &&
      (await this.s3DynamoHandler.isRevalidated(
        {
          lastModified: memoryResult.lastModified,
          value: memoryResult.value,
        },
        ctx,
        cacheKey,
      ))
    ) {
      this.debug(`Memory cache REVALIDATED: ${cacheKey}`);
      await this.memoryHandler.set(cacheKey, null);
    } else if (memoryResult) {
      this.debug(`Memory cache HIT: ${cacheKey}`);
      return memoryResult;
    }

    // Memory miss - try S3/DynamoDB
    const s3Result = await this.s3DynamoHandler.get(cacheKey, ctx);
    if (s3Result) {
      this.debug(`S3 cache HIT: ${cacheKey}`);
      // Promoted with the S3 entry's own `lastModified`, not the time of the
      // copy: Next.js ages the entry from it for time-based revalidation, and
      // the tag markers are compared against it too. Stamping `Date.now()`
      // made an entry that was due for regeneration look freshly rendered,
      // and one a soft `revalidateTag` had made stale look newer than the
      // stale mark, so memory hits served it as fresh for the whole memory
      // TTL. An entry a tag revalidation expired (`lastModified: -1`) is not
      // copied at all: the re-render it asks for writes the fresh entry to
      // both layers.
      if (s3Result.lastModified !== -1) {
        await this.memoryHandler.set(
          cacheKey,
          s3Result.value,
          s3Result.lastModified,
        );
      }
      return s3Result;
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
      if (data) {
        await this.localFileHandler.set(cacheKey, data, getTags(ctx));
        this.debug(`Build cache write: ${cacheKey}`);
      } else {
        // Delete not implemented for local file cache (build-time only creates files)
        this.debug(`Build cache delete ignored: ${cacheKey}`);
      }
      return;
    }
    // Runtime: both layers, where `null` is a delete.
    this.debug(`Cache ${data ? "write" : "delete"}: ${cacheKey}`);
    await this.memoryHandler.set(cacheKey, data);
    await this.s3DynamoHandler.set(cacheKey, data, ctx);
  }

  /**
   * Revalidate tags
   * - Build time: Not implemented
   * - Runtime: Delegate to S3/DynamoDB handler
   */
  async revalidateTag(
    tag: string | string[],
    durations?: { expire?: number },
  ): Promise<void> {
    if (this.isBuildTime) {
      return;
    }

    // Memory hits are checked against the same markers (see `get`), so only
    // the S3/DynamoDB handler has anything to record.
    await this.s3DynamoHandler.revalidateTag(tag, durations);
  }

  /**
   * Deliberately a no-op. Next.js calls `resetRequestCache` at the start of
   * every request (`base-server`, `app-page`, `app-route`), and its own
   * `FileSystemCache` - whose LRU is shared across requests the same way the
   * memory layer is - leaves it empty: the hook is for state scoped to one
   * request, and nothing here is. Clearing the memory layer in it meant no
   * entry ever survived to a second request, so every read went to S3.
   */
  async resetRequestCache(): Promise<void> {}
}

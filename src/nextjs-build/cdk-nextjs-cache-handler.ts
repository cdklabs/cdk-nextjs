/*
  This file is compiled as defined in .projenrc.ts to be used as Next.js
  Custom Cache Handler. See: https://nextjs.org/docs/app/api-reference/next-config-js/incrementalCacheHandlerPath
  
  This is a composable cache handler that uses memory cache as the primary layer
  and S3/DynamoDB as the fallback layer.
*/
/* eslint-disable import/no-extraneous-dependencies */
import { CacheHandlerContext } from "next/dist/server/lib/incremental-cache";
import { getDebug } from "./debug";
import { MemoryCacheHandler } from "./memory-cache-handler";
import { S3DynamoCacheHandler } from "./s3-dynamo-cache-handler";

export default class CdkNextjsCacheHandler extends MemoryCacheHandler {
  private s3DynamoHandler: S3DynamoCacheHandler;
  private compositeDebug = getDebug("cdk-nextjs-cache-handler:composite");

  constructor(options: CacheHandlerContext) {
    // Create the S3/DynamoDB fallback handler
    const s3DynamoHandler = new S3DynamoCacheHandler({
      context: options,
    });

    // Initialize the memory cache handler with the S3/DynamoDB handler as fallback
    super({
      context: options,
      ttlMs: 60000, // 1 minute TTL for memory cache
      fallbackHandler: s3DynamoHandler,
    });

    // Store reference to the S3/DynamoDB handler for direct access
    this.s3DynamoHandler = s3DynamoHandler;

    // Log initialization
    if (options.dev) {
      this.compositeDebug(
        "CdkNextjsCacheHandler initialized with memory + S3/DynamoDB layers",
      );
    }
  }

  // Expose health status from both layers with a different method name to avoid override issues
  public getCompositeHealthStatus(): {
    memoryLayer: ReturnType<MemoryCacheHandler["getHealthStatus"]>;
    s3DynamoLayer: ReturnType<S3DynamoCacheHandler["getHealthStatus"]>;
  } {
    const memoryStatus = super.getHealthStatus();
    const s3DynamoStatus = this.s3DynamoHandler.getHealthStatus();

    return {
      memoryLayer: memoryStatus,
      s3DynamoLayer: s3DynamoStatus,
    };
  }

  // Expose circuit breaker reset from S3/DynamoDB layer
  public resetCircuitBreakers(): void {
    if (this.s3DynamoHandler?.resetCircuitBreakers) {
      this.s3DynamoHandler.resetCircuitBreakers();
    }
  }
}

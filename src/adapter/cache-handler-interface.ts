/*
  Base interface for cache handlers to ensure consistent API
*/
/* eslint-disable import/no-extraneous-dependencies */
import {
  CacheHandlerValue,
  CacheHandlerContext,
} from "next/dist/server/lib/incremental-cache";
import {
  IncrementalCacheValue,
  GetIncrementalFetchCacheContext,
  GetIncrementalResponseCacheContext,
} from "next/dist/server/response-cache";

export interface CacheHandler {
  get(
    cacheKey: string,
    ctx: GetIncrementalFetchCacheContext | GetIncrementalResponseCacheContext,
  ): Promise<CacheHandlerValue | null>;

  set(
    cacheKey: string,
    data: IncrementalCacheValue | null,
    ctx: { tags: string[] },
  ): Promise<void>;

  revalidateTag(tag: string | string[]): Promise<void>;

  resetRequestCache(): Promise<void>;
}

export interface CacheHandlerOptions {
  context: CacheHandlerContext;
}

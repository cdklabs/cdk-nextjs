/*
  The S3 / DynamoDB plumbing shared by every cdk-nextjs cache handler: the
  incremental `cacheHandler` (`S3CacheHandler`) and the `cacheHandlers` for
  `'use cache'` / `'use cache: remote'`.

  What lives here is what has to agree between them - where the configuration
  comes from, how a cache key becomes an S3 key, and what a tag's marker row in
  the revalidation table looks like and means. A `revalidateTag` reaches both
  kinds of handler, and they must read each other's markers the same way.
*/
/* eslint-disable import/no-extraneous-dependencies */
import { join } from "node:path";
import {
  AttributeValue,
  BatchGetItemCommand,
  BatchGetItemCommandOutput,
  DynamoDBClient,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * Where the cache lives, as the constructs pass it to the compute through the
 * environment (`NextjsFunctions`, `NextjsContainers`). Empty strings for what is
 * not configured, which each handler reads as "that layer is disabled".
 */
export interface AwsCacheConfig {
  /** `CDK_NEXTJS_CACHE_BUCKET_NAME`. */
  bucketName: string;
  /** `CDK_NEXTJS_REVALIDATION_TABLE_NAME`. */
  tableName: string;
  /** `AWS_REGION`, `us-east-1` when unset. */
  region: string;
  /** `CDK_NEXTJS_BUILD_ID`: every S3 key and every marker row is scoped to it. */
  buildId: string;
}

/** The configuration from the environment, `overrides` taking precedence. */
export function resolveAwsCacheConfig(
  overrides: Partial<AwsCacheConfig> = {},
): AwsCacheConfig {
  return {
    bucketName:
      overrides.bucketName || process.env.CDK_NEXTJS_CACHE_BUCKET_NAME || "",
    tableName:
      overrides.tableName ||
      process.env.CDK_NEXTJS_REVALIDATION_TABLE_NAME ||
      "",
    region: overrides.region || process.env.AWS_REGION || "us-east-1",
    buildId: overrides.buildId || process.env.CDK_NEXTJS_BUILD_ID || "",
  };
}

/**
 * `{buildId}/{cacheKey}.json`, the incremental cache's key convention.
 *
 * The root path becomes `index`, and a leading slash is dropped so there is no
 * empty folder under the build prefix. Everything this returns ends in `.json`,
 * which is what keeps it disjoint from {@link useCacheS3Key}.
 */
export function buildS3Key(buildId: string, cacheKey: string): string {
  let cleanCacheKey = cacheKey;
  if (cacheKey === "/" || cacheKey === "") {
    cleanCacheKey = "index";
  } else if (cacheKey.startsWith("/")) {
    cleanCacheKey = cacheKey.slice(1);
  }
  return join(buildId, `${cleanCacheKey}.json`);
}

/**
 * The folder under the build prefix that `'use cache'` entries are stored in.
 * @see useCacheS3Key
 */
export const USE_CACHE_KEY_PREFIX = "_use-cache";

/**
 * `{buildId}/_use-cache/{hash}.entry`, where a `cacheHandlers` entry is stored.
 *
 * Hashed because a `'use cache'` key is the serialized arguments of the call and
 * has no length limit, where an S3 key stops at 1024 bytes. The `.entry` suffix
 * rather than `.json` is what makes a collision with the incremental cache
 * impossible rather than unlikely: every key {@link buildS3Key} writes ends in
 * `.json`, including one for a route that happens to be named `/_use-cache/…`.
 * Still under the build prefix, so post-deploy pruning drops them with the build.
 */
export function useCacheS3Key(buildId: string, keyHash: string): string {
  return join(buildId, USE_CACHE_KEY_PREFIX, `${keyHash}.entry`);
}

/**
 * The `durations` Next.js 16 passes a tag revalidation for a profile:
 * `revalidateTag("posts", "max")` arrives as `{ expire: <the profile's expire> }`.
 * Absent for `updateTag` and a bare `revalidateTag`, which expire immediately.
 */
export interface RevalidateDurations {
  expire?: number;
}

/**
 * A tag's marker row, as timestamps in milliseconds. Written by
 * {@link markerUpdate}; each field is absent until a revalidation of that shape
 * has happened.
 */
export interface TagMarker {
  /** Expired outright: `updateTag`, or `revalidateTag` with no profile. */
  revalidatedAt?: number;
  /** Stale from here: `revalidateTag(tag, profile)`. */
  staleAt?: number;
  /** When the profile's `expire` runs out, which may be in the future. */
  expiredAt?: number;
}

/**
 * What the tag markers say about an entry: untouched, served stale while a
 * background render replaces it, or expired and re-rendered before answering.
 */
export type RevalidationState = "fresh" | "stale" | "expired";

/**
 * What `marker` means for an entry created at `createdAt`, at `now`.
 *
 * `expiredAt` in the future is a profile's `expire` that has not come yet,
 * compared the way Next.js's `areTagsExpired` does.
 */
export function markerState(
  marker: TagMarker,
  createdAt: number,
  now: number,
): RevalidationState {
  const { revalidatedAt, expiredAt, staleAt } = marker;
  if (
    (revalidatedAt !== undefined && revalidatedAt > createdAt) ||
    (expiredAt !== undefined && expiredAt <= now && expiredAt > createdAt)
  ) {
    return "expired";
  }
  if (staleAt !== undefined && staleAt > createdAt) {
    return "stale";
  }
  return "fresh";
}

/**
 * The marker a tag revalidated at `now` gets, as {@link markerUpdate} writes it -
 * for a handler to apply to its own copy without waiting to read it back.
 */
export function markerFor(
  now: number,
  durations: RevalidateDurations | undefined,
): TagMarker {
  if (!durations) {
    return { revalidatedAt: now };
  }
  if (durations.expire === undefined) {
    return { staleAt: now };
  }
  return { staleAt: now, expiredAt: now + durations.expire * 1000 };
}

/**
 * The marker-row update for a tag revalidated at `now`.
 *
 * Without `durations` - `updateTag`, or `revalidateTag` with no profile - the
 * tag's entries expire immediately (`revalidatedAt`). With them the entries go
 * stale now and expire after the profile's `expire`, the same pair of
 * timestamps Next.js's `FileSystemCache.revalidateTag` records.
 */
export function markerUpdate(
  now: number,
  durations: RevalidateDurations | undefined,
): Pick<
  ConstructorParameters<typeof UpdateItemCommand>[0],
  "UpdateExpression" | "ExpressionAttributeValues"
> {
  if (!durations) {
    return {
      UpdateExpression: "SET revalidatedAt = :timestamp",
      ExpressionAttributeValues: { ":timestamp": { N: String(now) } },
    };
  }
  if (durations.expire === undefined) {
    return {
      UpdateExpression: "SET staleAt = :stale",
      ExpressionAttributeValues: { ":stale": { N: String(now) } },
    };
  }
  return {
    UpdateExpression: "SET staleAt = :stale, expiredAt = :expired",
    ExpressionAttributeValues: {
      ":stale": { N: String(now) },
      ":expired": { N: String(now + durations.expire * 1000) },
    },
  };
}

/** A DynamoDB number attribute as a number, or `undefined` when absent. */
function numberAttribute(
  value: AttributeValue | undefined,
): number | undefined {
  return value?.N === undefined ? undefined : Number(value.N);
}

/** DynamoDB's cap on keys in one `BatchGetItem`. */
export const BATCH_GET_MAX_KEYS = 100;

/**
 * How long one instance trusts a tag marker it read, unless
 * `CDK_NEXTJS_TAG_MARKER_TTL_MS` says otherwise. Every cache hit checks its tags'
 * markers, and every marker of a deployment shares one partition key, so
 * reading them per request capped a route's cache hits at the partition's read
 * throughput (~1,900 req/s on NextjsRegionalFunctions). Held for a second, the
 * reads scale with instances and tags instead of requests; the cost is that a
 * `revalidateTag` another instance ran reaches this one up to a second late.
 */
export const DEFAULT_TAG_MARKER_TTL_MS = 1000;

/** Past this many cached markers, expired ones are swept on the next read. */
const TAG_MARKER_CACHE_SWEEP_SIZE = 1000;

/**
 * `CDK_NEXTJS_TAG_MARKER_TTL_MS` as a TTL, or the default when it is unset or
 * not a non-negative number.
 */
export function tagMarkerTtl(value: string | undefined): number {
  const ttl = value === undefined || value === "" ? NaN : Number(value);
  return Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULT_TAG_MARKER_TTL_MS;
}

/**
 * The bare-tag marker rows of the revalidation table (`pk = buildId`,
 * `sk = tag`), which record when a tag was last revalidated and how.
 *
 * The table also holds the incremental cache's `tag#s3Key` mapping rows, which
 * are its own business and stay in `S3CacheHandler`: only the markers mean the
 * same thing to every handler.
 */
export class TagMarkerTable {
  /**
   * Tag markers by tag, each the read that fetched it, so concurrent checks
   * share one `BatchGetItem` rather than each sending their own.
   * @see read
   */
  private cached = new Map<
    string,
    { expiresAt: number; marker: Promise<TagMarker | undefined> }
  >();

  /**
   * @param markerTtlMs How long a tag's marker row, once read, answers every
   * check on this instance without reading DynamoDB again. `0` reads it on
   * every check. See {@link DEFAULT_TAG_MARKER_TTL_MS}.
   */
  constructor(
    private readonly client: DynamoDBClient,
    private readonly tableName: string,
    private readonly buildId: string,
    private readonly markerTtlMs = 0,
  ) {}

  /** Record `tag`'s revalidation at `now`. See {@link markerUpdate}. */
  async write(
    tag: string,
    now: number,
    durations: RevalidateDurations | undefined,
  ): Promise<void> {
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: {
          pk: { S: this.buildId },
          sk: { S: tag },
        },
        ...markerUpdate(now, durations),
      }),
    );
    // After the write, not before: a check between the two would cache the
    // marker as it was.
    this.cached.delete(tag);
  }

  /**
   * The marker rows for `tags` that exist, by tag, in one `BatchGetItem` per
   * {@link BATCH_GET_MAX_KEYS} tags rather than a `GetItem` each: a page
   * carries its whole implicit `_N_T_/…` chain plus the app's own tags, a
   * page with a few fetches checks each of them too, and every one is on the
   * request path. A tag with no row is absent from the result.
   *
   * A marker read within the last `markerTtlMs` is answered from this
   * instance's memory, a read still in flight is joined, and the rest are read
   * together. `write` drops the marker it writes, so the instance that
   * revalidated a tag sees it at once.
   */
  async read(tags: string[]): Promise<Map<string, TagMarker>> {
    const unique = Array.from(new Set(tags));
    const ttl = this.markerTtlMs;
    if (ttl <= 0) {
      return this.fetch(unique);
    }

    const now = Date.now();
    if (this.cached.size > TAG_MARKER_CACHE_SWEEP_SIZE) {
      for (const [tag, entry] of this.cached) {
        if (entry.expiresAt <= now) {
          this.cached.delete(tag);
        }
      }
    }
    const missing = unique.filter(
      (tag) => !((this.cached.get(tag)?.expiresAt ?? 0) > now),
    );
    if (missing.length > 0) {
      const read = this.fetch(missing);
      // Measured from when the read was sent, so a slow read is trusted no
      // longer than a fast one.
      const expiresAt = now + ttl;
      for (const tag of missing) {
        const marker = read.then((markers) => markers.get(tag));
        this.cached.set(tag, { expiresAt, marker });
        // A failed read is not an answer: forget it, so the next check asks
        // again. Only if it is still this read's entry, not a newer one.
        marker.catch(() => {
          if (this.cached.get(tag)?.marker === marker) {
            this.cached.delete(tag);
          }
        });
      }
    }

    const markers = new Map<string, TagMarker>();
    const entries = await Promise.all(
      unique.map(
        async (tag) => [tag, await this.cached.get(tag)!.marker] as const,
      ),
    );
    for (const [tag, marker] of entries) {
      if (marker) {
        markers.set(tag, marker);
      }
    }
    return markers;
  }

  /** {@link read}, straight from DynamoDB. */
  private async fetch(unique: string[]): Promise<Map<string, TagMarker>> {
    const { tableName, buildId } = this;
    const markers = new Map<string, TagMarker>();

    for (let i = 0; i < unique.length; i += BATCH_GET_MAX_KEYS) {
      let keys: Record<string, AttributeValue>[] | undefined = unique
        .slice(i, i + BATCH_GET_MAX_KEYS)
        .map((tag) => ({ pk: { S: buildId }, sk: { S: tag } }));
      // `UnprocessedKeys` is DynamoDB declining part of the batch under load;
      // a marker left unread is a revalidation missed, so it is asked again.
      for (let attempt = 0; keys?.length && attempt < 3; attempt++) {
        const response: BatchGetItemCommandOutput = await this.client.send(
          new BatchGetItemCommand({
            RequestItems: {
              [tableName]: {
                Keys: keys,
                ProjectionExpression: "sk, revalidatedAt, staleAt, expiredAt",
              },
            },
          }),
        );
        for (const item of response.Responses?.[tableName] ?? []) {
          const tag = item.sk?.S;
          if (tag !== undefined) {
            markers.set(tag, {
              revalidatedAt: numberAttribute(item.revalidatedAt),
              staleAt: numberAttribute(item.staleAt),
              expiredAt: numberAttribute(item.expiredAt),
            });
          }
        }
        keys = response.UnprocessedKeys?.[tableName]?.Keys;
      }
      if (keys?.length) {
        throw new Error(
          `DynamoDB left ${keys.length} tag markers unread after retrying`,
        );
      }
    }
    return markers;
  }
}

/** An object read back from the cache bucket. */
export interface CacheObject {
  body: string;
  contentType: string | undefined;
}

/**
 * The cache bucket, as the handlers use it: whole objects read and written as
 * UTF-8 text under the keys above.
 */
export class CacheBucket {
  constructor(
    private readonly client: S3Client,
    readonly bucketName: string,
  ) {}

  /**
   * The object at `key`, or `undefined` when there is none (`NoSuchKey`, or an
   * empty response body). Any other error is thrown: the handlers disagree on
   * whether one is worth logging.
   */
  async get(key: string): Promise<CacheObject | undefined> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
      if (!response.Body) {
        return undefined;
      }
      return {
        body: await response.Body.transformToString("utf-8"),
        contentType: response.ContentType,
      };
    } catch (error) {
      if (error instanceof NoSuchKey) {
        return undefined;
      }
      throw error;
    }
  }

  /** Write `body` as a JSON object at `key`. */
  async putJson(key: string, body: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: body,
        ContentType: "application/json; charset=utf-8",
      }),
    );
  }
}

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
  PutItemCommand,
  QueryCommand,
  QueryCommandOutput,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { cacheKeyFileName, cacheObjectName, sha256Hex } from "./cache-utils";

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

/** The configuration from the environment. */
export function resolveAwsCacheConfig(): AwsCacheConfig {
  return {
    bucketName: process.env.CDK_NEXTJS_CACHE_BUCKET_NAME || "",
    tableName: process.env.CDK_NEXTJS_REVALIDATION_TABLE_NAME || "",
    region: process.env.AWS_REGION || "us-east-1",
    buildId: process.env.CDK_NEXTJS_BUILD_ID || "",
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
  return join(buildId, cacheKeyFileName(cacheKey));
}

/** `{buildId}/` + {@link cacheObjectName}: the S3 object an entry is stored in. */
export function s3ObjectKey(buildId: string, cacheKey: string): string {
  return join(buildId, cacheObjectName(cacheKey));
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
 * impossible rather than unlikely: every object {@link s3ObjectKey} names ends
 * in `.json` or `.long`, including one for a route that happens to be named
 * `/_use-cache/…`.
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
 * The clock every tag marker is stamped with, and every entry timestamp it is
 * compared against: the one Next.js stamps `CacheEntry.timestamp` with
 * (`performance.timeOrigin + performance.now()`, in `use-cache-wrapper.js` and
 * the default handler), rather than `Date.now()`. Both handlers write the same
 * marker rows, so both have to use it: two clocks on one row let the last writer
 * decide which clock the others compare against, and they drift apart for as
 * long as a Lambda sandbox or Fargate task lives.
 */
export function markerClock(): number {
  return performance.timeOrigin + performance.now();
}

/**
 * The marker fields a tag revalidated at `now` sets.
 *
 * Without `durations` - `updateTag`, or `revalidateTag` with no profile - the
 * tag's entries expire immediately (`revalidatedAt`). With them the entries go
 * stale now and expire after the profile's `expire`, the same pair of
 * timestamps Next.js's `FileSystemCache.revalidateTag` records. A profile with
 * no `expire` sets only `staleAt`, and whatever `expiredAt` the tag had stays.
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

const MARKER_FIELDS = ["revalidatedAt", "staleAt", "expiredAt"] as const;

/**
 * `existing` with the fields `update` sets, as a {@link markerUpdate} leaves
 * the row: a field `update` does not set keeps its value.
 */
export function applyMarker(
  existing: TagMarker | undefined,
  update: TagMarker,
): TagMarker {
  const marker = { ...existing };
  for (const field of MARKER_FIELDS) {
    if (update[field] !== undefined) {
      marker[field] = update[field];
    }
  }
  return marker;
}

/** The marker-row update that sets {@link markerFor}'s fields. */
export function markerUpdate(
  now: number,
  durations: RevalidateDurations | undefined,
): Pick<
  ConstructorParameters<typeof UpdateItemCommand>[0],
  "UpdateExpression" | "ExpressionAttributeValues"
> {
  const marker = markerFor(now, durations);
  const fields = MARKER_FIELDS.filter((field) => marker[field] !== undefined);
  return {
    UpdateExpression: `SET ${fields.map((field) => `${field} = :${field}`).join(", ")}`,
    ExpressionAttributeValues: Object.fromEntries(
      fields.map((field) => [`:${field}`, { N: String(marker[field]) }]),
    ),
  };
}

/** A DynamoDB number attribute as a number, or `undefined` when absent. */
function numberAttribute(
  value: AttributeValue | undefined,
): number | undefined {
  return value?.N === undefined ? undefined : Number(value.N);
}

/** The marker fields of a marker or log row. */
function markerOf(item: Record<string, AttributeValue>): TagMarker {
  return {
    revalidatedAt: numberAttribute(item.revalidatedAt),
    staleAt: numberAttribute(item.staleAt),
    expiredAt: numberAttribute(item.expiredAt),
  };
}

/** DynamoDB's cap on keys in one `BatchGetItem`. */
export const BATCH_GET_MAX_KEYS = 100;

/**
 * How often, at most, an instance catches up on revalidations other instances
 * ran, unless `CDK_NEXTJS_TAG_REFRESH_MS` says otherwise: the staleness window
 * for a `revalidateTag` run elsewhere. Every cache hit checks its tags'
 * markers, and every marker of a deployment shares one partition key, so
 * reading them per request capped a route's cache hits at the partition's read
 * throughput (~1,900 req/s on NextjsRegionalFunctions). Once a second, from the
 * revalidation log, the reads scale with instances instead of requests or tags.
 */
export const DEFAULT_TAG_REFRESH_MS = 1000;

/**
 * How far past `refreshIntervalMs` the last refresh may have settled before a
 * `'use cache'` request waits for the next one (see
 * {@link TrackedTagMarkers.behind}). An instance serving steady traffic stays
 * inside it; one that sat idle, or frozen between Lambda invocations, does not.
 */
export const TAG_REFRESH_GRACE_MS = 1000;

/** DynamoDB's limit on a sort key, in UTF-8 bytes. */
export const MAX_SORT_KEY_BYTES = 1024;

/**
 * `#<sha256(tag)>`, standing in for a tag in a sort key it would push past
 * {@link MAX_SORT_KEY_BYTES}. Next.js caps the tags an app names, but not an
 * implicit `_N_T_/…` tag, which is as long as its path, and a rejected write
 * left `revalidatePath` on a long path recorded nowhere.
 */
export function hashedTag(tag: string): string {
  return `#${sha256Hex(tag)}`;
}

/**
 * The longest tag a sort key spells out; past it, {@link sortKeyTag} hashes
 * it. One cap for every row the tag is in, so a row's writer and reader agree
 * without each working out what else shares its key. It leaves room for the
 * most any row puts beside the tag: a mapping row's `#<buildId>/#<sha256>`,
 * with the build ID capped at `MAX_BUILD_ID_BYTES`.
 */
export const MAX_TAG_BYTES = 768;

/** `tag` as a sort key spells it: itself, or {@link hashedTag} past {@link MAX_TAG_BYTES}. */
export function sortKeyTag(tag: string): string {
  return Buffer.byteLength(tag) <= MAX_TAG_BYTES ? tag : hashedTag(tag);
}

/**
 * The bare-tag marker rows of the revalidation table (`pk = buildId`,
 * `sk = tag`, or {@link hashedTag} past {@link MAX_TAG_BYTES}), which record when a tag
 * was last revalidated and how.
 *
 * The table also holds the incremental cache's `tag#s3Key` mapping rows, which
 * are its own business and stay in `S3CacheHandler`: only the markers mean the
 * same thing to every handler. What an instance keeps of them between reads is
 * {@link TrackedTagMarkers}.
 */
export class TagMarkerTable {
  constructor(
    private readonly client: DynamoDBClient,
    private readonly tableName: string,
    private readonly buildId: string,
  ) {}

  /**
   * Record `tag`'s revalidation at `now`. See {@link markerUpdate}.
   *
   * Returns the row as this write left it, so the instance that wrote it can
   * track it rather than read it back: reads are eventually consistent, and a
   * read-back racing replication could return the marker from before the write.
   */
  async write(
    tag: string,
    now: number,
    durations: RevalidateDurations | undefined,
  ): Promise<TagMarker | undefined> {
    const response = await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: {
          pk: { S: this.buildId },
          sk: { S: sortKeyTag(tag) },
        },
        ...markerUpdate(now, durations),
        ReturnValues: "ALL_NEW",
      }),
    );
    return response?.Attributes ? markerOf(response.Attributes) : undefined;
  }

  /**
   * The marker rows for `tags` that exist, by tag, in one `BatchGetItem` per
   * {@link BATCH_GET_MAX_KEYS} tags rather than a `GetItem` each: a page
   * carries its whole implicit `_N_T_/…` chain plus the app's own tags, a
   * page with a few fetches checks each of them too, and every one is on the
   * request path. A tag with no row is absent from the result.
   */
  async read(tags: string[]): Promise<Map<string, TagMarker>> {
    const { tableName, buildId } = this;
    const unique = Array.from(new Set(tags));
    const markers = new Map<string, TagMarker>();

    for (let i = 0; i < unique.length; i += BATCH_GET_MAX_KEYS) {
      // A hashed sort key names no tag, so each row is matched back by key.
      const tagBySk = new Map(
        unique
          .slice(i, i + BATCH_GET_MAX_KEYS)
          .map((tag) => [sortKeyTag(tag), tag]),
      );
      let keys: Record<string, AttributeValue>[] | undefined = Array.from(
        tagBySk.keys(),
        (sk) => ({ pk: { S: buildId }, sk: { S: sk } }),
      );
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
          const tag = tagBySk.get(item.sk?.S ?? "");
          if (tag !== undefined) {
            markers.set(tag, markerOf(item));
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

/**
 * How long a revalidation log row is kept (`ttl`, epoch seconds). DynamoDB never
 * deletes an item before its TTL, only some time after, so a reader that last
 * queried less than this long ago (less a margin for writers' clocks) is sure
 * to find every row it has not seen yet.
 */
export const REVALIDATION_LOG_TTL_MS = 15 * 60 * 1000;

/** The most `Query` pages one {@link RevalidationLog.query} reads. */
export const REVALIDATION_LOG_MAX_PAGES = 5;

/** How many sort keys {@link RevalidationLog.put} tries before giving up. */
const LOG_PUT_ATTEMPTS = 5;

/** Digits a log row's timestamp is zero-padded to, so sort keys sort by time. */
const LOG_SK_DIGITS = 15;

/** A revalidation read back from the log. */
export interface RevalidationLogRow {
  /** The row's sort key: unique per revalidation of a tag. */
  sk: string;
  /** When it was written, on the writer's `Date.now()`. */
  at: number;
  tag: string;
  /** The marker fields the revalidation set, as {@link markerFor} returns them. */
  marker: TagMarker;
}

/**
 * The revalidation log: one row per tag revalidation (`pk = <buildId>#log`,
 * `sk = <Date.now(), zero-padded>#<tag>`), which expires after
 * {@link REVALIDATION_LOG_TTL_MS}. A tag past {@link MAX_TAG_BYTES} is
 * {@link hashedTag} there, and spelled out in the row's `longTag` instead.
 *
 * The marker rows stay the source of truth. The log exists so an instance
 * can ask "what was revalidated since I last looked?" in one `Query`, instead
 * of re-reading every tag it tracks to find out that almost none changed. Every
 * marker row of a deployment shares one partition, and those re-reads from a
 * handful of busy instances were enough to throttle it.
 *
 * The sort key's timestamp is the writer's wall clock (`Date.now()`), not the
 * performance clock ({@link markerClock}) the marker values are stamped with by both
 * handlers: it only orders rows for readers' cursors, which are on their own
 * wall clocks, and is never compared with an entry's timestamp.
 */
export class RevalidationLog {
  private readonly pk: string;

  constructor(
    private readonly client: DynamoDBClient,
    private readonly tableName: string,
    buildId: string,
  ) {
    this.pk = `${buildId}#log`;
  }

  /**
   * Record that `tag` was revalidated at `at` (`Date.now()`), setting `marker`.
   *
   * Two revalidations of `tag` in the same millisecond would share a sort key,
   * and the second would overwrite the first. So the row is only written where
   * its key is free, and on a collision it moves to the next millisecond, up
   * to {@link LOG_PUT_ATTEMPTS} times.
   */
  async put(tag: string, at: number, marker: TagMarker): Promise<void> {
    const skTag = sortKeyTag(tag);
    for (let attempt = 1; ; attempt++) {
      const item: Record<string, AttributeValue> = {
        pk: { S: this.pk },
        sk: { S: `${logSkPrefix(at)}#${skTag}` },
        ttl: { N: String(Math.ceil((at + REVALIDATION_LOG_TTL_MS) / 1000)) },
        ...(skTag !== tag && { longTag: { S: tag } }),
      };
      for (const field of MARKER_FIELDS) {
        const value = marker[field];
        if (value !== undefined) {
          item[field] = { N: String(value) };
        }
      }
      try {
        await this.client.send(
          new PutItemCommand({
            TableName: this.tableName,
            Item: item,
            ConditionExpression: "attribute_not_exists(sk)",
          }),
        );
        return;
      } catch (error) {
        if (
          (error as Error | undefined)?.name !==
            "ConditionalCheckFailedException" ||
          attempt >= LOG_PUT_ATTEMPTS
        ) {
          throw error;
        }
        at = Math.floor(at) + 1;
      }
    }
  }

  /**
   * The rows written at or after `since` (`Date.now()`), oldest first.
   * `truncated` when there were more than {@link REVALIDATION_LOG_MAX_PAGES}
   * pages of them, and `rows` is only the start.
   *
   * Eventually consistent: a row written a moment ago may not show yet, which
   * is what the reader's lookback is for.
   */
  async query(
    since: number,
  ): Promise<{ rows: RevalidationLogRow[]; truncated: boolean }> {
    const rows: RevalidationLogRow[] = [];
    let startKey: Record<string, AttributeValue> | undefined;
    for (let page = 0; page < REVALIDATION_LOG_MAX_PAGES; page++) {
      const response: QueryCommandOutput = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND sk >= :since",
          ExpressionAttributeValues: {
            ":pk": { S: this.pk },
            ":since": { S: logSkPrefix(Math.max(0, since)) },
          },
          ProjectionExpression:
            "sk, longTag, revalidatedAt, staleAt, expiredAt",
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of response.Items ?? []) {
        const sk = item.sk?.S;
        // `<digits>#<tag>`: the tag is everything after the fixed-width
        // timestamp, `#`s included.
        if (sk === undefined || sk[LOG_SK_DIGITS] !== "#") {
          continue;
        }
        rows.push({
          sk,
          at: Number(sk.slice(0, LOG_SK_DIGITS)),
          tag: item.longTag?.S ?? sk.slice(LOG_SK_DIGITS + 1),
          marker: markerOf(item),
        });
      }
      startKey = response.LastEvaluatedKey;
      if (!startKey) {
        return { rows, truncated: false };
      }
    }
    return { rows, truncated: true };
  }
}

function logSkPrefix(at: number): string {
  return String(Math.floor(at)).padStart(LOG_SK_DIGITS, "0");
}

/**
 * How far behind the last query's start the next one starts reading the log:
 * the room for the `Query` being eventually consistent and for writers' clocks
 * running behind the reader's. Rows inside it are read again, and dropped as
 * already applied.
 */
export const REVALIDATION_LOG_LOOKBACK_MS = 5000;

/**
 * The longest {@link TrackedTagMarkers} trusts the log alone for a tag before
 * reading its marker row again. The log is the fast path, but the marker rows
 * are the source of truth: a log row whose write failed would otherwise be
 * missed for as long as the tag stays tracked.
 *
 * Rolling, not all at once: each refresh re-reads at most
 * {@link BATCH_GET_MAX_KEYS} of the tags due, oldest first. Re-reading them all
 * together cost ~500 RCU at 1000 tags - a fleet started by one load test did it
 * in the same minute, 12,800 RCU, and throttled - and would be ~5,000 RCU at
 * {@link DEFAULT_MAX_TRACKED_TAGS}, past what the one partition serves in a
 * second. Spread out, 10,000 tracked tags cost ~8 RCU a second per instance.
 *
 * Each tag is due at a random 75-100% of this after it was last read, so tags
 * first read together - an instance warming up - do not all come due together
 * again every interval: the load test that measured the rolling re-read saw
 * its warm-up's reads return as a 30-36 RCU/s bump ten minutes later.
 */
export const DEFAULT_TAG_RESYNC_MS = 10 * 60 * 1000;

/** The fraction of {@link DEFAULT_TAG_RESYNC_MS} a tag may come due early by. */
const TAG_RESYNC_JITTER = 0.25;

/**
 * How long since the last successful log query the log can still be trusted to
 * hold every row not read yet: its TTL less a margin for writers' clocks. Past
 * it - a Lambda frozen between invocations, a run of failed queries - the
 * tracked markers are forgotten, to be read again as they are needed, and the
 * log is followed from there.
 */
export const MAX_REVALIDATION_LOG_GAP_MS =
  REVALIDATION_LOG_TTL_MS - 5 * 60 * 1000;

/**
 * The most tags one instance tracks. Past it the least recently used is
 * forgotten, which costs a read the next time it is needed: an untracked tag
 * is read before it is trusted.
 *
 * A tracked tag costs memory (~2 MB at this bound) and its share of the rolling
 * re-read, not a read every refresh, so the bound is set by how many tags an
 * instance really uses. Every path is a tag of its own (`_N_T_/<path>`), and at
 * 1000 an app of 1000 tagged pages kept evicting what it was about to need:
 * half its requests re-read a marker.
 */
export const DEFAULT_MAX_TRACKED_TAGS = 10_000;

/**
 * The revalidation table's marker rows and its log, which are only ever used
 * together, or neither for tags local to this process.
 */
export type TagTable =
  | { markers: TagMarkerTable; log: RevalidationLog }
  | { markers?: undefined; log?: undefined };

/** How {@link TrackedTagMarkers} is built. */
export type TrackedTagMarkersOptions = TagTable & {
  /**
   * How often, at most, {@link TrackedTagMarkers.refresh} reads anything.
   * @default DEFAULT_TAG_REFRESH_MS
   */
  refreshIntervalMs?: number;
  maxTrackedTags?: number;
  /** @see DEFAULT_TAG_RESYNC_MS */
  resyncIntervalMs?: number;
  /** The wall clock the log's cursor and the intervals are kept on. */
  clock?: () => number;
  /** `Math.random`, for when each tag's re-read comes due. */
  random?: () => number;
  debug?: (message: string) => void;
  /**
   * Whether the process can be frozen with a refresh in flight, as a Lambda
   * sandbox is between invocations: then a timer checks it kept running, and
   * one that spanned a freeze does not count. A container is never frozen,
   * so it skips the timer and waits for the refresh in flight, however slow.
   * @default false
   */
  canFreeze?: boolean;
};

/**
 * One instance's copy of the marker rows of the tags it has needed, kept
 * current through the {@link RevalidationLog}: the process's one tag manifest
 * (`sharedTagManifest`), for the `'use cache'` handlers and the incremental
 * cache alike.
 *
 * Next.js's built-in `'use cache'` handler keeps tags in a module-level map
 * (`tags-manifest.external.js`) that only its own `updateTags` writes, and its
 * `refreshTags` is a no-op, so a `revalidateTag` on one instance never reaches
 * the others: they keep serving the revalidated entry, including inside pages
 * that are being re-rendered *because* of that revalidation. The
 * `cacheHandlers` interface's answer is `refreshTags`, "called before starting
 * a new request … to refresh the local tags manifest", and this is that
 * manifest, backed by the same marker rows the incremental cache's
 * `revalidateTag` writes (`pk = buildId`, `sk = tag`).
 *
 * The cost is bounded per instance, not per request:
 * - {@link ensure} reads a tag's marker the first time it is needed and not
 *   again until it is evicted, so a tag costs one read per instance, not one
 *   per request. An entry created since {@link completeSince} needs no read
 *   at all.
 * - {@link refresh}, at most once per `refreshIntervalMs`, sends one `Query`
 *   for the log rows written since the last one, and applies those of tags
 *   this instance tracks. Concurrent callers share it. Alongside, it re-reads
 *   the markers of up to {@link BATCH_GET_MAX_KEYS} tags not read for
 *   {@link DEFAULT_TAG_RESYNC_MS}, in one `BatchGetItem`.
 * A revalidation on another instance is therefore seen within
 * `refreshIntervalMs` (plus the query itself) - by `'use cache'`, from the
 * first request after the query returns, since its `refreshTags` does not wait
 * for it (see `tagMethods`) unless the instance is {@link behind}, which the
 * runtime settles before a page render starts ({@link catchUp}). The instance
 * that ran it applies it itself, at once, with {@link set}.
 */
export class TrackedTagMarkers {
  private readonly markers: TagMarkerTable | undefined;
  private readonly log: RevalidationLog | undefined;
  private readonly refreshIntervalMs: number;
  private readonly maxTrackedTags: number;
  private readonly resyncIntervalMs: number;
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly debug: (message: string) => void;
  /** By tag, least recently used first. */
  private readonly tags = new Map<string, TagMarker>();
  /**
   * When each tracked tag's marker is due to be read again: a random 75-100%
   * of `resyncIntervalMs` after it was last known from the table - read,
   * written here, or new. In the order they became known, least recent first.
   */
  private readonly dueAt = new Map<string, number>();
  private readonly reading = new Map<string, Promise<void>>();
  /**
   * Log rows for tags whose first read is in flight, merged by tag: the read
   * may have been answered before the revalidation, so they are applied to its
   * result rather than dropped.
   */
  private readonly pendingRows = new Map<string, TagMarker>();
  /**
   * Log rows for tags not tracked and not being read, merged by tag, oldest
   * first: what the log has said about them since {@link completeSince}. Taken
   * into a tag's marker when it is read or written.
   */
  private readonly logOnly = new Map<string, TagMarker>();
  /** See {@link completeSince}. */
  private floor: number;
  /**
   * The future `expiredAt`s of markers dropped since, as `[from, to]`, in
   * order: once `from` is past, {@link completeSince} moves to `to`, and not
   * before, since only then does it expire anything. `from` and `to` are the
   * same until spans are merged for space ({@link laterFloor}).
   */
  private readonly laterFloors: [number, number][] = [];
  /** The in-memory entry stores judged by {@link completeSince}. */
  private readonly entryStores: {
    oldestTimestamp: () => number;
    holdsAny: () => boolean;
  }[] = [];
  /** Tracked tags whose read failed, for the next refresh to read again. */
  private readonly unread = new Set<string>();
  private lastRefresh = -Infinity;
  /**
   * The refresh in flight. One left open across a freeze comes back after the
   * thaw with what it read before, so {@link refresh} waits for it and then
   * for a fresh one, rather than the runtime waiting for it before the freeze:
   * that would bill every Lambda invocation for the query's tail.
   */
  private refreshing: Promise<void> | undefined;
  /**
   * When {@link refreshing} last showed the process running: a timer ticks
   * while it is in flight, and a tick that comes late, or none at all, means
   * the process was paused - frozen - since it started.
   */
  private lastTick = -Infinity;
  /** Whether a tick came late since {@link refreshing} started. */
  private pausedWhileRefreshing = false;
  private ticker: ReturnType<typeof setInterval> | undefined;
  /** When {@link refreshing} started. */
  private refreshStartedAt = -Infinity;
  private readonly canFreeze: boolean;
  /**
   * When the last refresh settled, either way, unless it spanned a pause: what
   * it knows is from then. See {@link behind}.
   */
  private settledAt: number;
  /**
   * Where the next log query starts (`clock()`): the last successful one's
   * start, less {@link REVALIDATION_LOG_LOOKBACK_MS}.
   */
  private cursor: number;
  /** When the last successful log query started, or the log was first read. */
  private lastLogRead: number;
  /** Log rows at or after the cursor already applied, by sort key. */
  private readonly applied = new Map<string, number>();
  /** {@link update}s of the current turn, by their arguments. */
  private readonly updating = new Map<string, Promise<boolean>>();

  constructor(options: TrackedTagMarkersOptions) {
    this.markers = options.markers;
    this.log = options.log;
    this.refreshIntervalMs =
      options.refreshIntervalMs ?? DEFAULT_TAG_REFRESH_MS;
    this.maxTrackedTags = options.maxTrackedTags ?? DEFAULT_MAX_TRACKED_TAGS;
    this.resyncIntervalMs = options.resyncIntervalMs ?? DEFAULT_TAG_RESYNC_MS;
    // Looked up on each call rather than bound here, so a test's `Date.now`
    // spy applies.
    this.clock = options.clock ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.debug = options.debug ?? (() => {});
    this.canFreeze = options.canFreeze ?? false;
    // Nothing is tracked yet, so nothing before this can be missed: every tag
    // is read from its marker the first time it is needed.
    const at = this.clock();
    this.cursor = at - REVALIDATION_LOG_LOOKBACK_MS;
    this.lastLogRead = at;
    this.settledAt = at;
    this.floor = markerClock();
  }

  /** `tag`'s marker as this instance knows it, if it tracks `tag`. */
  get(tag: string): TagMarker | undefined {
    return this.tags.get(tag);
  }

  /**
   * Since when (`markerClock()`) this instance knows of every revalidation of
   * every tag, tracked or not: tracked ones from their markers and the log,
   * the others from the log alone (`logOnly`). So an entry created at or after
   * it can be judged by {@link state} and {@link expiration} without
   * {@link ensure} reading anything - which matters inside a `'use cache'`
   * lookup, where Next.js waits for the answer and a read pushes the entry out
   * of the static stage of a staged render.
   *
   * Starts at construction: the log is followed from before it. Moves to now
   * when the tracked markers are forgotten, and past the revalidations of
   * whatever else it lets go of - a marker evicted for space, a log row
   * pruned - which are no longer known: to its `expiredAt` only once that is
   * past, since a profile's `expire` can be a year out, and moving there at
   * once would turn the read-free path off for the instance's life.
   *
   * A row is pruned only once it is no later than every entry held, so that
   * costs those entries nothing. An entry stored afterwards with an older
   * `timestamp` - Next.js stamps the start of its generation, which can
   * outlast a lookback - is older than this too, and is read first.
   *
   * It does not cover a revalidation older than the log's first lookback
   * whose `expiredAt` is still to come, which would expire an entry created
   * after it. So the `'use cache'` handler reads an entry's tags in the
   * background as it stores it.
   */
  get completeSince(): number {
    const at = markerClock();
    while (this.laterFloors.length > 0 && this.laterFloors[0][0] <= at) {
      this.floor = Math.max(this.floor, this.laterFloors.shift()![1]);
    }
    return this.floor;
  }

  /**
   * Register an in-memory store whose entries are judged by
   * {@link completeSince}, by the `timestamp` of the oldest entry it holds:
   * `logOnly` keeps the rows that could still apply to one of them, and no
   * others. With none registered it keeps nothing.
   */
  judgeEntriesOf(
    oldestTimestamp: () => number,
    holdsAny: () => boolean = () => oldestTimestamp() < Infinity,
  ): void {
    this.entryStores.push({ oldestTimestamp, holdsAny });
  }

  /**
   * Track `tag` with `marker`: what this instance just wrote, which it knows
   * without reading it back.
   */
  set(tag: string, marker: TagMarker): void {
    const logged = this.logOnly.get(tag);
    this.logOnly.delete(tag);
    this.remember(tag, mergeMarkers(marker, logged));
    this.known(tag, this.clock());
  }

  /**
   * Note a use of `tags`: those of an entry this instance just stored.
   *
   * With the table, a tag not tracked yet is left untracked, to be read by
   * {@link ensure} the first time an entry needs it. Nothing revalidated before
   * the new entry was created applies to *it*, but tracking is per tag, not per
   * entry: tracking the tag with an empty marker would also vouch for every
   * older entry that carries it - one another instance stored in S3, or one
   * this instance kept in memory across a {@link forget} - and a revalidation
   * from before the log's cursor would go unseen until the rolling re-read.
   *
   * Without the table every revalidation is this process's own, applied with
   * {@link set}, so a tag is tracked at once.
   */
  track(tags: readonly string[]): void {
    if (!this.markers) {
      this.trackUnread(tags);
      return;
    }
    for (const tag of tags) {
      this.touch(tag);
    }
  }

  /**
   * Track `tags` as they are known now, without reading them, with an empty
   * marker for any not tracked yet.
   */
  private trackUnread(tags: readonly string[]): void {
    const at = this.clock();
    for (const tag of tags) {
      if (!this.tags.has(tag)) {
        this.known(tag, at);
      }
      this.remember(tag, this.tags.get(tag) ?? {});
    }
  }

  /**
   * Read the markers of whichever of `tags` this instance does not track yet.
   * Needed before judging an entry this instance did not create, since its
   * tags may have been revalidated at any time before.
   */
  async ensure(tags: readonly string[]): Promise<void> {
    if (!this.markers) {
      this.trackUnread(tags);
      return;
    }
    const waits: Promise<void>[] = [];
    const unread: string[] = [];
    for (const tag of new Set(tags)) {
      const inFlight = this.reading.get(tag);
      if (inFlight) {
        waits.push(inFlight);
      } else if (this.tags.has(tag)) {
        this.touch(tag);
      } else {
        unread.push(tag);
      }
    }
    if (unread.length > 0) {
      // `readInto` never rejects: a failed read leaves the tags tracked.
      const read = this.readInto(unread).then(() => {
        for (const tag of unread) {
          this.reading.delete(tag);
        }
      });
      for (const tag of unread) {
        this.reading.set(tag, read);
      }
      waits.push(read);
    }
    await Promise.all(waits);
  }

  /**
   * Whether the last refresh settled more than `refreshIntervalMs` plus
   * {@link TAG_REFRESH_GRACE_MS} ago - one that spanned a freeze counts from
   * when it started: after the instance sat idle or frozen - or always, with
   * a `refreshIntervalMs` of `0`. Answering from what it knows then could
   * serve an entry revalidated elsewhere since, however long ago that was, so
   * `refreshTags` waits for the refresh, and the runtime waits for it before
   * a page render starts ({@link catchUp}).
   *
   * From when it settled, not when it started, so a slow query the runtime
   * waited for before the render does not leave the instance behind inside
   * it. A failed one counts too, so one request does not wait for two: the
   * same "assume the entry is valid" a failed read answers with, until the
   * next refresh, at most the interval and the grace later.
   */
  get behind(): boolean {
    return (
      this.log !== undefined &&
      // `0` asks before every check, so every check waits for the answer.
      (this.refreshIntervalMs === 0 || this.overdue(this.settledAt))
    );
  }

  /**
   * Whether a registered store ({@link judgeEntriesOf}) holds any entry: one
   * a refresh could expire. With none there is nothing to wait for even when
   * the instance is {@link behind}, since whatever is stored from here on is
   * newer than what the log would say - which covers the first `'use cache'`
   * call of a process, which creates the handler inside the render.
   */
  get holdsEntries(): boolean {
    return this.entryStores.some((store) => store.holdsAny());
  }

  /**
   * {@link refresh}, waited for when the instance is {@link behind}. The
   * runtime calls it before handing a page request to Next.js, outside the
   * staged render whose static stage a wait inside a `'use cache'` lookup
   * would cut short. Only for the `'use cache'` handler's entries
   * ({@link judgeEntriesOf}): the other caches wait for the refresh where they
   * read anyway. Not with a `refreshIntervalMs` of `0` either, where
   * `refreshTags` asks again regardless. Never rejects.
   */
  async catchUp(): Promise<void> {
    if (this.refreshIntervalMs > 0 && this.behind && this.holdsEntries) {
      await this.refresh().catch((error) => {
        console.error("Error refreshing cache tags:", error);
      });
    }
  }

  /** Whether `at` is more than the interval and the grace ago. */
  private overdue(at: number): boolean {
    return this.clock() - at > this.refreshIntervalMs + TAG_REFRESH_GRACE_MS;
  }

  /**
   * Catch up on revalidations other instances ran, at most once per
   * `refreshIntervalMs`. See {@link TrackedTagMarkers} for the cost.
   */
  async refresh(): Promise<void> {
    const log = this.log;
    if (!log) {
      return;
    }
    if (this.refreshing) {
      // One started before a freeze read the log as it was then, and says
      // nothing of what ran meanwhile: an instance behind waits for a fresh
      // one, after it. One that is merely slow is as fresh as any.
      if (this.behind && this.pausedSinceRefreshStarted()) {
        return this.refreshing.then(() => this.refresh());
      }
      return this.refreshing;
    }
    const at = this.clock();
    if (at - this.lastRefresh < this.refreshIntervalMs) {
      return;
    }
    this.lastRefresh = at;
    // Whatever gets tracked before the next refresh is read from its marker,
    // so there is nothing to catch up on yet - unless an entry is judged by
    // `completeSince`, which relies on the log for every tag. Even with none
    // held: a row let go of then moves `completeSince` past it, for an entry
    // whose generation started before that revalidation and that is stored
    // after it.
    if (this.tags.size === 0 && this.entryStores.length === 0) {
      return;
    }
    this.refreshStartedAt = at;
    this.startTicking();
    this.refreshing = this.sync(at, log).finally(() => {
      // One that spanned a pause knows the log as of its start at best. So
      // does one that only looked paused, its event loop held up: it counts
      // as no older than its start, as if it had not settled since.
      this.settledAt = Math.max(
        this.settledAt,
        this.pausedSinceRefreshStarted() ? this.refreshStartedAt : this.clock(),
      );
      this.stopTicking();
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private startTicking(): void {
    if (!this.canFreeze) {
      return;
    }
    this.lastTick = this.clock();
    this.pausedWhileRefreshing = false;
    this.ticker = setInterval(() => {
      const at = this.clock();
      if (at - this.lastTick > REFRESH_PAUSE_MS) {
        this.pausedWhileRefreshing = true;
      }
      this.lastTick = at;
    }, REFRESH_TICK_MS);
    // Never what keeps a process alive.
    this.ticker.unref?.();
  }

  private stopTicking(): void {
    clearInterval(this.ticker);
    this.ticker = undefined;
  }

  /**
   * Whether the process was paused since {@link refreshing} started: a tick
   * came late, or the next one is overdue (after a thaw, a request can run
   * before the timer does).
   */
  private pausedSinceRefreshStarted(): boolean {
    return (
      this.canFreeze &&
      (this.pausedWhileRefreshing ||
        this.clock() - this.lastTick > REFRESH_PAUSE_MS)
    );
  }

  /**
   * Record a revalidation of `tags`: here at once, and in the revalidation
   * table for every other instance - the marker row plus a log row per tag.
   *
   * Next.js calls `revalidateTag` on the incremental cache and `updateTags` on
   * every distinct `cacheHandlers` entry, all in one synchronous loop
   * (`revalidation-utils`), and all of them share this manifest. So an
   * identical call in the same turn joins the first instead of writing the
   * rows again. One in a later turn is a revalidation of its own, even while
   * the first one's writes are in flight, and gets its own, later, marker.
   * Never rejects: resolves `false` when a row failed to write (the error is
   * logged), so other instances may not see it.
   */
  async update(
    tags: readonly string[],
    durations: RevalidateDurations | undefined,
  ): Promise<boolean> {
    const key = JSON.stringify([tags, durations ?? null]);
    const inFlight = this.updating.get(key);
    if (inFlight) {
      return inFlight;
    }
    const update = this.write(tags, durations);
    this.updating.set(key, update);
    // Forgotten as soon as the current turn's calls have been made.
    void Promise.resolve().then(() => this.updating.delete(key));
    return update;
  }

  /**
   * What the tracked markers say about an entry carrying `tags`, created at
   * `createdAt`: the most severe answer of any of them.
   */
  state(tags: readonly string[], createdAt: number): RevalidationState {
    // `markerClock()`, not `Date.now()`, here and wherever a marker is stamped:
    // `createdAt` is on Next.js's clock, and a marker on the wall clock would be
    // compared across the two, so an entry regenerated just after a
    // revalidation could still read as older than it wherever they drift.
    const at = markerClock();
    let state: RevalidationState = "fresh";
    for (const tag of tags) {
      const marker = this.markerOf(tag);
      if (!marker) {
        continue;
      }
      const tagState = markerState(marker, createdAt, at);
      if (tagState === "expired") {
        return "expired";
      }
      if (tagState === "stale") {
        state = "stale";
      }
    }
    return state;
  }

  /**
   * `getExpiration`'s answer: the latest time any of `tags` expired, `0` if
   * none has. Only expirations already past count - a profile's future
   * `expire` is not an expiration yet - and a stale mark does not, matching
   * Next.js's default handler, which reads only `expired` for implicit tags.
   */
  expiration(tags: readonly string[]): number {
    const at = markerClock();
    let latest = 0;
    for (const tag of tags) {
      const marker = this.markerOf(tag);
      if (!marker) {
        continue;
      }
      if (marker.revalidatedAt !== undefined) {
        latest = Math.max(latest, marker.revalidatedAt);
      }
      if (marker.expiredAt !== undefined && marker.expiredAt <= at) {
        latest = Math.max(latest, marker.expiredAt);
      }
    }
    return latest;
  }

  private async write(
    tags: readonly string[],
    durations: RevalidateDurations | undefined,
  ): Promise<boolean> {
    const at = markerClock();
    const marker = markerFor(at, durations);
    for (const tag of tags) {
      this.set(tag, applyMarker(this.get(tag), marker));
    }
    const { markers, log } = this;
    if (!markers || !log) {
      return true;
    }
    const writes: [string, Promise<unknown>][] = [];
    for (const tag of new Set(tags)) {
      writes.push([
        "Error writing tag revalidation marker:",
        // The row as it is now, which carries any earlier `revalidatedAt`
        // another instance wrote: tracking only what this call set would
        // hide that one until the rolling re-read, and an entry older than it
        // would read as merely stale.
        markers.write(tag, at, durations).then((row) => {
          if (row) {
            this.set(tag, mergeMarkers(this.get(tag), row));
          }
        }),
      ]);
      writes.push([
        "Error writing tag revalidation log row:",
        this.putLogRow(log, tag, marker),
      ]);
    }
    const results = await Promise.allSettled(writes.map(([, write]) => write));
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        console.error(writes[i][0], result.reason);
      }
    });
    return results.every((result) => result.status === "fulfilled");
  }

  /**
   * Put `tag`'s log row, stamped on the wall clock (the marker values are on
   * Next.js's: see {@link RevalidationLog}).
   *
   * Readers only look {@link REVALIDATION_LOG_LOOKBACK_MS} behind their last
   * query, so a row that shows up much later than its timestamp - a slow
   * connection, retries under throttling - is behind every cursor and never
   * read. A slow put is therefore made again under a fresh timestamp, which
   * readers will see; one slow twice is reported as a failure.
   */
  private async putLogRow(
    log: RevalidationLog,
    tag: string,
    marker: TagMarker,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const at = this.clock();
      await log.put(tag, at, marker);
      if (this.clock() - at <= MAX_LOG_PUT_MS) {
        return;
      }
    }
    throw new Error(
      `The revalidation log row for ${tag} took longer than readers look back`,
    );
  }

  /**
   * One refresh started at `at`: the log rows since the cursor, and the next
   * slice of the rolling re-read.
   *
   * A failed query changes nothing but the log: the tags stay tracked as they
   * were, and the next refresh asks again from the same cursor.
   */
  private async sync(at: number, log: RevalidationLog): Promise<void> {
    if (at - this.lastLogRead > MAX_REVALIDATION_LOG_GAP_MS) {
      this.forget(
        at,
        "the revalidation log may not cover the gap since it was last read",
      );
      return;
    }
    const [result] = await Promise.all([
      log.query(this.cursor).catch((error) => {
        console.error("Error reading tag revalidation log:", error);
        return undefined;
      }),
      this.readInto(this.due(at)),
    ]);
    if (!result) {
      return;
    }
    if (result.truncated) {
      this.forget(
        at,
        "the revalidation log has more rows than one query reads",
      );
      return;
    }
    const oldest = this.oldestEntry();
    let applied = 0;
    for (const row of result.rows) {
      if (this.applied.has(row.sk)) {
        continue;
      }
      const marker = this.tags.get(row.tag);
      if (marker) {
        // `set` on a key already there keeps its place in the LRU order: being
        // revalidated elsewhere is not a use.
        this.tags.set(row.tag, mergeMarkers(marker, row.marker));
      } else if (this.reading.has(row.tag)) {
        this.pendingRows.set(
          row.tag,
          mergeMarkers(this.pendingRows.get(row.tag), row.marker),
        );
      } else {
        // A tag this instance does not track is read from its marker when it
        // is next needed - but not yet marked applied, because that read may
        // miss this very revalidation: the writer puts the log row and the
        // marker at the same time, and the read is an eventually consistent
        // `BatchGetItem` that can land milliseconds after the row showed here.
        // Marked applied, the row was skipped by every query the lookback
        // returned it to, and the pre-revalidation marker stood until the
        // rolling re-read. Left unmarked, the next refresh applies it to
        // whatever that read found; it costs no read, only the row being
        // looked at again while it is inside the lookback.
        //
        // Kept meanwhile in `logOnly`, which is all `completeSince` needs.
        this.rememberLogged(
          row.tag,
          mergeMarkers(this.logOnly.get(row.tag), row.marker),
          oldest,
        );
        continue;
      }
      this.applied.set(row.sk, row.at);
      applied++;
    }
    this.pruneLogged(oldest);
    this.lastLogRead = at;
    this.advance(at - REVALIDATION_LOG_LOOKBACK_MS);
    this.debug(
      `read ${result.rows.length} revalidation log rows (${applied} applied)`,
    );
  }

  /**
   * The tags to read on this refresh, at most one `BatchGetItem`'s worth:
   * those whose read failed, then those whose re-read has come due, in the
   * order they were last read.
   */
  private due(at: number): string[] {
    const due: string[] = [];
    for (const tag of this.unread) {
      if (due.length >= BATCH_GET_MAX_KEYS) return due;
      due.push(tag);
    }
    // Known in time order, and each due at most `jitter` earlier than the
    // tags after it: past a tag due more than that from now, none is due.
    const jitter = this.resyncIntervalMs * TAG_RESYNC_JITTER;
    for (const [tag, dueAt] of this.dueAt) {
      if (due.length >= BATCH_GET_MAX_KEYS || dueAt - jitter > at) {
        break;
      }
      if (dueAt <= at && !this.unread.has(tag)) {
        due.push(tag);
      }
    }
    return due;
  }

  /**
   * Forget every tracked marker, and follow the log from `at`: what is needed
   * next is read from its marker as it is needed, spread over the requests
   * that need it, rather than every tracked tag re-read at once.
   */
  private forget(at: number, why: string): void {
    this.debug(`forgetting ${this.tags.size} tracked tags: ${why}`);
    // What the markers expire later is still to apply once it is past.
    for (const marker of this.tags.values()) {
      this.raiseFloor(marker);
    }
    for (const marker of this.logOnly.values()) {
      this.raiseFloor(marker);
    }
    this.tags.clear();
    this.dueAt.clear();
    this.unread.clear();
    this.applied.clear();
    this.logOnly.clear();
    // Never back: a marker dropped earlier may have expired entries later.
    this.floor = Math.max(this.floor, markerClock());
    this.cursor = at - REVALIDATION_LOG_LOOKBACK_MS;
    this.lastLogRead = at;
  }

  /**
   * Move the cursor forward to `cursor`, forgetting applied rows before it:
   * no query returns them again.
   */
  private advance(cursor: number): void {
    if (cursor <= this.cursor) {
      return;
    }
    this.cursor = cursor;
    for (const [sk, at] of this.applied) {
      if (at < cursor) {
        this.applied.delete(sk);
      }
    }
  }

  /**
   * Read `tags` from the table, and report whether that worked. A read that
   * fails leaves them tracked as they were, and the next refresh reads them
   * again: the same "assume the entry is valid" the incremental cache has
   * always answered with, rather than a read on every request while DynamoDB
   * is unavailable.
   */
  private async readInto(tags: string[]): Promise<boolean> {
    if (tags.length === 0) {
      return true;
    }
    const at = this.clock();
    try {
      const read = await this.markers!.read(tags);
      for (const tag of tags) {
        this.unread.delete(tag);
        this.remember(
          tag,
          mergeMarkers(
            mergeMarkers(this.tags.get(tag), read.get(tag)),
            this.takePendingRows(tag),
          ),
        );
        this.known(tag, at);
      }
      this.debug(`read ${tags.length} tag markers (${read.size} set)`);
      return true;
    } catch (error) {
      console.error("Error reading tag markers:", error);
      this.trackUnread(tags);
      for (const tag of tags) {
        this.unread.add(tag);
        const pending = this.takePendingRows(tag);
        if (pending) {
          this.remember(tag, mergeMarkers(this.tags.get(tag), pending));
        }
      }
      return false;
    }
  }

  private takePendingRows(tag: string): TagMarker | undefined {
    const pending = this.pendingRows.get(tag);
    const logged = this.logOnly.get(tag);
    this.pendingRows.delete(tag);
    this.logOnly.delete(tag);
    return logged ? mergeMarkers(logged, pending) : pending;
  }

  /**
   * What this instance knows of `tag`: tracked, or from the log alone -
   * including rows that arrived while its first read is in flight.
   */
  private markerOf(tag: string): TagMarker | undefined {
    const tracked = this.tags.get(tag);
    if (tracked) {
      return tracked;
    }
    const logged = this.logOnly.get(tag);
    const pending = this.pendingRows.get(tag);
    return logged || pending ? mergeMarkers(logged, pending) : undefined;
  }

  /**
   * Keep `tag`'s log rows in `logOnly`, unless they cannot apply to an entry
   * held, `oldest` or newer (see {@link pruneLogged}), as bounded as the
   * tracked tags. Either way a row let go of takes what it knew with it, so
   * `completeSince` moves past it.
   */
  private rememberLogged(tag: string, marker: TagMarker, oldest: number): void {
    this.logOnly.delete(tag);
    if (knownBy(marker, markerClock()) <= oldest) {
      this.raiseFloor(marker);
      return;
    }
    this.logOnly.set(tag, marker);
    for (const [first, dropped] of this.logOnly) {
      if (this.logOnly.size <= this.maxTrackedTags) {
        break;
      }
      this.logOnly.delete(first);
      this.raiseFloor(dropped);
    }
  }

  /**
   * Drop the `logOnly` rows that cannot apply to an entry held, `oldest` or
   * newer: every revalidation they name so far is no later than it. That
   * moves `completeSince` no further than `oldest`, which costs the entries
   * held nothing, and a profile's `expiredAt` still to come waits in
   * `laterFloors`. Without this, a deployment revalidating many distinct tags
   * filled `logOnly` with tags no entry here carries, and the evictions past
   * its bound kept moving `completeSince` up to the present.
   */
  private pruneLogged(oldest: number): void {
    const at = markerClock();
    for (const [tag, marker] of this.logOnly) {
      if (knownBy(marker, at) <= oldest) {
        this.logOnly.delete(tag);
        this.raiseFloor(marker);
      }
    }
  }

  /** The oldest entry timestamp of any registered store, `Infinity` with none. */
  private oldestEntry(): number {
    let oldest = Infinity;
    for (const { oldestTimestamp } of this.entryStores) {
      oldest = Math.min(oldest, oldestTimestamp());
    }
    return oldest;
  }

  /**
   * Move `completeSince` past `marker`'s revalidations: what is no longer
   * known about a tag once its marker is dropped. A future `expiredAt` waits
   * in `laterFloors` until it is past.
   */
  private raiseFloor(marker: TagMarker): void {
    const at = markerClock();
    this.floor = Math.max(this.floor, knownBy(marker, at));
    const { expiredAt } = marker;
    if (expiredAt !== undefined && expiredAt > Math.max(at, this.floor)) {
      this.laterFloor(expiredAt);
    }
  }

  /**
   * Add `time` to `laterFloors`, in order. Past the tracked-tag bound the two
   * spans closest together are merged: from the first's start,
   * `completeSince` is the second's end, early - which only costs reads, and
   * for as short a time as any merge allows. Never later than its time, which
   * would let an entry expire unseen.
   */
  private laterFloor(time: number): void {
    const floors = this.laterFloors;
    let low = 0;
    let high = floors.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (floors[mid][0] < time) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    // Inside a merged span already: by its start, `completeSince` is past it.
    // Or already there: a log row for an untracked tag is applied again by
    // every query its lookback returns it to.
    if ((low > 0 && floors[low - 1][1] >= time) || floors[low]?.[0] === time) {
      return;
    }
    floors.splice(low, 0, [time, time]);
    // A scan, but only once past the bound. Merging the new time into a
    // neighbour instead could join an hour-out span with a year-out one, and
    // hold `completeSince` a year early.
    if (floors.length > this.maxTrackedTags) {
      let merge = 0;
      for (let i = 1; i < floors.length - 1; i++) {
        if (
          floors[i + 1][1] - floors[i][0] <
          floors[merge + 1][1] - floors[merge][0]
        ) {
          merge = i;
        }
      }
      floors.splice(merge, 2, [floors[merge][0], floors[merge + 1][1]]);
    }
  }

  /** Record that `tag`'s marker was known from the table at `at`. */
  private known(tag: string, at: number): void {
    this.dueAt.delete(tag);
    this.dueAt.set(
      tag,
      at + this.resyncIntervalMs * (1 - TAG_RESYNC_JITTER * this.random()),
    );
  }

  private remember(tag: string, marker: TagMarker): void {
    this.tags.delete(tag);
    this.tags.set(tag, marker);
    for (const oldest of this.tags.keys()) {
      if (this.tags.size <= this.maxTrackedTags) {
        break;
      }
      this.raiseFloor(this.tags.get(oldest)!);
      this.tags.delete(oldest);
      this.dueAt.delete(oldest);
      this.unread.delete(oldest);
    }
  }

  private touch(tag: string): void {
    const marker = this.tags.get(tag);
    if (marker) {
      this.remember(tag, marker);
    }
  }
}

/**
 * The latest revalidation `marker` has made known by `at`, `-Infinity` with
 * none: a future `expiredAt` is still to come.
 */
function knownBy(marker: TagMarker, at: number): number {
  const { revalidatedAt, staleAt, expiredAt } = marker;
  return Math.max(
    revalidatedAt ?? -Infinity,
    staleAt ?? -Infinity,
    expiredAt !== undefined && expiredAt <= at ? expiredAt : -Infinity,
  );
}

/**
 * The longest a log row's put may take and still be seen by every reader: half
 * the lookback, leaving the rest for writers' clocks and eventually consistent
 * queries.
 */
const MAX_LOG_PUT_MS = REVALIDATION_LOG_LOOKBACK_MS / 2;

/** How often a refresh in flight checks the process is running. */
const REFRESH_TICK_MS = 250;

/**
 * How late a tick may come before the process counts as paused (frozen)
 * since the refresh in flight started. A busy event loop can delay one too:
 * the refresh then counts as no fresher than its start, as before the pause
 * check, so a request waits for the next one once that is past the grace.
 */
const REFRESH_PAUSE_MS = 1000;

/**
 * A marker as read from the table or the log, keeping whatever this instance
 * already knows that the read does not show yet: reads are eventually
 * consistent, and a read straight after this instance's own revalidation could
 * otherwise take it back.
 */
export function mergeMarkers(
  local: TagMarker | undefined,
  remote: TagMarker | undefined,
): TagMarker {
  if (!local) {
    return remote ?? {};
  }
  if (!remote) {
    return local;
  }
  // `expiredAt` is written with `staleAt`, so it belongs to whichever is
  // newer - unless that revalidation's profile had no `expire` and left it.
  const [older, newer] =
    (local.staleAt ?? -1) > (remote.staleAt ?? -1)
      ? [remote, local]
      : [local, remote];
  return {
    ...applyMarker(older, newer),
    revalidatedAt: maxDefined(local.revalidatedAt, remote.revalidatedAt),
  };
}

function maxDefined(a: number | undefined, b: number | undefined) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * The cache bucket, as the handlers use it: whole objects read and written as
 * UTF-8 text under the keys above.
 */
export class CacheBucket {
  constructor(
    private readonly client: S3Client,
    private readonly bucketName: string,
  ) {}

  /**
   * The body of the object at `key`, or `undefined` when there is none (`NoSuchKey`, or an
   * empty response body). Any other error is thrown: the handlers disagree on
   * whether one is worth logging.
   */
  async get(key: string): Promise<string | undefined> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
      if (!response.Body) {
        return undefined;
      }
      return await response.Body.transformToString("utf-8");
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

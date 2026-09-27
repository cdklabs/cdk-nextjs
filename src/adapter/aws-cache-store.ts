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
 * How often, at most, the incremental cache catches up on revalidations other
 * instances ran, unless `CDK_NEXTJS_TAG_MARKER_TTL_MS` says otherwise. Every
 * cache hit checks its tags' markers, and every marker of a deployment shares
 * one partition key, so reading them per request capped a route's cache hits
 * at the partition's read throughput (~1,900 req/s on
 * NextjsRegionalFunctions). Once a second, from the revalidation log, the reads
 * scale with instances instead of requests or tags; the cost is that a
 * `revalidateTag` another instance ran reaches this one up to a second late.
 */
export const DEFAULT_TAG_MARKER_TTL_MS = 1000;

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
          sk: { S: tag },
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
    return this.fetch(Array.from(new Set(tags)));
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
 * {@link REVALIDATION_LOG_TTL_MS}.
 *
 * The marker rows stay the source of truth. The log exists so an instance
 * can ask "what was revalidated since I last looked?" in one `Query`, instead
 * of re-reading every tag it tracks to find out that almost none changed. Every
 * marker row of a deployment shares one partition, and those re-reads from a
 * handful of busy instances were enough to throttle it.
 *
 * The sort key's timestamp is the writer's wall clock (`Date.now()`), not the
 * performance clock the marker values are stamped with: it only orders rows for
 * readers' cursors, which are on their own wall clocks, and is never compared
 * with an entry's timestamp.
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

  /** Record that `tag` was revalidated at `at` (`Date.now()`), setting `marker`. */
  async put(tag: string, at: number, marker: TagMarker): Promise<void> {
    const item: Record<string, AttributeValue> = {
      pk: { S: this.pk },
      sk: { S: `${logSkPrefix(at)}#${tag}` },
      ttl: { N: String(Math.ceil((at + REVALIDATION_LOG_TTL_MS) / 1000)) },
    };
    for (const field of ["revalidatedAt", "staleAt", "expiredAt"] as const) {
      const value = marker[field];
      if (value !== undefined) {
        item[field] = { N: String(value) };
      }
    }
    await this.client.send(
      new PutItemCommand({ TableName: this.tableName, Item: item }),
    );
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
          ProjectionExpression: "sk, revalidatedAt, staleAt, expiredAt",
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
          tag: sk.slice(LOG_SK_DIGITS + 1),
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

/** How {@link TrackedTagMarkers} is built. */
export interface TrackedTagMarkersOptions {
  /** The revalidation table, or `undefined` for tags local to this process. */
  markers: TagMarkerTable | undefined;
  /**
   * The revalidation log in the same table. Without it, every refresh
   * re-reads every tracked tag's marker.
   */
  log?: RevalidationLog;
  /** How often, at most, {@link TrackedTagMarkers.refresh} reads anything. */
  refreshIntervalMs: number;
  maxTrackedTags?: number;
  /** @see DEFAULT_TAG_RESYNC_MS */
  resyncIntervalMs?: number;
  /** The wall clock the log's cursor and the intervals are kept on. */
  clock?: () => number;
  /** `Math.random`, for when each tag's re-read comes due. */
  random?: () => number;
  debug?: (message: string) => void;
  /** Names the markers in error logs, e.g. `'use cache' tag`. */
  label?: string;
}

/**
 * One instance's copy of the marker rows of the tags it has needed, kept
 * current through the {@link RevalidationLog}. What the `'use cache'` handlers'
 * tag manifest and the incremental cache's revalidation check both read.
 *
 * The cost is bounded per instance, not per request:
 * - {@link ensure} reads a tag's marker the first time it is needed and not
 *   again until it is evicted, so a tag costs one read per instance, not one
 *   per request.
 * - {@link refresh}, at most once per `refreshIntervalMs`, sends one `Query`
 *   for the log rows written since the last one, and applies those of tags
 *   this instance tracks. Concurrent callers share it. Alongside, it re-reads
 *   the markers of up to {@link BATCH_GET_MAX_KEYS} tags not read for
 *   {@link DEFAULT_TAG_RESYNC_MS}, in one `BatchGetItem`.
 * A revalidation on another instance is therefore seen within
 * `refreshIntervalMs` (plus the query itself). The instance that ran it applies
 * it itself, at once, with {@link set}.
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
  private readonly label: string;
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
  /** Tracked tags whose read failed, for the next refresh to read again. */
  private readonly unread = new Set<string>();
  private lastRefresh = -Infinity;
  private refreshing: Promise<void> | undefined;
  /**
   * Where the next log query starts (`clock()`): the last successful one's
   * start, less {@link REVALIDATION_LOG_LOOKBACK_MS}.
   */
  private cursor: number;
  /** When the last successful log query started, or the log was first read. */
  private lastLogRead: number;
  /** Log rows at or after the cursor already applied, by sort key. */
  private readonly applied = new Map<string, number>();

  constructor(options: TrackedTagMarkersOptions) {
    this.markers = options.markers;
    this.log = options.markers ? options.log : undefined;
    this.refreshIntervalMs = options.refreshIntervalMs;
    this.maxTrackedTags = options.maxTrackedTags ?? DEFAULT_MAX_TRACKED_TAGS;
    this.resyncIntervalMs = options.resyncIntervalMs ?? DEFAULT_TAG_RESYNC_MS;
    // Looked up on each call rather than bound here, so a test's `Date.now`
    // spy applies.
    this.clock = options.clock ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.debug = options.debug ?? (() => {});
    this.label = options.label ?? "tag";
    // Nothing is tracked yet, so nothing before this can be missed: every tag
    // is read from its marker the first time it is needed.
    const at = this.clock();
    this.cursor = at - REVALIDATION_LOG_LOOKBACK_MS;
    this.lastLogRead = at;
  }

  /** Whether markers are read from the revalidation table. */
  get isShared(): boolean {
    return this.markers !== undefined;
  }

  /** `tag`'s marker as this instance knows it, if it tracks `tag`. */
  get(tag: string): TagMarker | undefined {
    return this.tags.get(tag);
  }

  /**
   * Track `tag` with `marker`: what this instance just wrote, which it knows
   * without reading it back.
   */
  set(tag: string, marker: TagMarker): void {
    this.remember(tag, marker);
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
   * Catch up on revalidations other instances ran, at most once per
   * `refreshIntervalMs`. See {@link TrackedTagMarkers} for the cost.
   */
  async refresh(): Promise<void> {
    if (!this.markers) {
      return;
    }
    if (this.refreshing) {
      return this.refreshing;
    }
    const at = this.clock();
    if (at - this.lastRefresh < this.refreshIntervalMs) {
      return;
    }
    this.lastRefresh = at;
    // Whatever gets tracked before the next refresh is read from its marker,
    // so there is nothing to catch up on yet.
    if (this.tags.size === 0) {
      return;
    }
    this.refreshing = this.sync(at).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /**
   * One refresh started at `at`: the log rows since the cursor, and the next
   * slice of the rolling re-read.
   *
   * A failed query changes nothing but the log: the tags stay tracked as they
   * were, and the next refresh asks again from the same cursor.
   */
  private async sync(at: number): Promise<void> {
    const log = this.log;
    if (!log) {
      await this.readInto(Array.from(this.tags.keys()));
      return;
    }
    if (at - this.lastLogRead > MAX_REVALIDATION_LOG_GAP_MS) {
      this.forget(
        at,
        "the revalidation log may not cover the gap since it was last read",
      );
      return;
    }
    const [result] = await Promise.all([
      log.query(this.cursor).catch((error) => {
        console.error(`Error reading ${this.label} revalidation log:`, error);
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
    let applied = 0;
    for (const row of result.rows) {
      if (this.applied.has(row.sk)) {
        continue;
      }
      this.applied.set(row.sk, row.at);
      const marker = this.tags.get(row.tag);
      if (marker) {
        // `set` on a key already there keeps its place in the LRU order: being
        // revalidated elsewhere is not a use.
        this.tags.set(row.tag, mergeMarkers(marker, row.marker));
        applied++;
      } else if (this.reading.has(row.tag)) {
        this.pendingRows.set(
          row.tag,
          mergeMarkers(this.pendingRows.get(row.tag), row.marker),
        );
        applied++;
      }
    }
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
    this.tags.clear();
    this.dueAt.clear();
    this.unread.clear();
    this.applied.clear();
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
      console.error(`Error reading ${this.label} markers:`, error);
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
    this.pendingRows.delete(tag);
    return pending;
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
  const localStaleIsNewer = (local.staleAt ?? -1) > (remote.staleAt ?? -1);
  return {
    revalidatedAt: maxDefined(local.revalidatedAt, remote.revalidatedAt),
    staleAt: maxDefined(local.staleAt, remote.staleAt),
    // Written together with `staleAt`, so it belongs to whichever is newer.
    expiredAt: localStaleIsNewer ? local.expiredAt : remote.expiredAt,
  };
}

function maxDefined(a: number | undefined, b: number | undefined) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
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

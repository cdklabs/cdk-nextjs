/*
  What the two `cacheHandlers` (`'use cache'` and `'use cache: remote'`) share:
  the in-memory entry store, the pending-`set` bookkeeping Next.js requires of
  every handler, and the tag manifest that makes `revalidateTag` reach every
  instance through the revalidation table's marker rows.
*/
/* eslint-disable import/no-extraneous-dependencies */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import getDebug from "debug";
import type {
  CacheEntry,
  CacheHandler,
  Timestamp,
} from "next/dist/server/lib/cache-handlers/types";
import {
  markerFor,
  markerState,
  resolveAwsCacheConfig,
  RevalidateDurations,
  REVALIDATION_LOG_TTL_MS,
  RevalidationLog,
  RevalidationState,
  TagMarker,
  TagMarkerTable,
} from "./aws-cache-store";

/**
 * The clock Next.js stamps `CacheEntry.timestamp` with and compares it against
 * (`performance.timeOrigin + performance.now()`, in `use-cache-wrapper.js` and
 * the default handler), rather than `Date.now()`.
 */
export function now(): number {
  return performance.timeOrigin + performance.now();
}

/** Whether this process is `next build` rather than a deployed server. */
export function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

/** A positive integer environment variable, or `fallback`. */
export function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * A `CacheEntry` with its value read to the end: the bytes are what is kept,
 * and every `get` hands out a fresh stream over them.
 */
export interface StoredEntry extends Omit<CacheEntry, "value"> {
  value: Uint8Array;
}

/**
 * Read `stream` to the end, or throw if it errors.
 *
 * `CacheEntry.value` "can error and only have partial data" (Next.js's
 * `cache-handlers/types.d.ts`). Throwing is how a partial entry is kept out:
 * both handlers store nothing when this rejects, which is what Next.js's own
 * default handler does too.
 */
export async function readStream(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** `pendingEntry` resolved and read to the end. See {@link readStream}. */
export async function storedEntryOf(
  pendingEntry: Promise<CacheEntry>,
): Promise<StoredEntry> {
  const entry = await pendingEntry;
  return { ...entry, value: await readStream(entry.value) };
}

/** `stored` as the `CacheEntry` a `get` returns, with its own stream. */
export function cacheEntryOf(
  stored: StoredEntry,
  revalidate: number = stored.revalidate,
): CacheEntry {
  const bytes = stored.value;
  return {
    ...stored,
    revalidate,
    value: new ReadableStream<Uint8Array>({
      start(controller) {
        // A copy: whoever reads the stream may transfer or mutate the chunk.
        controller.enqueue(bytes.slice());
        controller.close();
      },
    }),
  };
}

/**
 * Whether Next.js would regenerate `entry` on every read anyway, so storing it
 * is a write nothing reads back. Next.js's default handler skips these the same
 * way, outside the dev server.
 */
export function isDynamicEntry(entry: Pick<CacheEntry, "expire">): boolean {
  return entry.expire === 0;
}

/**
 * The in-flight `set`s, by cache key. `CacheHandler.set` receives an entry that
 * may still be streaming, and "if a `get` for the same cache key is called
 * before the pending entry is complete, the cache handler must wait for the
 * `set` operation to finish" (`cache-handlers/types.d.ts`).
 */
export class PendingSets {
  private readonly pending = new Map<string, Promise<void>>();

  /** Resolves once no `set` for `key` is in flight. */
  async wait(key: string): Promise<void> {
    for (let p = this.pending.get(key); p; p = this.pending.get(key)) {
      await p;
    }
  }

  /**
   * Register a `set` for `key` and return the function that ends it. Safe to
   * call more than once: only the registration it made is removed.
   */
  begin(key: string): () => void {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((r) => (resolve = r));
    this.pending.set(key, promise);
    return () => {
      if (this.pending.get(key) === promise) {
        this.pending.delete(key);
      }
      resolve();
    };
  }
}

/**
 * Stored entries by cache key, least recently used evicted first once their
 * bytes pass `maxBytes`. Sized by bytes rather than entries, like Next.js's
 * default handler (`cacheMaxMemorySize`, 50 MB), since a `'use cache'` entry is
 * an RSC payload of any size.
 */
export class EntryLru {
  private readonly entries = new Map<string, StoredEntry>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(key: string): StoredEntry | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      // Re-inserted to mark it most recently used.
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  set(key: string, entry: StoredEntry): void {
    this.delete(key);
    const size = sizeOf(key, entry);
    if (size > this.maxBytes) {
      return;
    }
    this.entries.set(key, entry);
    this.bytes += size;
    for (const [oldestKey, oldest] of this.entries) {
      if (this.bytes <= this.maxBytes) {
        break;
      }
      this.entries.delete(oldestKey);
      this.bytes -= sizeOf(oldestKey, oldest);
    }
  }

  delete(key: string): void {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.bytes -= sizeOf(key, existing);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

function sizeOf(key: string, entry: StoredEntry): number {
  return entry.value.byteLength + key.length;
}

/** Default size of each handler's memory store: Next.js's default, 50 MB. */
export const DEFAULT_MEMORY_BYTES = 50 * 1024 * 1024;

/**
 * How often, at most, {@link UseCacheTagManifest.refresh} asks the revalidation
 * log what changed: the staleness window for a `revalidateTag` run on another
 * instance. `CDK_NEXTJS_USE_CACHE_TAG_REFRESH_MS` overrides it; `0` asks before
 * every request that uses a cache.
 */
export const DEFAULT_TAG_REFRESH_MS = 1000;

/**
 * How far behind the last query's start the next one starts reading the log:
 * the room for the `Query` being eventually consistent and for writers' clocks
 * running behind the reader's. Rows inside it are read again, and dropped as
 * already applied.
 */
export const REVALIDATION_LOG_LOOKBACK_MS = 5000;

/**
 * How long the manifest goes on the log alone before re-reading every tracked
 * tag's marker row anyway. The log is the fast path, but the marker rows are
 * the source of truth: a log row whose write failed would otherwise be missed
 * for as long as the tag stays tracked. At 1000 tracked tags this is ~500 RCU
 * once per interval, next to the ~500 RCU a second re-reading every second cost.
 */
export const DEFAULT_TAG_RESYNC_MS = 10 * 60 * 1000;

/**
 * How long since the last successful log query the log can still be trusted to
 * hold every row not read yet: its TTL less a margin for writers' clocks. Past
 * it - a Lambda frozen between invocations, a run of failed queries - the
 * manifest re-reads the tracked tags' markers instead, once, and carries on
 * from there.
 */
export const MAX_REVALIDATION_LOG_GAP_MS =
  REVALIDATION_LOG_TTL_MS - 5 * 60 * 1000;

/**
 * The most tags one instance tracks. Past it the least recently used is
 * forgotten, which costs only a read the next time it is needed: an untracked
 * tag is read before it is trusted. Bounds a full re-read at
 * `ceil(1000 / 100)` `BatchGetItem`s.
 */
export const DEFAULT_MAX_TRACKED_TAGS = 1000;

/** How {@link UseCacheTagManifest} is built. */
export interface UseCacheTagManifestOptions {
  /** The revalidation table, or `undefined` for tags local to this process. */
  markers: TagMarkerTable | undefined;
  /**
   * The revalidation log in the same table. Without it, every refresh
   * re-reads every tracked tag's marker.
   */
  log?: RevalidationLog;
  refreshIntervalMs?: number;
  maxTrackedTags?: number;
  resyncIntervalMs?: number;
  /** The wall clock the log's cursor and the intervals are kept on. */
  clock?: () => number;
}

/**
 * This instance's copy of the tag markers, for the `cacheHandlers`.
 *
 * Next.js's built-in `'use cache'` handler keeps tags in a module-level map
 * (`tags-manifest.external.js`) that only its own `updateTags` writes, and its
 * `refreshTags` is a no-op, so a `revalidateTag` on one instance never reaches
 * the others: they keep serving the revalidated entry, including inside pages
 * that are being re-rendered *because* of that revalidation. The
 * `cacheHandlers` interface's answer is `refreshTags`, "called before starting
 * a new request … to refresh the local tags manifest", and this is that manifest,
 * backed by the same marker rows the incremental cache's `revalidateTag`
 * writes (`pk = buildId`, `sk = tag`).
 *
 * The cost is bounded per instance, not per request:
 * - {@link ensure} reads a tag's marker the first time it is needed and not
 *   again until it is evicted, so an entry or a page's implicit tags cost one
 *   read per instance, not one per request.
 * - {@link refresh}, at most once per `refreshIntervalMs`, sends one `Query`
 *   for the {@link RevalidationLog} rows written since the last one, and
 *   applies those of tags this instance tracks. Concurrent requests share it.
 *   Every {@link DEFAULT_TAG_RESYNC_MS}, or after a gap the log may no longer
 *   cover, it re-reads every tracked marker instead.
 * A `revalidateTag` on another instance is therefore seen within
 * `refreshIntervalMs` (plus the query itself), and at once on the instance that
 * ran it.
 */
export class UseCacheTagManifest {
  private readonly markers: TagMarkerTable | undefined;
  private readonly log: RevalidationLog | undefined;
  private readonly refreshIntervalMs: number;
  private readonly maxTrackedTags: number;
  private readonly resyncIntervalMs: number;
  private readonly clock: () => number;
  /** By tag, least recently used first. */
  private readonly tags = new Map<string, TagMarker>();
  private readonly reading = new Map<string, Promise<void>>();
  private lastRefresh = -Infinity;
  private refreshing: Promise<void> | undefined;
  private readonly updating = new Map<string, Promise<void>>();
  /**
   * Where the next log query starts (`Date.now()`): the last successful one's
   * start, less {@link REVALIDATION_LOG_LOOKBACK_MS}.
   */
  private cursor: number;
  /** When the last successful log query, or full re-read, started. */
  private lastLogRead: number;
  /** When the last successful full re-read started. */
  private lastFullRead: number;
  /** Log rows at or after the cursor already applied, by sort key. */
  private readonly applied = new Map<string, number>();
  private readonly debug = getDebug("cdk-nextjs:cache-handler:use-cache:tags");

  constructor(options: UseCacheTagManifestOptions) {
    this.markers = options.markers;
    this.log = options.markers ? options.log : undefined;
    this.refreshIntervalMs =
      options.refreshIntervalMs ?? DEFAULT_TAG_REFRESH_MS;
    this.maxTrackedTags = options.maxTrackedTags ?? DEFAULT_MAX_TRACKED_TAGS;
    this.resyncIntervalMs = options.resyncIntervalMs ?? DEFAULT_TAG_RESYNC_MS;
    this.clock = options.clock ?? Date.now;
    // Nothing is tracked yet, so nothing before this can be missed: every tag
    // is read from its marker the first time it is needed.
    const at = this.clock();
    this.cursor = at - REVALIDATION_LOG_LOOKBACK_MS;
    this.lastLogRead = at;
    this.lastFullRead = at;
  }

  /** Whether markers are read from, and written to, the revalidation table. */
  get isShared(): boolean {
    return this.markers !== undefined;
  }

  /**
   * Start tracking `tags` without reading them: those of an entry this
   * instance just stored. Nothing revalidated before it was created can apply
   * to it, and the log carries anything after.
   */
  track(tags: readonly string[]): void {
    for (const tag of tags) {
      this.remember(tag, this.tags.get(tag) ?? {});
    }
  }

  /**
   * Read the markers of whichever of `tags` this instance does not track yet.
   * Needed before judging an entry this instance did not create - one read
   * from S3, or a page's implicit tags - since its tags may have been
   * revalidated at any time before.
   */
  async ensure(tags: readonly string[]): Promise<void> {
    if (!this.markers) {
      this.track(tags);
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
   * `refreshIntervalMs`. Next.js calls this before the first cache read of a
   * request; see {@link UseCacheTagManifest} for the cost.
   */
  async refresh(): Promise<void> {
    if (!this.markers || this.tags.size === 0) {
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
    this.refreshing = this.sync(at).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /**
   * Record a revalidation of `tags`: here at once, and in the revalidation
   * table for every other instance - the same marker `S3CacheHandler`'s
   * `revalidateTag` writes for the same call, plus a log row per tag.
   *
   * Next.js calls `updateTags` on every distinct handler, and both
   * `cacheHandlers` share this manifest, so the second identical call while
   * the first is in flight joins it instead of writing the rows again.
   */
  async update(
    tags: readonly string[],
    durations: RevalidateDurations | undefined,
  ): Promise<void> {
    const key = JSON.stringify([tags, durations ?? null]);
    const inFlight = this.updating.get(key);
    if (inFlight) {
      return inFlight;
    }
    const update = this.write(tags, durations).finally(() => {
      this.updating.delete(key);
    });
    this.updating.set(key, update);
    return update;
  }

  /**
   * What the tracked markers say about an entry carrying `tags`, created at
   * `createdAt`: the most severe answer of any of them.
   */
  state(tags: readonly string[], createdAt: Timestamp): RevalidationState {
    // `now()`, not `Date.now()`, here and wherever a marker is stamped:
    // `createdAt` is on Next.js's clock, and a marker on the wall clock would be
    // compared across the two, so an entry regenerated just after a
    // revalidation could still read as older than it wherever they drift.
    const at = now();
    let state: RevalidationState = "fresh";
    for (const tag of tags) {
      const marker = this.tags.get(tag);
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
  expiration(tags: readonly string[]): Timestamp {
    const at = now();
    let latest = 0;
    for (const tag of tags) {
      const marker = this.tags.get(tag);
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
  ): Promise<void> {
    const at = now();
    const marker = markerFor(at, durations);
    for (const tag of tags) {
      this.remember(tag, { ...this.tags.get(tag), ...marker });
    }
    if (!this.markers) {
      return;
    }
    const { markers, log } = this;
    // The log row's sort key is on the wall clock, the marker values on
    // Next.js's: see `RevalidationLog`.
    const loggedAt = this.clock();
    const writes: [string, Promise<void>][] = [];
    for (const tag of new Set(tags)) {
      writes.push([
        "Error writing 'use cache' tag revalidation marker:",
        markers.write(tag, at, durations),
      ]);
      if (log) {
        writes.push([
          "Error writing 'use cache' revalidation log row:",
          log.put(tag, loggedAt, marker),
        ]);
      }
    }
    const results = await Promise.allSettled(writes.map(([, write]) => write));
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        console.error(writes[i][0], result.reason);
      }
    });
  }

  /**
   * One refresh started at `at`: the log rows since the cursor, or every
   * tracked marker when the log alone is not enough (no log, the periodic
   * resync, a gap the log may not cover, more rows than one query reads).
   *
   * A failed query changes nothing but the log: the tags stay tracked as they
   * were, and the next refresh asks again from the same cursor.
   */
  private async sync(at: number): Promise<void> {
    const log = this.log;
    if (
      !log ||
      at - this.lastFullRead >= this.resyncIntervalMs ||
      at - this.lastLogRead > MAX_REVALIDATION_LOG_GAP_MS
    ) {
      return this.readAll(at);
    }
    let result: Awaited<ReturnType<RevalidationLog["query"]>>;
    try {
      result = await log.query(this.cursor);
    } catch (error) {
      console.error("Error reading 'use cache' revalidation log:", error);
      return;
    }
    if (result.truncated) {
      this.debug("revalidation log has more rows than one query reads");
      return this.readAll(at);
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
        this.tags.set(row.tag, merge(marker, row.marker));
        applied++;
      }
    }
    this.lastLogRead = at;
    this.advance(at - REVALIDATION_LOG_LOOKBACK_MS);
    this.debug(
      `read ${result.rows.length} revalidation log rows (${applied} applied)`,
    );
  }

  /** Re-read every tracked tag's marker, and move the log's cursor past it. */
  private async readAll(at: number): Promise<void> {
    if (await this.readInto(Array.from(this.tags.keys()))) {
      this.lastFullRead = at;
      this.lastLogRead = at;
      // A revalidation the (eventually consistent) read missed is still in the
      // log from here on.
      this.advance(at - REVALIDATION_LOG_LOOKBACK_MS);
    }
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
   * Read `tags` from the table into the manifest, and report whether that
   * worked. A read that fails leaves them as they were (tracked, so a later
   * refresh tries again): the same "assume the entry is valid" the incremental
   * cache answers with, rather than a miss on every request while DynamoDB is
   * unavailable.
   */
  private async readInto(tags: string[]): Promise<boolean> {
    if (tags.length === 0) {
      return true;
    }
    try {
      const read = await this.markers!.read(tags);
      for (const tag of tags) {
        this.remember(tag, merge(this.tags.get(tag), read.get(tag)));
      }
      this.debug(`read ${tags.length} tag markers (${read.size} set)`);
      return true;
    } catch (error) {
      console.error("Error reading 'use cache' tag markers:", error);
      this.track(tags);
      return false;
    }
  }

  private remember(tag: string, marker: TagMarker): void {
    this.tags.delete(tag);
    this.tags.set(tag, marker);
    for (const oldest of this.tags.keys()) {
      if (this.tags.size <= this.maxTrackedTags) {
        break;
      }
      this.tags.delete(oldest);
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
 * A marker as read from the table, keeping whatever this instance wrote that
 * the read does not show yet: `BatchGetItem` is eventually consistent, and a
 * read straight after this instance's own `updateTags` could otherwise take its
 * revalidation back.
 */
function merge(
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

/**
 * A handler built by `create` on first use rather than on import, so loading
 * the module - which jest, and Next.js's config validation, do without using
 * it - neither constructs AWS clients nor warns about missing configuration.
 */
export function lazyHandler(create: () => CacheHandler): CacheHandler {
  let handler: CacheHandler | undefined;
  const instance = () => (handler ??= create());
  return {
    get: (cacheKey, softTags) => instance().get(cacheKey, softTags),
    set: (cacheKey, pendingEntry) => instance().set(cacheKey, pendingEntry),
    refreshTags: () => instance().refreshTags(),
    getExpiration: (tags) => instance().getExpiration(tags),
    updateTags: (tags, durations) => instance().updateTags(tags, durations),
  };
}

const TAG_MANIFEST_SYMBOL = Symbol.for("cdk-nextjs.use-cache.tag-manifest");

/**
 * The process's one {@link UseCacheTagManifest}, from the environment.
 *
 * Kept on `globalThis` because the `default` and `remote` handlers are separate
 * bundles - separate module instances - and should share one manifest: one
 * refresh read for both, and one marker write per `revalidateTag`.
 *
 * At build time there is no table to read (and no credentials to read it
 * with), so tags stay local to the process there.
 */
export function sharedTagManifest(): UseCacheTagManifest {
  const global = globalThis as { [TAG_MANIFEST_SYMBOL]?: UseCacheTagManifest };
  if (!global[TAG_MANIFEST_SYMBOL]) {
    const config = resolveAwsCacheConfig();
    const shared = Boolean(config.tableName) && !isBuildPhase();
    const client = shared
      ? new DynamoDBClient({ region: config.region })
      : undefined;
    const markers = client
      ? new TagMarkerTable(client, config.tableName, config.buildId)
      : undefined;
    const log = client
      ? new RevalidationLog(client, config.tableName, config.buildId)
      : undefined;
    if (!markers && !isBuildPhase()) {
      console.warn(
        "CDK_NEXTJS_REVALIDATION_TABLE_NAME environment variable not set, 'use cache' tags are local to each instance",
      );
    }
    global[TAG_MANIFEST_SYMBOL] = new UseCacheTagManifest({
      markers,
      log,
      refreshIntervalMs: numberFromEnv(
        "CDK_NEXTJS_USE_CACHE_TAG_REFRESH_MS",
        DEFAULT_TAG_REFRESH_MS,
      ),
    });
  }
  return global[TAG_MANIFEST_SYMBOL];
}

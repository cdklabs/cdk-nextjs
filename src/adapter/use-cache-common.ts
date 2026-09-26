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
 * How long a tag's marker is trusted before {@link UseCacheTagManifest.refresh}
 * reads it again: the staleness window for a `revalidateTag` run on another
 * instance. `CDK_NEXTJS_USE_CACHE_TAG_REFRESH_MS` overrides it; `0` reads the
 * markers before every request that uses a cache.
 */
export const DEFAULT_TAG_REFRESH_MS = 1000;

/**
 * The most tags one instance tracks. Past it the least recently used is
 * forgotten, which costs only a read the next time it is needed: an untracked
 * tag is read before it is trusted. Bounds the refresh at
 * `ceil(1000 / 100)` `BatchGetItem`s.
 */
export const DEFAULT_MAX_TRACKED_TAGS = 1000;

/** How {@link UseCacheTagManifest} is built. */
export interface UseCacheTagManifestOptions {
  /** The revalidation table, or `undefined` for tags local to this process. */
  markers: TagMarkerTable | undefined;
  refreshIntervalMs?: number;
  maxTrackedTags?: number;
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
 * - {@link refresh} re-reads only the tags this instance tracks and has not
 *   read within `refreshIntervalMs`, at most once per `refreshIntervalMs`;
 *   concurrent requests share one read.
 * - {@link ensure} reads a tag the first time it is needed and not again until
 *   it is evicted, so an entry or a page's implicit tags cost one read per
 *   instance, not one per request.
 * A `revalidateTag` on another instance is therefore seen within
 * `refreshIntervalMs` (plus the read itself), and at once on the instance that
 * ran it.
 */
export class UseCacheTagManifest {
  private readonly markers: TagMarkerTable | undefined;
  private readonly refreshIntervalMs: number;
  private readonly maxTrackedTags: number;
  /** By tag, least recently used first. */
  private readonly tags = new Map<string, TagMarker>();
  /** When each tracked tag's marker was last read, or first tracked. */
  private readonly readAt = new Map<string, number>();
  private readonly reading = new Map<string, Promise<void>>();
  private lastRefresh = -Infinity;
  private refreshing: Promise<void> | undefined;
  private readonly updating = new Map<string, Promise<void>>();
  private readonly debug = getDebug("cdk-nextjs:cache-handler:use-cache:tags");

  constructor(options: UseCacheTagManifestOptions) {
    this.markers = options.markers;
    this.refreshIntervalMs =
      options.refreshIntervalMs ?? DEFAULT_TAG_REFRESH_MS;
    this.maxTrackedTags = options.maxTrackedTags ?? DEFAULT_MAX_TRACKED_TAGS;
  }

  /** Whether markers are read from, and written to, the revalidation table. */
  get isShared(): boolean {
    return this.markers !== undefined;
  }

  /**
   * Start tracking `tags` without reading them: those of an entry this
   * instance just stored. Nothing revalidated before it was created can apply
   * to it, and the next {@link refresh} reads them for anything after.
   */
  track(tags: readonly string[]): void {
    for (const tag of tags) {
      if (!this.readAt.has(tag)) {
        this.readAt.set(tag, Date.now());
      }
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
      const read = this.readInto(unread).finally(() => {
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
   * Re-read the tracked tags last read more than `refreshIntervalMs` ago, at
   * most once per `refreshIntervalMs`. Next.js calls this before the first
   * cache read of a request; see {@link UseCacheTagManifest} for the cost.
   */
  async refresh(): Promise<void> {
    if (!this.markers || this.tags.size === 0) {
      return;
    }
    if (this.refreshing) {
      return this.refreshing;
    }
    const at = Date.now();
    if (at - this.lastRefresh < this.refreshIntervalMs) {
      return;
    }
    this.lastRefresh = at;
    const due = Array.from(this.tags.keys()).filter(
      (tag) => at - (this.readAt.get(tag) ?? 0) >= this.refreshIntervalMs,
    );
    if (due.length === 0) {
      return;
    }
    this.refreshing = this.readInto(due).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /**
   * Record a revalidation of `tags`: here at once, and in the revalidation
   * table for every other instance - the same marker `S3CacheHandler`'s
   * `revalidateTag` writes for the same call.
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
    const at = Date.now();
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
    const at = Date.now();
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
    const at = Date.now();
    const marker = markerFor(at, durations);
    for (const tag of tags) {
      this.remember(tag, { ...this.tags.get(tag), ...marker });
    }
    if (!this.markers) {
      return;
    }
    const markers = this.markers;
    const results = await Promise.allSettled(
      Array.from(new Set(tags)).map((tag) => markers.write(tag, at, durations)),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        console.error(
          "Error writing 'use cache' tag revalidation marker:",
          result.reason,
        );
      }
    }
  }

  /**
   * Read `tags` from the table into the manifest. A read that fails leaves
   * them as they were (tracked, so the next refresh tries again): the same
   * "assume the entry is valid" the incremental cache answers with, rather
   * than a miss on every request while DynamoDB is unavailable.
   */
  private async readInto(tags: string[]): Promise<void> {
    try {
      const readAt = Date.now();
      const read = await this.markers!.read(tags);
      for (const tag of tags) {
        this.readAt.set(tag, readAt);
        this.remember(tag, merge(this.tags.get(tag), read.get(tag)));
      }
      this.debug(`read ${tags.length} tag markers (${read.size} set)`);
    } catch (error) {
      console.error("Error reading 'use cache' tag markers:", error);
      this.track(tags);
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
      this.readAt.delete(oldest);
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
    const markers =
      config.tableName && !isBuildPhase()
        ? new TagMarkerTable(
            new DynamoDBClient({ region: config.region }),
            config.tableName,
            config.buildId,
          )
        : undefined;
    if (!markers && !isBuildPhase()) {
      console.warn(
        "CDK_NEXTJS_REVALIDATION_TABLE_NAME environment variable not set, 'use cache' tags are local to each instance",
      );
    }
    global[TAG_MANIFEST_SYMBOL] = new UseCacheTagManifest({
      markers,
      refreshIntervalMs: numberFromEnv(
        "CDK_NEXTJS_USE_CACHE_TAG_REFRESH_MS",
        DEFAULT_TAG_REFRESH_MS,
      ),
    });
  }
  return global[TAG_MANIFEST_SYMBOL];
}

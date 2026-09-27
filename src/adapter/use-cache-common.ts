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
  mergeMarkers,
  resolveAwsCacheConfig,
  RevalidateDurations,
  RevalidationLog,
  RevalidationState,
  TagMarkerTable,
  TrackedTagMarkers,
  TrackedTagMarkersOptions,
  markerClock as now,
} from "./aws-cache-store";

export { markerClock as now } from "./aws-cache-store";

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

/** How {@link UseCacheTagManifest} is built. */
export interface UseCacheTagManifestOptions extends Omit<
  TrackedTagMarkersOptions,
  "refreshIntervalMs" | "debug"
> {
  refreshIntervalMs?: number;
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
 * writes (`pk = buildId`, `sk = tag`), and kept current through the
 * revalidation log: see {@link TrackedTagMarkers} for how, and for the cost.
 */
export class UseCacheTagManifest {
  private readonly markers: TagMarkerTable | undefined;
  private readonly log: RevalidationLog | undefined;
  private readonly tracked: TrackedTagMarkers;
  private readonly clock: () => number;
  private readonly updating = new Map<string, Promise<void>>();

  constructor(options: UseCacheTagManifestOptions) {
    this.markers = options.markers;
    this.log = options.markers ? options.log : undefined;
    this.clock = options.clock ?? (() => Date.now());
    this.tracked = new TrackedTagMarkers({
      ...options,
      refreshIntervalMs: options.refreshIntervalMs ?? DEFAULT_TAG_REFRESH_MS,
      debug: getDebug("cdk-nextjs:cache-handler:use-cache:tags"),
      label: "'use cache' tag",
    });
  }

  /** Whether markers are read from, and written to, the revalidation table. */
  get isShared(): boolean {
    return this.markers !== undefined;
  }

  /** @see TrackedTagMarkers.track */
  track(tags: readonly string[]): void {
    this.tracked.track(tags);
  }

  /**
   * Read the markers of whichever of `tags` this instance does not track yet:
   * needed before judging an entry this instance did not create - one read
   * from S3, or a page's implicit tags. See {@link TrackedTagMarkers.ensure}.
   */
  ensure(tags: readonly string[]): Promise<void> {
    return this.tracked.ensure(tags);
  }

  /**
   * Catch up on revalidations other instances ran, at most once per
   * `refreshIntervalMs`. Next.js calls this before the first cache read of a
   * request. See {@link TrackedTagMarkers.refresh}.
   */
  refresh(): Promise<void> {
    return this.tracked.refresh();
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
      const marker = this.tracked.get(tag);
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
      const marker = this.tracked.get(tag);
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
      this.tracked.set(tag, { ...this.tracked.get(tag), ...marker });
    }
    if (!this.markers) {
      return;
    }
    const { markers, log } = this;
    // The log row's sort key is on the wall clock, the marker values on
    // Next.js's: see `RevalidationLog`.
    const loggedAt = this.clock();
    const writes: [string, Promise<unknown>][] = [];
    for (const tag of new Set(tags)) {
      writes.push([
        "Error writing 'use cache' tag revalidation marker:",
        // The row as it is now, which carries any earlier `revalidatedAt`
        // another instance wrote: tracking only what this call set would
        // hide that one until the rolling re-read, and an entry older than it
        // would read as merely stale. What `S3CacheHandler.recordRevalidation`
        // does with the same row.
        markers.write(tag, at, durations).then((row) => {
          if (row) {
            this.tracked.set(tag, mergeMarkers(this.tracked.get(tag), row));
          }
        }),
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

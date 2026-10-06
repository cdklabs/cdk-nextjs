/*
  What the two `cacheHandlers` (`'use cache'` and `'use cache: remote'`) share:
  the in-memory entry store, the pending-`set` bookkeeping Next.js requires of
  every handler, and the process's one tag manifest (`TrackedTagMarkers`),
  which makes `revalidateTag` reach every instance through the revalidation
  table's marker rows.
*/
/* eslint-disable import/no-extraneous-dependencies */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import getDebug from "debug";
import type {
  CacheEntry,
  CacheHandler,
} from "next/dist/server/lib/cache-handlers/types";
import {
  DEFAULT_TAG_REFRESH_MS,
  resolveAwsCacheConfig,
  RevalidationLog,
  TagMarkerTable,
  TrackedTagMarkers,
} from "./aws-cache-store";
import { TAG_MANIFEST_SYMBOL } from "../runtime/tag-manifest";

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

  /**
   * The `timestamp` of the oldest entry held, `Infinity` with none. A scan:
   * asked once per revalidation log query, not per request (`size` answers
   * whether there is one).
   */
  oldestTimestamp(): number {
    let oldest = Infinity;
    for (const entry of this.entries.values()) {
      oldest = Math.min(oldest, entry.timestamp);
    }
    return oldest;
  }

  /**
   * Drop the entries past `revalidate` at `at` (`now()`): a handler that drops
   * them when next read would otherwise hold them until then, and they would
   * count towards `size` and `oldestTimestamp` meanwhile.
   */
  dropExpired(at: number): void {
    for (const [key, entry] of this.entries) {
      if (at > entry.timestamp + entry.revalidate * 1000) {
        this.delete(key);
      }
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
 * How long one revalidation table request may take, per attempt. The SDK sets
 * no limit, and a refresh left in flight across a Lambda freeze can sit on a
 * connection that died meanwhile without a reset: every request that waits
 * for the refresh (an instance `behind`, ISR) would wait with it. The SDK
 * retries a timed-out attempt, so a dead connection costs up to its attempts
 * times this.
 */
export const TAG_TABLE_REQUEST_TIMEOUT_MS = 3000;

/**
 * Wait for `work` if `wait`, or else let it run on: either way a rejection is
 * logged with `failure` rather than thrown.
 */
export async function awaitIf(
  wait: boolean,
  work: Promise<void>,
  failure: string,
): Promise<void> {
  const logged = work.catch((error) => {
    console.error(failure, error);
  });
  if (wait) {
    await logged;
  }
}

export interface TagMethodsOptions {
  /**
   * Whether `refreshTags` always waits for the revalidation log query, rather
   * than only when the instance is `behind`.
   * @default false
   */
  readonly blocking?: boolean;
}

/**
 * The `cacheHandlers` methods that only go through `tags`, the same for the
 * `default` and `remote` handlers.
 */
export function tagMethods(
  tags: TrackedTagMarkers,
  options: TagMethodsOptions = {},
): Pick<CacheHandler, "refreshTags" | "getExpiration" | "updateTags"> {
  return {
    // Started, not awaited, while the instance keeps up, unless `blocking`.
    // Next.js awaits `refreshTags` inside the first `'use cache'` lookup of a
    // request (`use-cache-wrapper`), and a staged render ends its static stage
    // on a timer: a log `Query` there pushed the entry out of the static
    // stage, so a cached navigation stored the page segment without it. What
    // the query finds applies from the next request. Awaited once the instance
    // is `behind`, which the runtime settles before a page render starts
    // (`catchUp`): the first request after an idle or frozen spell would
    // otherwise serve whatever was revalidated elsewhere meanwhile. Not even
    // then while the instance holds no entry the query could expire
    // (`holdsEntries`), with a `refreshIntervalMs` of `0` too.
    refreshTags: () =>
      awaitIf(
        options.blocking === true || (tags.behindInRender && tags.holdsEntries),
        tags.refresh(),
        "Error refreshing cache tags:",
      ),
    async getExpiration(implicitTags) {
      await tags.ensure(implicitTags);
      return tags.expiration(implicitTags);
    },
    async updateTags(revalidatedTags, durations) {
      await tags.update(revalidatedTags, durations);
    },
  };
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

/**
 * The process's one {@link TrackedTagMarkers}, from the environment.
 *
 * Kept on `globalThis` because the incremental cache handler and the `default`
 * and `remote` handlers are separate bundles - separate module instances - and
 * should share one manifest: one refresh read for all of them, and one marker
 * write per `revalidateTag`.
 *
 * At build time there is no table to read (and no credentials to read it
 * with), so tags stay local to the process there.
 */
export function sharedTagManifest(): TrackedTagMarkers {
  const global = globalThis as { [TAG_MANIFEST_SYMBOL]?: TrackedTagMarkers };
  if (!global[TAG_MANIFEST_SYMBOL]) {
    const config = resolveAwsCacheConfig();
    const refreshIntervalMs = numberFromEnv(
      "CDK_NEXTJS_TAG_REFRESH_MS",
      DEFAULT_TAG_REFRESH_MS,
    );
    if (config.tableName && !isBuildPhase()) {
      const client = new DynamoDBClient({
        region: config.region,
        // Without `throwOnRequestTimeout` the timeout only logs a warning. It
        // ends once the response headers arrive: `socketTimeout`, an
        // inactivity timer kept until the request closes, covers the body.
        requestHandler: {
          requestTimeout: TAG_TABLE_REQUEST_TIMEOUT_MS,
          throwOnRequestTimeout: true,
          socketTimeout: TAG_TABLE_REQUEST_TIMEOUT_MS,
        },
      });
      global[TAG_MANIFEST_SYMBOL] = new TrackedTagMarkers({
        markers: new TagMarkerTable(client, config.tableName, config.buildId),
        log: new RevalidationLog(client, config.tableName, config.buildId),
        refreshIntervalMs,
        debug: getDebug("cdk-nextjs:cache-handler:tags"),
        // Set in every Lambda runtime; a container is never frozen.
        canFreeze: process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined,
      });
    } else {
      if (!isBuildPhase()) {
        console.warn(
          "CDK_NEXTJS_REVALIDATION_TABLE_NAME environment variable not set, cache tags are local to each instance",
        );
      }
      global[TAG_MANIFEST_SYMBOL] = new TrackedTagMarkers({
        refreshIntervalMs,
      });
    }
  }
  return global[TAG_MANIFEST_SYMBOL];
}

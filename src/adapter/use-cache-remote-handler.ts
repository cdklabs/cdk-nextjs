/*
  The `cacheHandlers.remote` handler, for `'use cache: remote'`.
  See: https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers

  Entries are stored in the cache bucket, so every instance reads what any
  instance wrote, with a bounded in-memory tier in front. Tags go through the
  revalidation table's marker rows, shared with plain `'use cache'` and with the
  incremental cache. Without this, Next.js maps `remote` to its in-memory
  default handler, and `'use cache: remote'` is no more shared than
  `'use cache'`.
*/
/* eslint-disable import/no-extraneous-dependencies */
import { createHash } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import getDebug from "debug";
import type {
  CacheEntry,
  CacheHandler,
} from "next/dist/server/lib/cache-handlers/types";
import {
  CacheBucket,
  resolveAwsCacheConfig,
  TrackedTagMarkers,
  useCacheS3Key,
} from "./aws-cache-store";
import { parseCacheValue, serializeCacheValue } from "./cache-utils";
import {
  cacheEntryOf,
  DEFAULT_MEMORY_BYTES,
  EntryLru,
  isBuildPhase,
  isDynamicEntry,
  lazyHandler,
  now,
  numberFromEnv,
  PendingSets,
  sharedTagManifest,
  StoredEntry,
  storedEntryOf,
  tagMethods,
} from "./use-cache-common";

export interface RemoteUseCacheHandlerOptions {
  /**
   * The bucket entries are stored in, or `null` for memory only. From
   * `CDK_NEXTJS_CACHE_BUCKET_NAME` by default, and never at build time.
   */
  bucket?: CacheBucket | null;
  /** Prefixes every S3 key; `CDK_NEXTJS_BUILD_ID` by default. */
  buildId?: string;
  /** Tag state; the process-wide one from the environment by default. */
  tags?: TrackedTagMarkers;
  /** Memory tier bound in bytes; `CDK_NEXTJS_USE_CACHE_MEMORY_BYTES` or 50 MB. */
  maxMemoryBytes?: number;
}

/** What is written to S3 for one entry. */
interface SerializedEntry extends Omit<StoredEntry, "value"> {
  /** The full cache key, checked on read; the object key is only its hash. */
  key: string;
  value: Buffer;
}

function bucketFromEnv(): CacheBucket | null {
  if (isBuildPhase()) {
    // No credentials, and nothing a build-time entry could be read back by:
    // prerenders keep what they need in their own resume data cache.
    return null;
  }
  const { bucketName, region } = resolveAwsCacheConfig();
  if (!bucketName) {
    console.warn(
      "CDK_NEXTJS_CACHE_BUCKET_NAME environment variable not set, 'use cache: remote' entries are local to each instance",
    );
    return null;
  }
  return new CacheBucket(new S3Client({ region }), bucketName);
}

/** Whether `stored` is past `revalidate`, so a fresher copy may exist. */
function isPastRevalidate(stored: StoredEntry, at: number): boolean {
  return at > stored.timestamp + stored.revalidate * 1000;
}

/** Whether `stored` is past `expire`, and may no longer be served at all. */
function isPastExpire(stored: StoredEntry, at: number): boolean {
  return at > stored.timestamp + stored.expire * 1000;
}

/**
 * A `'use cache: remote'` handler: S3 for storage, memory in front, and the
 * revalidation table for tags.
 *
 * Unlike the default handler an entry is served until `expire`, not dropped at
 * `revalidate`: a remote read is worth serving stale while Next.js's wrapper
 * regenerates it in the background, which is what `revalidate` is for. A memory
 * copy past `revalidate` is checked against S3 first, since another instance may
 * already have written the regenerated entry.
 */
export function createRemoteUseCacheHandler(
  options: RemoteUseCacheHandlerOptions = {},
): CacheHandler {
  const bucket =
    options.bucket === undefined ? bucketFromEnv() : options.bucket;
  const buildId = options.buildId ?? resolveAwsCacheConfig().buildId;
  const tags = options.tags ?? sharedTagManifest();
  const memory = new EntryLru(
    options.maxMemoryBytes ??
      numberFromEnv("CDK_NEXTJS_USE_CACHE_MEMORY_BYTES", DEFAULT_MEMORY_BYTES),
  );
  const pending = new PendingSets();
  const debug = getDebug("cdk-nextjs:cache-handler:use-cache:remote");

  const s3Key = (cacheKey: string) =>
    useCacheS3Key(buildId, createHash("sha256").update(cacheKey).digest("hex"));

  async function readFromS3(
    cacheKey: string,
  ): Promise<StoredEntry | undefined> {
    if (!bucket) {
      return undefined;
    }
    const key = s3Key(cacheKey);
    try {
      const object = await bucket.get(key);
      if (!object) {
        debug(`S3 MISS ${cacheKey}`);
        return undefined;
      }
      const parsed = parseCacheValue(object.body) as SerializedEntry;
      if (parsed.key !== cacheKey) {
        // A hash collision, or an object that is not ours: never serve it.
        console.warn(`'use cache: remote' entry ${key} is for another key`);
        return undefined;
      }
      return {
        tags: parsed.tags,
        stale: parsed.stale,
        timestamp: parsed.timestamp,
        expire: parsed.expire,
        revalidate: parsed.revalidate,
        value: new Uint8Array(parsed.value),
      };
    } catch (error) {
      console.error(
        `Error reading 'use cache: remote' entry ${key} from S3:`,
        error,
      );
      return undefined;
    }
  }

  async function writeToS3(cacheKey: string, stored: StoredEntry) {
    if (!bucket) {
      return;
    }
    const key = s3Key(cacheKey);
    const serialized: SerializedEntry = {
      ...stored,
      key: cacheKey,
      value: Buffer.from(stored.value),
    };
    try {
      await bucket.putJson(key, serializeCacheValue(serialized));
      debug(`S3 SET ${cacheKey} (${key})`);
    } catch (error) {
      // The entry is still in memory here; other instances just miss.
      console.error(
        `Error writing 'use cache: remote' entry ${key} to S3:`,
        error,
      );
    }
  }

  return {
    async get(cacheKey: string): Promise<CacheEntry | undefined> {
      await pending.wait(cacheKey);
      const at = now();

      let stored = memory.get(cacheKey);
      if (stored) {
        await tags.ensure(stored.tags);
      }

      // Past `revalidate`, or stale or expired by tag: another instance may
      // already have written the regenerated entry, and serving that beats
      // regenerating it here too. An expired entry S3 has nothing newer for is
      // dropped below.
      if (
        !stored ||
        isPastRevalidate(stored, at) ||
        tags.state(stored.tags, stored.timestamp) !== "fresh"
      ) {
        const fromS3 = await readFromS3(cacheKey);
        if (fromS3 && (!stored || fromS3.timestamp > stored.timestamp)) {
          stored = fromS3;
          // An entry written by another instance: its tags may have been
          // revalidated at any time since, so they are read before judging it.
          await tags.ensure(stored.tags);
          memory.set(cacheKey, stored);
        }
      }

      if (!stored) {
        debug(`MISS ${cacheKey}`);
        return undefined;
      }
      if (stored.expire < 0 || isPastExpire(stored, at)) {
        debug(`EXPIRED ${cacheKey}`);
        memory.delete(cacheKey);
        return undefined;
      }
      const state = tags.state(stored.tags, stored.timestamp);
      if (state === "expired") {
        debug(`EXPIRED BY TAG ${cacheKey}`);
        memory.delete(cacheKey);
        return undefined;
      }
      debug(`HIT ${cacheKey}${state === "stale" ? " (stale tag)" : ""}`);
      // `revalidate: -1` makes the wrapper serve the entry and regenerate it in
      // the background, the built-in handler's answer to a stale tag.
      return cacheEntryOf(stored, state === "stale" ? -1 : stored.revalidate);
    },

    async set(
      cacheKey: string,
      pendingEntry: Promise<CacheEntry>,
    ): Promise<void> {
      const done = pending.begin(cacheKey);
      let stored: StoredEntry;
      try {
        stored = await storedEntryOf(pendingEntry);
      } catch (error) {
        // The stream errored: store nothing rather than a partial entry.
        debug(`SET FAILED ${cacheKey}`, error);
        done();
        return;
      }
      if (isDynamicEntry(stored)) {
        debug(`SKIP dynamic entry ${cacheKey}`);
        done();
        return;
      }
      memory.set(cacheKey, stored);
      tags.track(stored.tags);
      // A `get` waiting on this `set` can be answered from memory now; only
      // other instances need the S3 copy.
      done();
      await writeToS3(cacheKey, stored);
    },

    ...tagMethods(tags),
  };
}

export default lazyHandler(() => createRemoteUseCacheHandler());

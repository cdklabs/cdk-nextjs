/*
  The `cacheHandlers.default` handler, for plain `'use cache'`.
  See: https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers

  Storage stays in memory, per instance, as Next.js intends for `'use cache'`
  (`'use cache: remote'` is the shared one). What this changes is tags: Next.js's
  built-in handler keeps them in a process-local map, so a `revalidateTag` on
  one instance left every other instance serving the revalidated entry. Here
  they go through the revalidation table's marker rows. See
  `TrackedTagMarkers`.
*/
/* eslint-disable import/no-extraneous-dependencies */
import getDebug from "debug";
import type {
  CacheEntry,
  CacheHandler,
} from "next/dist/server/lib/cache-handlers/types";
import { TrackedTagMarkers } from "./aws-cache-store";
import {
  awaitIf,
  cacheEntryOf,
  DEFAULT_MEMORY_BYTES,
  EntryLru,
  isDynamicEntry,
  lazyHandler,
  now,
  numberFromEnv,
  PendingSets,
  sharedTagManifest,
  storedEntryOf,
  tagMethods,
} from "./use-cache-common";

export interface DefaultUseCacheHandlerOptions {
  /** Tag state; the process-wide one from the environment by default. */
  tags?: TrackedTagMarkers;
}

/**
 * A `'use cache'` handler with the semantics of Next.js's built-in one
 * (`next/dist/server/lib/cache-handlers/default.js`) and tags shared across
 * instances.
 *
 * An equivalent rather than a wrapper: the built-in handler judges tags against
 * the module-level `tagsManifest` of whichever copy of `next` it was required
 * from, and this bundle cannot be sure of reaching the copy the server loaded
 * (the same reason `S3CacheHandler` reads that manifest from the module cache
 * instead of requiring it). Keeping the tag state here removes the question.
 *
 * As in the built-in handler, an entry is dropped once it is past `revalidate`
 * rather than served stale: an in-memory entry is likely evicted before a
 * background refresh would pay off.
 */
export function createDefaultUseCacheHandler(
  options: DefaultUseCacheHandlerOptions = {},
): CacheHandler {
  const tags = options.tags ?? sharedTagManifest();
  const memory = new EntryLru(
    numberFromEnv("CDK_NEXTJS_USE_CACHE_MEMORY_BYTES", DEFAULT_MEMORY_BYTES),
  );
  const pending = new PendingSets();
  const debug = getDebug("cdk-nextjs:cache-handler:use-cache:default");
  tags.judgeEntriesOf(() => memory.oldestTimestamp());

  /**
   * Read the markers of whichever of `tagList` are untracked: first, when the
   * answer depends on them, or else in the background. Read either way, so
   * the tags join the rolling re-read, which catches a revalidation whose log
   * row failed to write.
   */
  const ensureTags = (needed: boolean, tagList: readonly string[]) =>
    awaitIf(needed, tags.ensure(tagList), "Error reading cache tags:");

  return {
    async get(cacheKey: string): Promise<CacheEntry | undefined> {
      await pending.wait(cacheKey);
      const stored = memory.get(cacheKey);
      if (!stored) {
        debug(`MISS ${cacheKey}`);
        return undefined;
      }
      if (now() > stored.timestamp + stored.revalidate * 1000) {
        debug(`EXPIRED ${cacheKey}`);
        memory.delete(cacheKey);
        return undefined;
      }
      // Only an entry older than what the manifest fully knows needs its tags'
      // markers read first: see `completeSince`. Every entry stored since the
      // instance started is newer, so its first read waits on nothing.
      await ensureTags(stored.timestamp < tags.completeSince, stored.tags);
      const state = tags.state(stored.tags, stored.timestamp);
      if (state === "expired") {
        debug(`EXPIRED BY TAG ${cacheKey}`);
        memory.delete(cacheKey);
        return undefined;
      }
      debug(`HIT ${cacheKey}${state === "stale" ? " (stale tag)" : ""}`);
      // `revalidate: -1` is how the built-in handler reports a stale tag: the
      // wrapper serves the entry and regenerates it in the background.
      return cacheEntryOf(stored, state === "stale" ? -1 : stored.revalidate);
    },

    async set(
      cacheKey: string,
      pendingEntry: Promise<CacheEntry>,
    ): Promise<void> {
      const done = pending.begin(cacheKey);
      try {
        const stored = await storedEntryOf(pendingEntry);
        if (isDynamicEntry(stored)) {
          debug(`SKIP dynamic entry ${cacheKey}`);
          return;
        }
        memory.set(cacheKey, stored);
        tags.track(stored.tags);
        // In the background, now rather than at the first `get`: a
        // revalidation from before the log's first lookback with an `expire`
        // still to come expires this entry when it comes, and only the marker
        // says so. See `completeSince`.
        void ensureTags(false, stored.tags);
        debug(`SET ${cacheKey}`);
      } catch (error) {
        // The stream errored: store nothing rather than a partial entry.
        debug(`SET FAILED ${cacheKey}`, error);
      } finally {
        done();
      }
    },

    ...tagMethods(tags),

    // Next.js awaits this inside the `'use cache'` lookup, with the implicit
    // tags of the request's path: on a new instance, every new path was a
    // marker read there, and the entry missed the static stage of a staged
    // render. The answer judges whichever entry this request reads, so it is
    // given without reading only while every entry held is new enough for the
    // manifest to answer alone.
    async getExpiration(implicitTags) {
      await ensureTags(
        memory.oldestTimestamp() < tags.completeSince,
        implicitTags,
      );
      return tags.expiration(implicitTags);
    },
  };
}

export default lazyHandler(() => createDefaultUseCacheHandler());

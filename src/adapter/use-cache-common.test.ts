/* eslint-disable import/no-extraneous-dependencies */
jest.mock("@aws-sdk/client-dynamodb");

import type { CacheEntry } from "next/dist/server/lib/cache-handlers/types";
import { TagMarker, TagMarkerTable } from "./aws-cache-store";
import {
  cacheEntryOf,
  EntryLru,
  PendingSets,
  readStream,
  StoredEntry,
  storedEntryOf,
  UseCacheTagManifest,
} from "./use-cache-common";

/** A `TagMarkerTable` over a plain map, counting its calls. */
function fakeMarkers(rows = new Map<string, TagMarker>()) {
  const read = jest.fn(async (tags: string[]) => {
    const found = new Map<string, TagMarker>();
    for (const tag of tags) {
      const row = rows.get(tag);
      if (row) found.set(tag, { ...row });
    }
    return found;
  });
  const write = jest.fn(
    async (tag: string, now: number, durations?: { expire?: number }) => {
      const row = rows.get(tag) ?? {};
      if (!durations) {
        row.revalidatedAt = now;
      } else {
        row.staleAt = now;
        if (durations.expire !== undefined) {
          row.expiredAt = now + durations.expire * 1000;
        }
      }
      rows.set(tag, row);
    },
  );
  return {
    rows,
    read,
    write,
    table: { read, write } as unknown as TagMarkerTable,
  };
}

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
}

function stored(bytes: number, extra: Partial<StoredEntry> = {}): StoredEntry {
  return {
    value: new Uint8Array(bytes),
    tags: [],
    stale: 300,
    timestamp: Date.now(),
    expire: 3600,
    revalidate: 900,
    ...extra,
  };
}

describe("UseCacheTagManifest", () => {
  it("reads a tag the first time it is needed, and not again", async () => {
    const markers = fakeMarkers(new Map([["a", { revalidatedAt: 50 }]]));
    const tags = new UseCacheTagManifest({ markers: markers.table });

    await Promise.all([tags.ensure(["a", "b"]), tags.ensure(["a", "b"])]);
    await tags.ensure(["a", "b"]);

    expect(markers.read).toHaveBeenCalledTimes(1);
    expect(markers.read).toHaveBeenCalledWith(["a", "b"]);
    expect(tags.state(["a"], 40)).toBe("expired");
    expect(tags.state(["a"], 60)).toBe("fresh");
    expect(tags.state(["b"], 40)).toBe("fresh");
  });

  it("refreshes tracked tags at most once per interval", async () => {
    const markers = fakeMarkers();
    const tags = new UseCacheTagManifest({
      markers: markers.table,
      refreshIntervalMs: 50,
    });
    // Nothing tracked: nothing to read.
    await tags.refresh();
    expect(markers.read).not.toHaveBeenCalled();

    tags.track(["a"]);
    // Just tracked, so not due yet.
    await tags.refresh();
    expect(markers.read).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 60));
    await Promise.all([tags.refresh(), tags.refresh()]);
    await tags.refresh();
    expect(markers.read).toHaveBeenCalledTimes(1);
  });

  it("sees another instance's revalidation on the next refresh", async () => {
    const rows = new Map<string, TagMarker>();
    const here = new UseCacheTagManifest({
      markers: fakeMarkers(rows).table,
      refreshIntervalMs: 0,
    });
    const there = new UseCacheTagManifest({
      markers: fakeMarkers(rows).table,
      refreshIntervalMs: 0,
    });
    const createdAt = Date.now() - 1000;
    here.track(["posts"]);

    await there.update(["posts"], undefined);
    // Not yet: `here` has not read since.
    expect(here.state(["posts"], createdAt)).toBe("fresh");
    await here.refresh();
    expect(here.state(["posts"], createdAt)).toBe("expired");
  });

  it("applies its own revalidation at once, and writes it once for both handlers", async () => {
    const markers = fakeMarkers();
    const tags = new UseCacheTagManifest({ markers: markers.table });
    const createdAt = Date.now() - 1000;

    // What Next.js does: `updateTags` on the default and the remote handler.
    await Promise.all([
      tags.update(["a", "b"], { expire: 0 }),
      tags.update(["a", "b"], { expire: 0 }),
    ]);

    expect(markers.write).toHaveBeenCalledTimes(2);
    expect(tags.state(["b"], createdAt)).toBe("expired");
    expect(markers.rows.get("a")).toEqual({
      staleAt: expect.any(Number),
      expiredAt: expect.any(Number),
    });
  });

  it("marks a profile's revalidation stale until its expire", async () => {
    const tags = new UseCacheTagManifest({ markers: undefined });
    const createdAt = Date.now() - 1000;
    await tags.update(["a"], { expire: 3600 });
    expect(tags.state(["a"], createdAt)).toBe("stale");
    // Not an expiration yet, so implicit tags are not affected either.
    expect(tags.expiration(["a"])).toBe(0);
  });

  it("reports the latest past expiration of implicit tags", async () => {
    const markers = fakeMarkers(
      new Map<string, TagMarker>([
        ["_N_T_/a", { revalidatedAt: 100 }],
        ["_N_T_/b", { staleAt: 150, expiredAt: 200 }],
        ["_N_T_/c", { staleAt: 150, expiredAt: Date.now() + 60_000 }],
      ]),
    );
    const tags = new UseCacheTagManifest({ markers: markers.table });
    await tags.ensure(["_N_T_/a", "_N_T_/b", "_N_T_/c", "_N_T_/d"]);
    expect(tags.expiration(["_N_T_/a", "_N_T_/b", "_N_T_/c"])).toBe(200);
    expect(tags.expiration(["_N_T_/d"])).toBe(0);
  });

  it("does not let an eventually consistent read undo its own write", async () => {
    const markers = fakeMarkers();
    const tags = new UseCacheTagManifest({
      markers: markers.table,
      refreshIntervalMs: 0,
    });
    await tags.update(["a"], undefined);
    // The read does not show the write yet.
    markers.rows.clear();
    await tags.refresh();
    expect(tags.state(["a"], Date.now() - 1000)).toBe("expired");
  });

  it("treats a failed read as fresh and tries again on the next refresh", async () => {
    const markers = fakeMarkers(new Map([["a", { revalidatedAt: 50 }]]));
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    markers.read.mockRejectedValueOnce(new Error("throttled"));
    const tags = new UseCacheTagManifest({
      markers: markers.table,
      refreshIntervalMs: 0,
    });

    await tags.ensure(["a"]);
    expect(tags.state(["a"], 40)).toBe("fresh");
    await tags.refresh();
    expect(tags.state(["a"], 40)).toBe("expired");
    error.mockRestore();
  });

  it("forgets the least recently used tag past its bound, and reads it again", async () => {
    const markers = fakeMarkers();
    const tags = new UseCacheTagManifest({
      markers: markers.table,
      maxTrackedTags: 2,
    });
    await tags.ensure(["a"]);
    await tags.ensure(["b"]);
    await tags.ensure(["a"]); // `b` is now the oldest
    await tags.ensure(["c"]);
    markers.read.mockClear();

    await tags.ensure(["a", "b", "c"]);
    expect(markers.read).toHaveBeenCalledWith(["b"]);
  });

  it("keeps tags local to the process without a table", async () => {
    const tags = new UseCacheTagManifest({ markers: undefined });
    expect(tags.isShared).toBe(false);
    await tags.ensure(["a"]);
    await tags.refresh();
    await tags.update(["a"], undefined);
    expect(tags.state(["a"], Date.now() - 1000)).toBe("expired");
  });
});

describe("EntryLru", () => {
  it("evicts the least recently used entries past its byte bound", () => {
    const lru = new EntryLru(250);
    lru.set("a", stored(100));
    lru.set("b", stored(100));
    lru.get("a");
    lru.set("c", stored(100));
    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("a")).toBeDefined();
    expect(lru.get("c")).toBeDefined();
  });

  it("does not keep an entry larger than the whole bound", () => {
    const lru = new EntryLru(50);
    lru.set("a", stored(100));
    expect(lru.size).toBe(0);
  });

  it("accounts for a replaced entry", () => {
    const lru = new EntryLru(250);
    lru.set("a", stored(200));
    lru.set("a", stored(10));
    lru.set("b", stored(200));
    expect(lru.size).toBe(2);
  });
});

describe("entries", () => {
  it("reads a stream to the end", async () => {
    const bytes = await readStream(streamOf("ab", "cd"));
    expect(new TextDecoder().decode(bytes)).toBe("abcd");
  });

  it("rejects a stream that errors part-way", async () => {
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.error(new Error("render failed"));
      },
    });
    await expect(readStream(failing)).rejects.toThrow("render failed");
  });

  it("hands every reader its own stream", async () => {
    const entry: CacheEntry = {
      value: streamOf("payload"),
      tags: ["t"],
      stale: 1,
      timestamp: 2,
      expire: 3,
      revalidate: 4,
    };
    const kept = await storedEntryOf(Promise.resolve(entry));
    const first = cacheEntryOf(kept);
    const second = cacheEntryOf(kept, -1);
    expect(second.revalidate).toBe(-1);
    expect(first.tags).toEqual(["t"]);
    expect(new TextDecoder().decode(await readStream(first.value))).toBe(
      "payload",
    );
    expect(new TextDecoder().decode(await readStream(second.value))).toBe(
      "payload",
    );
  });
});

describe("PendingSets", () => {
  it("holds a get until the set for its key ends", async () => {
    const pending = new PendingSets();
    const done = pending.begin("k");
    let waited = false;
    const wait = pending.wait("k").then(() => (waited = true));
    await Promise.resolve();
    expect(waited).toBe(false);
    done();
    await wait;
    expect(waited).toBe(true);
    // Nothing pending: no wait at all.
    await pending.wait("k");
    await pending.wait("other");
  });
});

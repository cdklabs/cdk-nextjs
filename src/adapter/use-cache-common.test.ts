/* eslint-disable import/no-extraneous-dependencies */
jest.mock("@aws-sdk/client-dynamodb");

import type { CacheEntry } from "next/dist/server/lib/cache-handlers/types";
import {
  MAX_REVALIDATION_LOG_GAP_MS,
  RevalidationLog,
  RevalidationLogRow,
  TagMarker,
  TagMarkerTable,
  TrackedTagMarkers,
} from "./aws-cache-store";
import {
  cacheEntryOf,
  EntryLru,
  now,
  PendingSets,
  readStream,
  StoredEntry,
  storedEntryOf,
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
    async (tag: string, at: number, durations?: { expire?: number }) => {
      const row = rows.get(tag) ?? {};
      if (!durations) {
        row.revalidatedAt = at;
      } else {
        row.staleAt = at;
        if (durations.expire !== undefined) {
          row.expiredAt = at + durations.expire * 1000;
        }
      }
      rows.set(tag, row);
      // `ReturnValues: "ALL_NEW"`, as the real table answers.
      return { ...row };
    },
  );
  return {
    rows,
    read,
    write,
    table: { read, write } as unknown as TagMarkerTable,
  };
}

/**
 * A `RevalidationLog` over a plain array, counting its calls. Its query returns
 * what the real one would: every row at or after `since`, oldest first.
 */
function fakeLog(rows: RevalidationLogRow[] = []) {
  const put = jest.fn(async (tag: string, at: number, marker: TagMarker) => {
    rows.push({
      sk: `${String(at).padStart(15, "0")}#${tag}`,
      at,
      tag,
      marker,
    });
  });
  const query = jest.fn(async (since: number) => ({
    rows: rows.filter((row) => row.at >= since).sort((a, b) => a.at - b.at),
    truncated: false,
  }));
  return {
    rows,
    put,
    query,
    log: { put, query } as unknown as RevalidationLog,
  };
}

/** A wall clock a test moves by hand. */
function fakeClock(start = 1_000_000) {
  const clock = { at: start, now: () => clock.at };
  return clock;
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

describe("TrackedTagMarkers", () => {
  it("reads a tag the first time it is needed, and not again", async () => {
    const markers = fakeMarkers(new Map([["a", { revalidatedAt: 50 }]]));
    const tags = new TrackedTagMarkers({
      markers: markers.table,
      log: fakeLog().log,
    });

    await Promise.all([tags.ensure(["a", "b"]), tags.ensure(["a", "b"])]);
    await tags.ensure(["a", "b"]);

    expect(markers.read).toHaveBeenCalledTimes(1);
    expect(markers.read).toHaveBeenCalledWith(["a", "b"]);
    expect(tags.state(["a"], 40)).toBe("expired");
    expect(tags.state(["a"], 60)).toBe("fresh");
    expect(tags.state(["b"], 40)).toBe("fresh");
  });

  it("applies its own revalidation at once, and writes it once for both handlers", async () => {
    const markers = fakeMarkers();
    const tags = new TrackedTagMarkers({
      markers: markers.table,
      log: fakeLog().log,
    });
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

  it("gives a later revalidation its own marker while the first is still writing", async () => {
    const markers = fakeMarkers();
    let release = () => {};
    markers.write.mockImplementationOnce(
      (_tag, at) =>
        new Promise((resolve) => {
          release = () => resolve({ revalidatedAt: at });
        }),
    );
    const tags = new TrackedTagMarkers({
      markers: markers.table,
      log: fakeLog().log,
    });

    const first = tags.update(["x"], undefined);
    // Another request's `revalidateTag('x')`, a turn later.
    await new Promise((resolve) => setImmediate(resolve));
    const second = tags.update(["x"], undefined);
    release();
    await Promise.all([first, second]);

    expect(markers.write).toHaveBeenCalledTimes(2);
    const [[, firstAt], [, secondAt]] = markers.write.mock.calls;
    expect(secondAt).toBeGreaterThan(firstAt);
  });

  it("puts a slow log row again under a fresh timestamp, so readers see it", async () => {
    const clock = fakeClock();
    const log = fakeLog();
    log.put.mockImplementationOnce(async () => {
      // Readers' cursors have moved past the row by the time it shows.
      clock.at += 10_000;
    });
    const tags = new TrackedTagMarkers({
      markers: fakeMarkers().table,
      log: log.log,
      clock: clock.now,
    });

    expect(await tags.update(["x"], undefined)).toBe(true);
    expect(log.put.mock.calls.map(([, at]) => at)).toEqual([
      1_000_000, 1_010_000,
    ]);
  });

  it("reports a log row slow twice as not recorded", async () => {
    const clock = fakeClock();
    const log = fakeLog();
    log.put.mockImplementation(async () => {
      clock.at += 10_000;
    });
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const tags = new TrackedTagMarkers({
      markers: fakeMarkers().table,
      log: log.log,
      clock: clock.now,
    });

    expect(await tags.update(["x"], undefined)).toBe(false);
    expect(log.put).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("tracks the whole row its own write returns, not just what it set", async () => {
    // Another instance's `updateTag` for a tag this one does not track yet.
    const createdAt = Date.now() - 1000;
    const markers = fakeMarkers(
      new Map([["posts", { revalidatedAt: createdAt + 500 }]]),
    );
    const tags = new TrackedTagMarkers({
      markers: markers.table,
      log: fakeLog().log,
    });

    await tags.update(["posts"], { expire: 3600 });

    // Older than that `updateTag`, so a blocking render, not stale-while-revalidate.
    expect(tags.state(["posts"], createdAt)).toBe("expired");
  });

  it("marks a profile's revalidation stale until its expire", async () => {
    const tags = new TrackedTagMarkers({});
    const createdAt = Date.now() - 1000;
    await tags.update(["a"], { expire: 3600 });
    expect(tags.state(["a"], createdAt)).toBe("stale");
    // Not an expiration yet, so implicit tags are not affected either.
    expect(tags.expiration(["a"])).toBe(0);
  });

  // Next.js stamps entries with `performance.timeOrigin + performance.now()`,
  // which can run behind `Date.now()`. A marker stamped on the wall clock would
  // then postdate an entry regenerated right after the revalidation, which
  // would read as revalidated again, and again.
  it("stamps markers on the clock entries are stamped with", async () => {
    const wall = jest.spyOn(Date, "now").mockImplementation(() => now() + 500);
    try {
      const tags = new TrackedTagMarkers({});
      await tags.update(["a"], undefined);
      const regenerated = now() + 1;
      expect(tags.state(["a"], regenerated)).toBe("fresh");
      expect(tags.state(["a"], regenerated - 100)).toBe("expired");
    } finally {
      wall.mockRestore();
    }
  });

  it("reports the latest past expiration of implicit tags", async () => {
    const markers = fakeMarkers(
      new Map<string, TagMarker>([
        ["_N_T_/a", { revalidatedAt: 100 }],
        ["_N_T_/b", { staleAt: 150, expiredAt: 200 }],
        ["_N_T_/c", { staleAt: 150, expiredAt: Date.now() + 60_000 }],
      ]),
    );
    const tags = new TrackedTagMarkers({
      markers: markers.table,
      log: fakeLog().log,
    });
    await tags.ensure(["_N_T_/a", "_N_T_/b", "_N_T_/c", "_N_T_/d"]);
    expect(tags.expiration(["_N_T_/a", "_N_T_/b", "_N_T_/c"])).toBe(200);
    expect(tags.expiration(["_N_T_/d"])).toBe(0);
  });

  it("does not let an eventually consistent read undo its own write", async () => {
    const markers = fakeMarkers();
    const tags = new TrackedTagMarkers({
      markers: markers.table,
      log: fakeLog().log,
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
    const tags = new TrackedTagMarkers({
      markers: markers.table,
      log: fakeLog().log,
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
    const tags = new TrackedTagMarkers({
      markers: markers.table,
      log: fakeLog().log,
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

  // Every path is a tag of its own, so an app of 1000 tagged pages needs 2000:
  // tracked 1000 at most, half its requests re-read an evicted marker.
  it("keeps 2000 tags a page each tracked, without reading them again", async () => {
    const markers = fakeMarkers();
    const tags = new TrackedTagMarkers({
      markers: markers.table,
      log: fakeLog().log,
    });
    const pages = Array.from({ length: 1000 }, (_, n) => [
      `item-${n}`,
      `_N_T_/use-cache/${n}`,
    ]);
    for (const page of pages) await tags.ensure(page);
    markers.read.mockClear();
    for (const page of pages) await tags.ensure(page);
    expect(markers.read).not.toHaveBeenCalled();
  });

  it("keeps tags local to the process without a table", async () => {
    const tags = new TrackedTagMarkers({});
    await tags.ensure(["a"]);
    await tags.refresh();
    await tags.update(["a"], undefined);
    expect(tags.state(["a"], Date.now() - 1000)).toBe("expired");
  });
});

describe("TrackedTagMarkers with the revalidation log", () => {
  const INTERVAL = 1000;

  /** Two instances, `a` and `b`, over one table and one clock. */
  function instances(
    options: { resyncIntervalMs?: number; random?: () => number } = {},
  ) {
    const markerRows = new Map<string, TagMarker>();
    const logRows: RevalidationLogRow[] = [];
    const clock = fakeClock();
    const instance = () => {
      const markers = fakeMarkers(markerRows);
      const log = fakeLog(logRows);
      const tags = new TrackedTagMarkers({
        markers: markers.table,
        log: log.log,
        refreshIntervalMs: INTERVAL,
        clock: clock.now,
        // Due at the full interval unless a test asks otherwise.
        random: () => 0,
        ...options,
      });
      return { markers, log, tags };
    };
    return { clock, logRows, instance, a: instance(), b: instance() };
  }

  const createdAt = () => now() - 1000;

  it("reaches another instance within one interval, in one Query and no BatchGetItem", async () => {
    const { clock, a, b } = instances();
    await b.tags.ensure(["posts"]);
    b.markers.read.mockClear();

    await a.tags.update(["posts"], undefined);
    expect(a.log.put).toHaveBeenCalledWith(
      "posts",
      clock.at,
      expect.objectContaining({ revalidatedAt: expect.any(Number) }),
    );

    clock.at += INTERVAL;
    await b.tags.refresh();
    expect(b.tags.state(["posts"], createdAt())).toBe("expired");
    expect(b.log.query).toHaveBeenCalledTimes(1);
    expect(b.markers.read).not.toHaveBeenCalled();
  });

  it("issues no read while the interval has not passed", async () => {
    const { clock, b } = instances();
    // Nothing tracked: nothing to ask.
    clock.at += INTERVAL;
    await b.tags.refresh();
    expect(b.log.query).not.toHaveBeenCalled();

    await b.tags.ensure(["posts"]);

    b.markers.read.mockClear();
    // That refresh still counts: what is tracked since was read, or is new.
    await b.tags.refresh();
    expect(b.log.query).not.toHaveBeenCalled();

    clock.at += INTERVAL;
    await Promise.all([b.tags.refresh(), b.tags.refresh()]);
    expect(b.log.query).toHaveBeenCalledTimes(1);

    clock.at += INTERVAL - 1;
    await b.tags.refresh();
    expect(b.log.query).toHaveBeenCalledTimes(1);
    expect(b.markers.read).not.toHaveBeenCalled();

    clock.at += 1;
    await b.tags.refresh();
    expect(b.log.query).toHaveBeenCalledTimes(2);
  });

  it("asks with nothing tracked once an entry store relies on the log", async () => {
    const { clock, b } = instances();
    b.tags.judgeEntriesOf(() => Infinity);
    clock.at += INTERVAL;
    await b.tags.refresh();
    expect(b.log.query).toHaveBeenCalledTimes(1);
  });

  it("applies a row read again inside the lookback only once", async () => {
    const { clock, logRows, b } = instances();
    await b.tags.ensure(["posts"]);
    b.markers.read.mockClear();
    let reads = 0;
    const row: RevalidationLogRow = {
      sk: `${clock.at}#posts`,
      at: clock.at,
      tag: "posts",
      get marker() {
        reads++;
        return { revalidatedAt: now() };
      },
    };
    // The same row twice in one page, and again on the next query.
    logRows.push(row, row);

    for (let i = 0; i < 3; i++) {
      clock.at += INTERVAL;
      await b.tags.refresh();
    }
    expect(b.log.query).toHaveBeenCalledTimes(3);
    expect(reads).toBe(1);
    expect(b.tags.state(["posts"], createdAt())).toBe("expired");
  });

  // Replication lag, or a writer whose clock runs behind: the row shows up
  // after a query that should have seen it, with a sort key before it.
  it("still sees a row that appears up to the lookback late", async () => {
    const { clock, logRows, b } = instances();
    await b.tags.ensure(["late", "too-late"]);
    b.markers.read.mockClear();
    clock.at += INTERVAL;
    const firstQuery = clock.at;
    await b.tags.refresh();

    const marker = { revalidatedAt: now() };
    logRows.push(
      { sk: "late", at: firstQuery - 5000, tag: "late", marker },
      { sk: "too-late", at: firstQuery - 5001, tag: "too-late", marker },
    );
    clock.at += INTERVAL;
    await b.tags.refresh();
    expect(b.log.query).toHaveBeenLastCalledWith(firstQuery - 5000);
    expect(b.tags.state(["late"], createdAt())).toBe("expired");
    // Past the lookback: what the periodic re-read of the markers is for.
    expect(b.tags.state(["too-late"], createdAt())).toBe("fresh");
  });

  it("forgets its tracked markers after a gap the log may not cover, and reads each as it is needed", async () => {
    const { clock, a, b } = instances();
    await b.tags.ensure(["posts", "other"]);
    await a.tags.update(["posts"], undefined);

    clock.at += MAX_REVALIDATION_LOG_GAP_MS + 1;
    const gapEnd = clock.at;
    await b.tags.refresh();
    // No burst of re-reads, and no query of a log that may have lost rows.
    expect(b.markers.read).toHaveBeenCalledTimes(1);
    expect(b.log.query).not.toHaveBeenCalled();

    await b.tags.ensure(["posts"]);
    expect(b.markers.read).toHaveBeenLastCalledWith(["posts"]);
    expect(b.tags.state(["posts"], createdAt())).toBe("expired");

    // Then back on the log, from just before the gap ended.
    clock.at += INTERVAL;
    await b.tags.refresh();
    expect(b.log.query).toHaveBeenCalledWith(gapEnd - 5000);
  });

  // Re-reading every tracked marker at once is ~5,000 RCU at 10,000 tags: more
  // than the one partition serves in a second.
  it("re-reads each tracked marker once per resync interval, at most 100 a refresh", async () => {
    const { clock, b } = instances({ resyncIntervalMs: 10 * INTERVAL });
    await b.tags.ensure(Array.from({ length: 250 }, (_, i) => `t${i}`));
    b.markers.read.mockClear();
    const sizes: number[] = [];
    for (let i = 1; i <= 14; i++) {
      clock.at += INTERVAL;
      b.markers.read.mockClear();
      await b.tags.refresh();
      sizes.push(b.markers.read.mock.calls[0]?.[0].length ?? 0);
    }
    expect(b.log.query).toHaveBeenCalledTimes(14);
    // Due at 10 intervals, oldest first, 100 per refresh; then not again.
    expect(sizes).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 100, 50, 0, 0]);
    expect(b.markers.read).not.toHaveBeenCalled();
  });

  // Tags first read together must not come due together every interval.
  it("spreads when each tag comes due over the last quarter of the interval", async () => {
    // Due at 10, 8.75 and 7.5 intervals, known in that order: the one due
    // first is last, behind two that are not due yet.
    const randoms = [0, 0.5, 1];
    const { clock, b } = instances({
      resyncIntervalMs: 10 * INTERVAL,
      random: () => randoms.shift() ?? 0,
    });
    await b.tags.ensure(["late", "middle", "early"]);
    b.markers.read.mockClear();
    const readAt: Record<string, number> = {};
    for (let i = 1; i <= 10; i++) {
      clock.at += INTERVAL;
      b.markers.read.mockClear();
      await b.tags.refresh();
      for (const tag of b.markers.read.mock.calls[0]?.[0] ?? []) {
        readAt[tag] ??= i;
      }
    }
    expect(readAt).toEqual({ early: 8, middle: 9, late: 10 });
  });

  it("re-reads a marker it learned of from its own write only once that is due", async () => {
    const { clock, a } = instances({ resyncIntervalMs: 10 * INTERVAL });
    await a.tags.ensure(["posts"]);
    clock.at += 9 * INTERVAL;
    await a.tags.update(["posts"], undefined);
    clock.at += 2 * INTERVAL;
    await a.tags.refresh();
    // Read 11 intervals ago, but written - so known - 2 intervals ago.
    expect(a.markers.read).toHaveBeenCalledTimes(1);
  });

  it("reads a tag whose first read failed again on the next refresh", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const { clock, a, b } = instances();
    // Only the marker row has it, so only reading the marker finds it.
    a.log.put.mockRejectedValueOnce(new Error("throttled"));
    await a.tags.update(["posts"], undefined);
    b.markers.read.mockRejectedValueOnce(new Error("throttled"));
    await b.tags.ensure(["posts"]);
    expect(b.tags.state(["posts"], createdAt())).toBe("fresh");
    clock.at += INTERVAL;

    await b.tags.refresh();
    expect(b.markers.read).toHaveBeenLastCalledWith(["posts"]);
    expect(b.tags.state(["posts"], createdAt())).toBe("expired");
    error.mockRestore();
  });

  it("forgets its tracked markers when the log has more rows than one query reads", async () => {
    const { clock, b } = instances();
    await b.tags.ensure(["posts"]);
    b.log.query.mockResolvedValueOnce({ rows: [], truncated: true });
    clock.at += INTERVAL;
    await b.tags.refresh();
    expect(b.markers.read).toHaveBeenCalledTimes(1);
    await b.tags.ensure(["posts"]);
    expect(b.markers.read).toHaveBeenCalledTimes(2);
  });

  // Tracking is per tag, not per entry: storing a new entry must not vouch for
  // an older one with the same tag. B's log cursor starts after C's
  // revalidation, so only reading the marker shows it.
  it("still reads a tag's marker after storing an entry with it", async () => {
    const { clock, instance, a: c } = instances();
    const k1CreatedAt = createdAt();
    await c.tags.update(["posts"], undefined);
    clock.at += 10_000;
    // Started after the revalidation: its log cursor is past C's row.
    const b = instance();
    b.tags.track(["posts"]);
    await b.tags.ensure(["posts"]);
    expect(b.markers.read).toHaveBeenCalledWith(["posts"]);
    expect(b.tags.state(["posts"], k1CreatedAt)).toBe("expired");
  });

  it("still reads a tag's marker after storing an entry with it following a forget", async () => {
    const { clock, a, b } = instances();
    await b.tags.ensure(["posts"]);
    const k1CreatedAt = createdAt();
    // Revalidated while `b` was frozen past what the log covers.
    clock.at += MAX_REVALIDATION_LOG_GAP_MS + 1;
    a.log.put.mockRejectedValueOnce(new Error("lost"));
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    await a.tags.update(["posts"], undefined);
    error.mockRestore();
    await b.tags.refresh();
    b.tags.track(["posts"]);
    await b.tags.ensure(["posts"]);
    expect(b.tags.state(["posts"], k1CreatedAt)).toBe("expired");
  });

  it("applies a log row that lands while the tag's first read is in flight", async () => {
    const { clock, a, b } = instances();
    // Something tracked, so the refresh queries the log.
    await b.tags.ensure(["other"]);
    let answer!: (read: Map<string, TagMarker>) => void;
    // Answered before the revalidation below, as a read racing it can be.
    b.markers.read.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const first = b.tags.ensure(["posts"]);
    await a.tags.update(["posts"], undefined);
    clock.at += INTERVAL;
    await b.tags.refresh();
    answer(new Map());
    await first;
    expect(b.tags.state(["posts"], createdAt())).toBe("expired");
  });

  it("is visible at once on the instance that ran updateTag", async () => {
    const { a } = instances();
    a.tags.track(["posts"]);
    await a.tags.update(["posts"], undefined);
    expect(a.tags.state(["posts"], createdAt())).toBe("expired");
    expect(a.markers.write).toHaveBeenCalledTimes(1);
    expect(a.log.put).toHaveBeenCalledTimes(1);
  });

  it("keeps its tags through a failed query and asks again next interval", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const { clock, a, b } = instances();
    await b.tags.ensure(["posts"]);
    b.markers.read.mockClear();
    await a.tags.update(["posts"], undefined);
    b.log.query.mockRejectedValueOnce(new Error("throttled"));

    clock.at += INTERVAL;
    const cursor = clock.at - INTERVAL - 5000;
    await b.tags.refresh();
    expect(b.tags.state(["posts"], createdAt())).toBe("fresh");
    expect(error).toHaveBeenCalled();

    clock.at += INTERVAL;
    await b.tags.refresh();
    // From the same cursor, so nothing written meanwhile is skipped.
    expect(b.log.query).toHaveBeenLastCalledWith(cursor);
    expect(b.tags.state(["posts"], createdAt())).toBe("expired");
    expect(b.markers.read).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("still writes the marker when the log row fails", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const { a } = instances();
    a.log.put.mockRejectedValueOnce(new Error("throttled"));
    await a.tags.update(["posts"], undefined);
    expect(a.markers.rows.get("posts")?.revalidatedAt).toEqual(
      expect.any(Number),
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/revalidation log/),
      expect.any(Error),
    );
    error.mockRestore();
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

  it("knows its oldest entry's timestamp as entries come and go", () => {
    const lru = new EntryLru(250);
    expect(lru.oldestTimestamp()).toBe(Infinity);
    lru.set("a", stored(100, { timestamp: 2 }));
    lru.set("b", stored(100, { timestamp: 1 }));
    expect(lru.oldestTimestamp()).toBe(1);
    lru.delete("b");
    expect(lru.oldestTimestamp()).toBe(2);
    // Evicted for space.
    lru.set("c", stored(100, { timestamp: 3 }));
    lru.set("d", stored(100, { timestamp: 4 }));
    expect(lru.oldestTimestamp()).toBe(3);
  });

  it("knows its oldest entry's timestamp under eviction churn", () => {
    const lru = new EntryLru(1000);
    const held = new Map<string, number>();
    let seed = 1;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 2000; i++) {
      const key = `k${Math.floor(random() * 50)}`;
      const timestamp = Math.floor(random() * 10_000);
      if (random() < 0.2) {
        lru.delete(key);
        held.delete(key);
      } else {
        lru.set(key, stored(100, { timestamp }));
        held.delete(key);
        held.set(key, timestamp);
        // Evicted least recently used first, as the store does.
        while (held.size > lru.size) {
          held.delete(held.keys().next().value!);
        }
      }
      expect(lru.oldestTimestamp()).toBe(Math.min(Infinity, ...held.values()));
    }
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

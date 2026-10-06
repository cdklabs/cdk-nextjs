/* eslint-disable import/no-extraneous-dependencies */
jest.mock("@aws-sdk/client-s3");
jest.mock("@aws-sdk/client-dynamodb");

import {
  BatchGetItemCommand,
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  buildS3Key,
  CacheBucket,
  hashedTag,
  markerClock,
  markerFor,
  markerState,
  markerUpdate,
  mergeMarkers,
  resolveAwsCacheConfig,
  MAX_REVALIDATION_LOG_GAP_MS,
  REVALIDATION_LOG_MAX_PAGES,
  REVALIDATION_LOG_TTL_MS,
  RevalidationLog,
  RevalidationLogRow,
  TagMarker,
  TagMarkerTable,
  TrackedTagMarkers,
  useCacheS3Key,
} from "./aws-cache-store";

/** The input an automocked SDK command was constructed with. */
const commandInput = (command: unknown, type: unknown) => {
  const mock = type as jest.Mock;
  return mock.mock.calls[mock.mock.instances.indexOf(command)][0];
};

describe("resolveAwsCacheConfig", () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { ...env };
  });
  afterAll(() => {
    process.env = env;
  });

  it("reads the environment the constructs set", () => {
    process.env.CDK_NEXTJS_CACHE_BUCKET_NAME = "bucket";
    process.env.CDK_NEXTJS_REVALIDATION_TABLE_NAME = "table";
    process.env.CDK_NEXTJS_BUILD_ID = "build";
    process.env.AWS_REGION = "eu-west-1";
    expect(resolveAwsCacheConfig()).toEqual({
      bucketName: "bucket",
      tableName: "table",
      buildId: "build",
      region: "eu-west-1",
    });
  });

  it("reports what is unset as empty", () => {
    delete process.env.CDK_NEXTJS_CACHE_BUCKET_NAME;
    delete process.env.CDK_NEXTJS_REVALIDATION_TABLE_NAME;
    delete process.env.CDK_NEXTJS_BUILD_ID;
    delete process.env.AWS_REGION;
    expect(resolveAwsCacheConfig()).toEqual({
      bucketName: "",
      tableName: "",
      buildId: "",
      region: "us-east-1",
    });
  });
});

describe("S3 keys", () => {
  it("keeps the incremental cache's {buildId}/{key}.json convention", () => {
    expect(buildS3Key("b", "/")).toBe("b/index.json");
    expect(buildS3Key("b", "")).toBe("b/index.json");
    expect(buildS3Key("b", "/blog/post")).toBe("b/blog/post.json");
    expect(buildS3Key("b", "abc123")).toBe("b/abc123.json");
  });

  it("puts 'use cache' entries where no incremental key can land", () => {
    const key = useCacheS3Key("b", "f".repeat(64));
    expect(key).toBe(`b/_use-cache/${"f".repeat(64)}.entry`);
    // Even a route spelled like the use-cache key gets `.json` appended.
    expect(buildS3Key("b", `/_use-cache/${"f".repeat(64)}.entry`)).not.toBe(
      key,
    );
    expect(key.endsWith(".json")).toBe(false);
  });
});

describe("tag markers", () => {
  it("writes what markerFor applies locally", () => {
    for (const durations of [undefined, {}, { expire: 60 }]) {
      const update = markerUpdate(1000, durations);
      const local = markerFor(1000, durations);
      const written: Record<string, number> = {};
      for (const [name, value] of Object.entries(
        update.ExpressionAttributeValues!,
      )) {
        written[name.slice(1)] = Number(value.N);
      }
      expect(written).toEqual(local);
    }
    expect(markerFor(1000, { expire: 60 })).toEqual({
      staleAt: 1000,
      expiredAt: 61000,
    });
  });

  it("keeps an earlier expiredAt a profile with no expire leaves", () => {
    // The row keeps it (`SET staleAt` only), so an instance learning of the
    // second revalidation from the log has to keep it too.
    const first = markerFor(1000, { expire: 60 });
    const second = markerFor(2000, {});
    expect(mergeMarkers(first, second)).toEqual({
      staleAt: 2000,
      expiredAt: 61000,
    });
    expect(mergeMarkers(second, first)).toEqual({
      staleAt: 2000,
      expiredAt: 61000,
    });
    // A newer `expire` still replaces it.
    expect(mergeMarkers(first, markerFor(2000, { expire: 1 }))).toEqual({
      staleAt: 2000,
      expiredAt: 3000,
    });
  });

  it("judges an entry the way the incremental cache always has", () => {
    // Expired outright after creation.
    expect(markerState({ revalidatedAt: 20 }, 10, 30)).toBe("expired");
    // Revalidated before the entry was created: no effect.
    expect(markerState({ revalidatedAt: 5 }, 10, 30)).toBe("fresh");
    // A profile: stale now, expired once `expiredAt` passes.
    expect(markerState({ staleAt: 20, expiredAt: 50 }, 10, 30)).toBe("stale");
    expect(markerState({ staleAt: 20, expiredAt: 50 }, 10, 60)).toBe("expired");
    // `expire: 0`: stale and expired at once.
    expect(markerState({ staleAt: 20, expiredAt: 20 }, 10, 30)).toBe("expired");
    expect(markerState({}, 10, 30)).toBe("fresh");
  });
});

describe("TagMarkerTable", () => {
  const send = jest.fn();
  let table: TagMarkerTable;

  beforeEach(() => {
    send.mockReset();
    (DynamoDBClient as jest.Mock).mockImplementation(() => ({ send }));
    table = new TagMarkerTable(new DynamoDBClient({}), "tbl", "build");
  });

  it("writes the marker row under the build", async () => {
    send.mockResolvedValue({});
    await table.write("posts", 1000, { expire: 1 });
    const input = commandInput(send.mock.calls[0][0], UpdateItemCommand);
    expect(input).toEqual({
      TableName: "tbl",
      Key: { pk: { S: "build" }, sk: { S: "posts" } },
      UpdateExpression: "SET staleAt = :staleAt, expiredAt = :expiredAt",
      ExpressionAttributeValues: {
        ":staleAt": { N: "1000" },
        ":expiredAt": { N: "2000" },
      },
      ReturnValues: "ALL_NEW",
    });
  });

  it("reads markers in batches of 100 and parses them", async () => {
    send.mockImplementation((command: unknown) => {
      const { RequestItems } = commandInput(command, BatchGetItemCommand);
      const keys = RequestItems.tbl.Keys as { sk: { S: string } }[];
      return Promise.resolve({
        Responses: {
          tbl: keys
            .filter(({ sk }) => sk.S.endsWith("0"))
            .map(({ sk }) => ({ sk, revalidatedAt: { N: "7" } })),
        },
      });
    });
    const tags = Array.from({ length: 150 }, (_, i) => `t${i}`);
    const markers = await table.read([...tags, "t0"]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(markers.size).toBe(15);
    expect(markers.get("t10")).toEqual({
      revalidatedAt: 7,
      staleAt: undefined,
      expiredAt: undefined,
    });
  });

  it("keys a tag past the sort key limit by its hash, and reads it back as the tag", async () => {
    // `revalidatePath` on a long path: an implicit tag is as long as the path.
    const tag = `_N_T_/${"p".repeat(1100)}`;
    send.mockResolvedValue({});
    await table.write(tag, 1000, undefined);
    const written = commandInput(send.mock.calls[0][0], UpdateItemCommand);
    expect(written.Key.sk.S).toBe(hashedTag(tag));
    expect(hashedTag(tag)).toMatch(/^#[0-9a-f]{64}$/);

    send.mockReset();
    send.mockImplementation((command: unknown) => {
      const { RequestItems } = commandInput(command, BatchGetItemCommand);
      return Promise.resolve({
        Responses: {
          tbl: RequestItems.tbl.Keys.map(({ sk }: { sk: unknown }) => ({
            sk,
            revalidatedAt: { N: "7" },
          })),
        },
      });
    });
    const markers = await table.read([tag, "short"]);
    expect([...markers.keys()].sort()).toEqual(["short", tag].sort());
  });

  // A read-back after the write is eventually consistent, so it can return
  // the marker from before it: the writer tracks what the write returned.
  it("returns the row as the write left it", async () => {
    send.mockResolvedValueOnce({
      Attributes: {
        sk: { S: "posts" },
        revalidatedAt: { N: "5000" },
        staleAt: { N: "10" },
      },
    });
    expect(await table.write("posts", 5000, undefined)).toEqual({
      revalidatedAt: 5000,
      staleAt: 10,
      expiredAt: undefined,
    });
    send.mockResolvedValueOnce({});
    expect(await table.write("posts", 6000, undefined)).toBeUndefined();
  });

  it("asks again for unprocessed keys, and gives up after three tries", async () => {
    const unprocessed = {
      UnprocessedKeys: {
        tbl: { Keys: [{ pk: { S: "build" }, sk: { S: "a" } }] },
      },
    };
    send.mockResolvedValueOnce(unprocessed).mockResolvedValueOnce({
      Responses: { tbl: [{ sk: { S: "a" }, staleAt: { N: "3" } }] },
    });
    expect((await table.read(["a"])).get("a")?.staleAt).toBe(3);

    send.mockResolvedValue(unprocessed);
    await expect(table.read(["a"])).rejects.toThrow(/unread after retrying/);
  });
});

describe("RevalidationLog", () => {
  const send = jest.fn();
  let log: RevalidationLog;

  beforeEach(() => {
    send.mockReset();
    (DynamoDBClient as jest.Mock).mockImplementation(() => ({ send }));
    log = new RevalidationLog(new DynamoDBClient({}), "tbl", "build");
  });

  it("puts one row per revalidation under the build's log, with a TTL", async () => {
    send.mockResolvedValue({});
    const at = 1_727_000_000_123;
    await log.put("user#42", at, { staleAt: 5, expiredAt: 6 });
    expect(commandInput(send.mock.calls[0][0], PutItemCommand)).toEqual({
      TableName: "tbl",
      Item: {
        pk: { S: "build#log" },
        sk: { S: "001727000000123#user#42" },
        ttl: { N: String(Math.ceil((at + REVALIDATION_LOG_TTL_MS) / 1000)) },
        staleAt: { N: "5" },
        expiredAt: { N: "6" },
      },
      ConditionExpression: "attribute_not_exists(sk)",
    });
  });

  it("moves a row to the next millisecond rather than overwrite another revalidation", async () => {
    // `updateTag('x')` and `revalidateTag('x', 'max')` in one millisecond.
    const taken = Object.assign(new Error("taken"), {
      name: "ConditionalCheckFailedException",
    });
    send.mockRejectedValueOnce(taken).mockResolvedValueOnce({});
    await log.put("x", 1000.5, { revalidatedAt: 5 });
    expect(
      send.mock.calls.map(
        ([command]) => commandInput(command, PutItemCommand).Item.sk.S,
      ),
    ).toEqual(["000000000001000#x", "000000000001001#x"]);
  });

  it("gives up after a bounded number of collisions, and on other errors at once", async () => {
    const taken = Object.assign(new Error("taken"), {
      name: "ConditionalCheckFailedException",
    });
    send.mockRejectedValue(taken);
    await expect(log.put("x", 1000, {})).rejects.toBe(taken);
    expect(send).toHaveBeenCalledTimes(5);

    send.mockReset();
    const throttled = new Error("throttled");
    send.mockRejectedValue(throttled);
    await expect(log.put("x", 1000, {})).rejects.toBe(throttled);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("queries from a zero-padded cursor and parses the tag after it", async () => {
    send
      .mockResolvedValueOnce({
        Items: [
          { sk: { S: "000000000001000#a" }, revalidatedAt: { N: "7" } },
          { sk: { S: "not a log row" } },
        ],
        LastEvaluatedKey: { pk: { S: "build#log" }, sk: { S: "x" } },
      })
      .mockResolvedValueOnce({
        Items: [{ sk: { S: "000000000002000#user#42" }, staleAt: { N: "8" } }],
      });
    const { rows, truncated } = await log.query(999.5);

    const first = commandInput(send.mock.calls[0][0], QueryCommand);
    expect(first).toMatchObject({
      TableName: "tbl",
      KeyConditionExpression: "pk = :pk AND sk >= :since",
      ExpressionAttributeValues: {
        ":pk": { S: "build#log" },
        ":since": { S: "000000000000999" },
      },
    });
    expect(
      commandInput(send.mock.calls[1][0], QueryCommand).ExclusiveStartKey,
    ).toEqual({ pk: { S: "build#log" }, sk: { S: "x" } });
    expect(truncated).toBe(false);
    expect(rows).toEqual([
      {
        sk: "000000000001000#a",
        at: 1000,
        tag: "a",
        marker: { revalidatedAt: 7, staleAt: undefined, expiredAt: undefined },
      },
      {
        sk: "000000000002000#user#42",
        at: 2000,
        tag: "user#42",
        marker: { revalidatedAt: undefined, staleAt: 8, expiredAt: undefined },
      },
    ]);
  });

  it("hashes a tag too long for the sort key, carrying it in longTag", async () => {
    const tag = `_N_T_/${"p".repeat(1100)}`;
    send.mockResolvedValue({});
    await log.put(tag, 1000, { revalidatedAt: 5 });
    const { Item } = commandInput(send.mock.calls[0][0], PutItemCommand);
    expect(Item.sk.S).toBe(`000000000001000#${hashedTag(tag)}`);
    expect(Item.longTag).toEqual({ S: tag });

    send.mockReset();
    send.mockResolvedValueOnce({ Items: [{ ...Item }] });
    const { rows } = await log.query(0);
    expect(rows.map((row) => row.tag)).toEqual([tag]);
  });

  it("stops after its page bound and says so", async () => {
    send.mockResolvedValue({
      Items: [],
      LastEvaluatedKey: { pk: { S: "build#log" }, sk: { S: "x" } },
    });
    expect((await log.query(0)).truncated).toBe(true);
    expect(send).toHaveBeenCalledTimes(REVALIDATION_LOG_MAX_PAGES);
  });
});

describe("CacheBucket", () => {
  const send = jest.fn();
  let bucket: CacheBucket;

  beforeEach(() => {
    send.mockReset();
    (S3Client as jest.Mock).mockImplementation(() => ({ send }));
    bucket = new CacheBucket(new S3Client({}), "bkt");
  });

  it("reads an object as text", async () => {
    send.mockResolvedValue({
      Body: { transformToString: jest.fn().mockResolvedValue("{}") },
      ContentType: "application/json",
    });
    expect(await bucket.get("k")).toBe("{}");
    expect(commandInput(send.mock.calls[0][0], GetObjectCommand)).toEqual({
      Bucket: "bkt",
      Key: "k",
    });
  });

  it("answers a missing object or body with undefined, and throws the rest", async () => {
    send.mockRejectedValueOnce(
      new NoSuchKey({ message: "missing", $metadata: {} }),
    );
    expect(await bucket.get("k")).toBeUndefined();
    send.mockResolvedValueOnce({ Body: null });
    expect(await bucket.get("k")).toBeUndefined();
    send.mockRejectedValueOnce(new Error("AccessDenied"));
    await expect(bucket.get("k")).rejects.toThrow("AccessDenied");
  });

  it("writes JSON", async () => {
    send.mockResolvedValue({});
    await bucket.putJson("k", "{}");
    expect(commandInput(send.mock.calls[0][0], PutObjectCommand)).toEqual({
      Bucket: "bkt",
      Key: "k",
      Body: "{}",
      ContentType: "application/json; charset=utf-8",
    });
  });
});

describe("TrackedTagMarkers", () => {
  it("moves completeSince past what it forgets", async () => {
    let clock = 1_000_000;
    const later = markerClock() + 60_000;
    const rows: RevalidationLogRow[] = ["a", "b"].map((tag, i) => ({
      sk: `${String(clock).padStart(15, "0")}#${tag}`,
      at: clock,
      tag,
      marker: { revalidatedAt: later + i },
    }));
    const query = jest.fn(async () => ({ rows, truncated: false }));
    const markers = new TrackedTagMarkers({
      markers: { read: jest.fn() } as unknown as TagMarkerTable,
      log: { query } as unknown as RevalidationLog,
      refreshIntervalMs: 0,
      maxTrackedTags: 1,
      clock: () => clock,
    });
    // An entry store holding something older than every row.
    markers.judgeEntriesOf(() => 0);
    const start = markers.completeSince;
    expect(start).toBeLessThanOrEqual(markerClock());

    // Untracked tags' rows are known from the log alone, as far as they fit.
    await markers.refresh();
    expect(markers.state(["b"], later)).toBe("expired");
    // "a" was dropped for space, and with it what it knew.
    expect(markers.state(["a"], later)).toBe("fresh");
    expect(markers.completeSince).toBe(later);

    // Forgetting everything moves it to now, or past what it forgot: "b".
    clock += MAX_REVALIDATION_LOG_GAP_MS + 1;
    await markers.refresh();
    expect(markers.completeSince).toBe(later + 1);
  });

  it("moves completeSince past a row it lets go of with no entry held", async () => {
    const clock = 1_000_000;
    const revalidatedAt = markerClock() + 60_000;
    const markers = new TrackedTagMarkers({
      markers: { read: jest.fn() } as unknown as TagMarkerTable,
      log: {
        query: jest.fn(async () => ({
          rows: [
            {
              sk: `${String(clock).padStart(15, "0")}#posts`,
              at: clock,
              tag: "posts",
              marker: { revalidatedAt },
            },
          ],
          truncated: false,
        })),
      } as unknown as RevalidationLog,
      refreshIntervalMs: 0,
      clock: () => clock,
    });
    markers.judgeEntriesOf(() => Infinity);
    await markers.refresh();
    // An entry whose generation started before the revalidation, stored once
    // the row is gone, is older than `completeSince`, and so read first.
    expect(markers.state(["posts"], revalidatedAt - 1)).toBe("fresh");
    expect(markers.completeSince).toBe(revalidatedAt);
  });

  it("prunes a profile's row, and moves completeSince to its expiredAt once past", async () => {
    const clock = 1_000_000;
    const staleAt = markerClock() + 1000;
    const expiredAt = staleAt + 60_000;
    const markers = new TrackedTagMarkers({
      markers: { read: jest.fn() } as unknown as TagMarkerTable,
      log: {
        query: jest.fn(async () => ({
          rows: [
            {
              sk: `${String(clock).padStart(15, "0")}#posts`,
              at: clock,
              tag: "posts",
              marker: { staleAt, expiredAt },
            },
          ],
          truncated: false,
        })),
      } as unknown as RevalidationLog,
      refreshIntervalMs: 0,
      clock: () => clock,
    });
    markers.judgeEntriesOf(() => staleAt + 1);
    await markers.refresh();
    expect(markers.state(["posts"], staleAt - 1)).toBe("fresh");
    expect(markers.completeSince).toBe(staleAt);

    const now = jest
      .spyOn(performance, "now")
      .mockReturnValue(expiredAt - performance.timeOrigin);
    try {
      expect(markers.completeSince).toBe(expiredAt);
    } finally {
      now.mockRestore();
    }
  });

  it("merges future expiredAts past its bound without moving completeSince early", async () => {
    const at = markerClock();
    const expiries = new Map([
      ["a", at + 60_000],
      ["b", at + 60_010],
      ["c", at + 120_000],
    ]);
    const markers = new TrackedTagMarkers({
      markers: {
        read: jest.fn(
          async (tags: string[]) =>
            new Map<string, TagMarker>(
              tags.map((tag) => [
                tag,
                { staleAt: at - 1000, expiredAt: expiries.get(tag) },
              ]),
            ),
        ),
      } as unknown as TagMarkerTable,
      log: { query: jest.fn() } as unknown as RevalidationLog,
      maxTrackedTags: 1,
    });
    const start = markers.completeSince;
    // "a", then "b", dropped for space: two expiredAts past a bound of one.
    for (const tag of ["a", "b", "c"]) {
      await markers.ensure([tag]);
    }
    expect(markers.completeSince).toBe(start);

    const now = jest.spyOn(performance, "now");
    try {
      now.mockReturnValue(at + 59_999 - performance.timeOrigin);
      expect(markers.completeSince).toBe(start);
      // Merged: "b"'s from "a"'s, 10 ms early.
      now.mockReturnValue(at + 60_000 - performance.timeOrigin);
      expect(markers.completeSince).toBe(at + 60_010);
    } finally {
      now.mockRestore();
    }
  });

  it("catches up only for an entry store, and not when every check asks anyway", async () => {
    let clock = 1_000_000;
    const instance = (refreshIntervalMs: number) => {
      const query = jest.fn(async () => ({ rows: [], truncated: false }));
      const markers = new TrackedTagMarkers({
        markers: { read: jest.fn() } as unknown as TagMarkerTable,
        log: { query } as unknown as RevalidationLog,
        refreshIntervalMs,
        clock: () => clock,
      });
      return { markers, query };
    };
    const noStore = instance(1000);
    const everyCheck = instance(0);
    everyCheck.markers.judgeEntriesOf(() => Infinity);
    const store = instance(1000);
    store.markers.judgeEntriesOf(() => Infinity);
    clock += 60_000;
    for (const { markers } of [noStore, everyCheck, store]) {
      expect(markers.behind).toBe(true);
      await markers.catchUp();
    }
    expect(noStore.query).not.toHaveBeenCalled();
    expect(everyCheck.query).not.toHaveBeenCalled();
    expect(store.query).toHaveBeenCalledTimes(1);
  });

  it("moves completeSince to a dropped marker's future expiredAt only once it is past", async () => {
    const at = markerClock();
    const read = jest.fn(
      async (tags: string[]) =>
        new Map<string, TagMarker>(
          tags.map((tag) => [
            tag,
            { staleAt: at - 1000, expiredAt: at + 60_000 },
          ]),
        ),
    );
    const markers = new TrackedTagMarkers({
      markers: { read } as unknown as TagMarkerTable,
      log: { query: jest.fn() } as unknown as RevalidationLog,
      maxTrackedTags: 1,
    });
    const start = markers.completeSince;
    await markers.ensure(["a"]);
    // "a" is dropped for space: a year-long `expire` would otherwise keep
    // every entry reading its markers first for as long.
    await markers.ensure(["b"]);
    expect(markers.completeSince).toBe(start);

    const clock = jest
      .spyOn(performance, "now")
      .mockReturnValue(at + 60_001 - performance.timeOrigin);
    try {
      expect(markers.completeSince).toBe(at + 60_000);
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps only the log rows that could apply to an entry held", async () => {
    let clock = 1_000_000;
    const later = markerClock() + 60_000;
    const rows: RevalidationLogRow[] = ["old", "new"].map((tag, i) => ({
      sk: `${String(clock).padStart(15, "0")}#${tag}`,
      at: clock,
      tag,
      marker: { revalidatedAt: i === 0 ? 1 : later },
    }));
    const markers = new TrackedTagMarkers({
      markers: { read: jest.fn() } as unknown as TagMarkerTable,
      log: {
        query: jest.fn(async () => ({ rows, truncated: false })),
      } as unknown as RevalidationLog,
      refreshIntervalMs: 0,
      maxTrackedTags: 1,
      clock: () => clock,
    });
    let oldest = 2;
    markers.judgeEntriesOf(() => oldest);
    const start = markers.completeSince;

    // "old" can expire nothing held, so it takes no room, and "new" is
    // kept without dropping anything for space.
    await markers.refresh();
    expect(markers.state(["new"], later - 1)).toBe("expired");
    expect(markers.completeSince).toBe(start);

    // Once every entry held is newer than it, "new" goes too, taking
    // `completeSince` no further than the oldest entry held.
    oldest = later;
    clock += 1000;
    await markers.refresh();
    expect(markers.state(["new"], later - 1)).toBe("fresh");
    expect(markers.completeSince).toBe(later);
  });

  it("waits for a fresh query rather than one started before a freeze", async () => {
    let clock = 1_000_000;
    const queries: (() => void)[] = [];
    const query = jest.fn(
      () =>
        new Promise<{ rows: RevalidationLogRow[]; truncated: boolean }>(
          (resolve) =>
            queries.push(() => resolve({ rows: [], truncated: false })),
        ),
    );
    const markers = new TrackedTagMarkers({
      markers: { read: jest.fn() } as unknown as TagMarkerTable,
      log: { query } as unknown as RevalidationLog,
      refreshIntervalMs: 1000,
      clock: () => clock,
    });
    markers.judgeEntriesOf(() => Infinity);
    clock += 1000;
    // Started, not waited for, and then the sandbox froze.
    void markers.refresh();
    clock += 60_000;
    expect(markers.behind).toBe(true);

    let caughtUp = false;
    const catchUp = markers.catchUp().then(() => (caughtUp = true));
    queries.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(caughtUp).toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
    queries.shift()!();
    await catchUp;
    expect(markers.behind).toBe(false);
  });

  it("does not skip a row for an untracked tag that its first read missed", async () => {
    // The writer puts the log row and the marker at the same time, and the
    // marker read is eventually consistent: `refresh` can see the row, then
    // `ensure` read the marker from before it. Marked applied while the tag
    // was untracked, the row was skipped by every query the lookback returned
    // it to, and the instance served the stale entry until the rolling re-read.
    let clock = 1_000_000;
    const revalidatedAt = 999_000;
    const row: RevalidationLogRow = {
      sk: `${String(clock).padStart(15, "0")}#posts`,
      at: clock,
      tag: "posts",
      marker: { revalidatedAt },
    };
    const query = jest.fn(async (since: number) => ({
      rows: [row].filter((r) => r.at >= since),
      truncated: false,
    }));
    // A replica that has not seen the write yet.
    const read = jest.fn(async () => new Map<string, TagMarker>());
    const markers = new TrackedTagMarkers({
      markers: { read } as unknown as TagMarkerTable,
      log: { query } as unknown as RevalidationLog,
      refreshIntervalMs: 1000,
      clock: () => clock,
      random: () => 0,
    });
    markers.judgeEntriesOf(() => 0);
    await markers.ensure(["other"]);

    clock += 1000;
    await markers.refresh();
    // The row seen before the read is applied to what the read found.
    await markers.ensure(["posts"]);
    expect(markers.get("posts")).toEqual({ revalidatedAt });

    clock += 1000;
    await markers.refresh();
    expect(query).toHaveBeenCalledTimes(2);
    expect(markers.get("posts")).toEqual({ revalidatedAt });
    // Only the one read each tag's first use costs.
    expect(read).toHaveBeenCalledTimes(2);
  });
});

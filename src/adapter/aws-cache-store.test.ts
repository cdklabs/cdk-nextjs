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
  TAG_REFRESH_GRACE_MS,
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
  it("never counts a render the runtime caught up as behind", async () => {
    let clock = 1_000_000;
    const markers = new TrackedTagMarkers({
      markers: { read: jest.fn() } as unknown as TagMarkerTable,
      log: { query: jest.fn() } as unknown as RevalidationLog,
      refreshIntervalMs: 1000,
      clock: () => clock,
    });
    // Just short of the line as the request came in: `catchUp` lets it go.
    clock += 1000 + TAG_REFRESH_GRACE_MS;
    expect(markers.behind).toBe(false);
    await markers.catchUp(async () => {
      // However long the render takes, its lookups never wait: waiting is
      // what the catch-up before it was for.
      clock += 100;
      expect(markers.behind).toBe(true);
      expect(markers.behindInRender).toBe(false);
      clock += 60_000;
      expect(markers.behindInRender).toBe(false);
    });
    // Outside it - a route handler alongside, in a container - it waits.
    expect(markers.behindInRender).toBe(true);
  });

  it("gives a render no grace when catchUp, holding nothing, did not catch up", async () => {
    let clock = 1_000_000;
    let held = false;
    const markers = new TrackedTagMarkers({
      markers: { read: jest.fn() } as unknown as TagMarkerTable,
      log: {
        query: jest.fn(async () => ({ rows: [], truncated: false })),
      } as unknown as RevalidationLog,
      refreshIntervalMs: 1000,
      clock: () => clock,
    });
    markers.judgeEntriesOf(
      () => (held ? 0 : Infinity),
      () => held,
    );
    clock += 1000 + TAG_REFRESH_GRACE_MS + 100;
    await markers.catchUp(async () => {
      // Another request stores an entry before this render's first lookup.
      held = true;
      expect(markers.behindInRender).toBe(true);
    });
  });

  it("starts a refresh for a page that is not behind, without waiting for it", async () => {
    let clock = 1_000_000;
    let release!: () => void;
    const query = jest.fn(
      () =>
        new Promise<{ rows: RevalidationLogRow[]; truncated: boolean }>(
          (resolve) =>
            (release = () => resolve({ rows: [], truncated: false })),
        ),
    );
    const markers = new TrackedTagMarkers({
      markers: { read: jest.fn() } as unknown as TagMarkerTable,
      log: { query } as unknown as RevalidationLog,
      refreshIntervalMs: 1000,
      clock: () => clock,
    });
    markers.judgeEntriesOf(() => 0);
    clock += 1000;
    expect(markers.behind).toBe(false);
    // A page that reads no cache still keeps the instance current.
    await expect(markers.catchUp(async () => "page")).resolves.toBe("page");
    expect(query).toHaveBeenCalledTimes(1);
    release();
  });

  it("catches up on the log without waiting for the rolling re-read", async () => {
    let clock = 1_000_000;
    let release!: () => void;
    const read = jest.fn(async (tags: string[]) => {
      if (read.mock.calls.length > 1) {
        await new Promise<void>((resolve) => (release = resolve));
      }
      return new Map<string, TagMarker>(tags.map((tag) => [tag, {}]));
    });
    const markers = new TrackedTagMarkers({
      markers: { read } as unknown as TagMarkerTable,
      log: {
        query: jest.fn(async () => ({ rows: [], truncated: false })),
      } as unknown as RevalidationLog,
      refreshIntervalMs: 1000,
      resyncIntervalMs: 1000,
      random: () => 0,
      clock: () => clock,
    });
    markers.judgeEntriesOf(() => 0);
    await markers.ensure(["posts"]);
    // Due for its re-read, and behind, as after a quiet spell.
    clock += 5000;
    expect(markers.behind).toBe(true);
    let rendered = false;
    await markers.catchUp(async () => (rendered = true));
    // A throttled `BatchGetItem` would otherwise hold the page.
    expect(rendered).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);

    // Nor does a lookup of the tracked tag wait on it.
    let ensured = false;
    void markers.ensure(["posts"]).then(() => (ensured = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(ensured).toBe(true);

    // Still in flight an interval later: not read a second time meanwhile.
    clock += 1000;
    await markers.refresh();
    expect(read).toHaveBeenCalledTimes(2);
    release();
  });

  it("gives a route handler, which no catch-up precedes, no grace more", async () => {
    let clock = 1_000_000;
    const markers = new TrackedTagMarkers({
      markers: { read: jest.fn() } as unknown as TagMarkerTable,
      log: { query: jest.fn() } as unknown as RevalidationLog,
      refreshIntervalMs: 1000,
      clock: () => clock,
    });
    clock += 1000 + TAG_REFRESH_GRACE_MS + 100;
    expect(markers.behindInRender).toBe(true);
  });

  it("reads again only once, however many forgets land meanwhile", async () => {
    let clock = 1_000_000;
    const releases: (() => void)[] = [];
    const read = jest.fn(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return new Map<string, TagMarker>([["posts", { revalidatedAt: 1 }]]);
    });
    const markers = new TrackedTagMarkers({
      markers: { read } as unknown as TagMarkerTable,
      log: {
        query: jest.fn(async () => ({ rows: [], truncated: false })),
      } as unknown as RevalidationLog,
      refreshIntervalMs: 0,
      clock: () => clock,
    });
    markers.judgeEntriesOf(() => 0);
    const forget = async () => {
      clock += MAX_REVALIDATION_LOG_GAP_MS + 1;
      await markers.refresh();
    };
    const ensuring = markers.ensure(["posts"]);
    await forget();
    releases.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    await forget();
    releases.shift()!();
    await ensuring;
    // A truncated log forgets on every query: waiting for a read no forget
    // overtook would keep the requests waiting on this one for as long.
    expect(read).toHaveBeenCalledTimes(2);
    expect(markers.get("posts")).toEqual({ revalidatedAt: 1 });
  });

  it("reads again what a read from before a forget found", async () => {
    let clock = 1_000_000;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let revalidatedAt: number | undefined;
    const read = jest.fn(async () => {
      await held;
      return new Map<string, TagMarker>(
        revalidatedAt === undefined ? [] : [["posts", { revalidatedAt }]],
      );
    });
    const markers = new TrackedTagMarkers({
      markers: { read } as unknown as TagMarkerTable,
      log: {
        query: jest.fn(async () => ({ rows: [], truncated: false })),
      } as unknown as RevalidationLog,
      refreshIntervalMs: 0,
      clock: () => clock,
    });
    markers.judgeEntriesOf(() => 0);
    // A background read in flight as the sandbox froze, past the log's TTL.
    const ensuring = markers.ensure(["posts"]);
    clock += MAX_REVALIDATION_LOG_GAP_MS + 1;
    await markers.refresh();

    // Read again once the stale read returns: tracked, its marker would
    // vouch for every entry with the tag, revalidated during the freeze or
    // not; untracked, the request waiting on it would judge by nothing.
    revalidatedAt = markerClock();
    release();
    await ensuring;
    expect(read).toHaveBeenCalledTimes(2);
    expect(markers.get("posts")).toEqual({ revalidatedAt });
  });

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

  it("queues a pruned row's future expiredAt once, however often the lookback returns it", async () => {
    let clock = 1_000_000;
    const staleAt = markerClock() + 1000;
    const markers = new TrackedTagMarkers({
      markers: { read: jest.fn() } as unknown as TagMarkerTable,
      log: {
        query: jest.fn(async () => ({
          rows: [
            {
              sk: `${String(1_000_000).padStart(15, "0")}#posts`,
              at: 1_000_000,
              tag: "posts",
              marker: { staleAt, expiredAt: staleAt + 60_000 },
            },
          ],
          truncated: false,
        })),
      } as unknown as RevalidationLog,
      refreshIntervalMs: 0,
      clock: () => clock,
    });
    markers.judgeEntriesOf(() => staleAt + 1);
    for (let i = 0; i < 3; i++) {
      await markers.refresh();
      clock += 1000;
    }
    // Pruned rows are not marked applied, so each query applies it again.
    expect(
      (markers as unknown as { laterFloors: unknown[] }).laterFloors,
    ).toHaveLength(1);
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

  it("does not join a near expiredAt to far ones past its bound", async () => {
    const at = markerClock();
    const year = 365 * 24 * 60 * 60 * 1000;
    const expiries = new Map([
      ["a", at + year],
      ["b", at + year + 10],
      ["c", at + 60_000],
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
      maxTrackedTags: 2,
    });
    for (const tag of ["a", "b", "c", "d", "e"]) {
      await markers.ensure([tag]);
    }
    const now = jest
      .spyOn(performance, "now")
      .mockReturnValue(at + 60_000 - performance.timeOrigin);
    try {
      // "a" and "b" are merged, not "c" into "a": `completeSince` a year
      // early would have every held entry read its markers first until then.
      expect(markers.completeSince).toBe(at + 60_000);
    } finally {
      now.mockRestore();
    }
  });

  it("merges the closest future expiredAts past its bound", async () => {
    const at = markerClock();
    const expiries = new Map([
      ["a", at + 60_000],
      ["b", at + 120_000],
      ["c", at + 60_010],
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
      maxTrackedTags: 2,
    });
    // "a", "b", then "c" dropped for space: three expiredAts past a bound of
    // two, and "c" is 10 ms from "a".
    for (const tag of ["a", "b", "c", "d", "e"]) {
      await markers.ensure([tag]);
    }
    const start = markers.completeSince;

    const now = jest.spyOn(performance, "now");
    try {
      now.mockReturnValue(at + 59_999 - performance.timeOrigin);
      expect(markers.completeSince).toBe(start);
      now.mockReturnValue(at + 60_000 - performance.timeOrigin);
      expect(markers.completeSince).toBe(at + 60_010);
      now.mockReturnValue(at + 119_999 - performance.timeOrigin);
      expect(markers.completeSince).toBe(at + 60_010);
      now.mockReturnValue(at + 120_000 - performance.timeOrigin);
      expect(markers.completeSince).toBe(at + 120_000);
    } finally {
      now.mockRestore();
    }
  });

  it("catches up only for an entry store holding entries, and not when every check asks anyway", async () => {
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
    // A store, but holding nothing a refresh could expire.
    const emptyStore = instance(1000);
    emptyStore.markers.judgeEntriesOf(() => Infinity);
    const store = instance(1000);
    store.markers.judgeEntriesOf(() => 0);
    clock += 60_000;
    for (const { markers } of [noStore, everyCheck, emptyStore, store]) {
      expect(markers.behind).toBe(true);
      await markers.catchUp(async () => {});
    }
    expect(noStore.query).not.toHaveBeenCalled();
    expect(everyCheck.query).not.toHaveBeenCalled();
    expect(emptyStore.query).not.toHaveBeenCalled();
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

  it("scans the entry stores once a minute, pruning only when the oldest moves", async () => {
    let clock = 1_000_000;
    const later = markerClock() + 60_000;
    const rows: RevalidationLogRow[] = [
      {
        sk: `${String(clock).padStart(15, "0")}#new`,
        at: clock,
        tag: "new",
        marker: { revalidatedAt: later },
      },
    ];
    const markers = new TrackedTagMarkers({
      markers: { read: jest.fn() } as unknown as TagMarkerTable,
      // The row leaves the lookback after the first query: only the prune
      // can let it go.
      log: {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rows, truncated: false })
          .mockResolvedValue({ rows: [], truncated: false }),
      } as unknown as RevalidationLog,
      refreshIntervalMs: 0,
      clock: () => clock,
    });
    let bound = 2;
    let exact = 2;
    const oldest = jest.fn((scan: boolean) => (scan ? exact : bound));
    markers.judgeEntriesOf(oldest);
    const prune = jest.spyOn(
      markers as unknown as { pruneLogged: (oldest: number) => void },
      "pruneLogged",
    );

    await markers.refresh();
    expect(oldest).toHaveBeenLastCalledWith(true);
    expect(prune).toHaveBeenCalledTimes(1);

    // Within the minute: the bound, and no prune while it stays put.
    clock += 1000;
    exact = later;
    await markers.refresh();
    expect(oldest).toHaveBeenLastCalledWith(false);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(markers.state(["new"], later - 1)).toBe("expired");

    // The minute's scan finds every entry newer than the row: it goes.
    clock += 60_000;
    await markers.refresh();
    expect(oldest).toHaveBeenLastCalledWith(true);
    expect(prune).toHaveBeenCalledTimes(2);
    expect(markers.state(["new"], later - 1)).toBe("fresh");
    expect(markers.completeSince).toBe(later);

    // An entry set since moves the bound back: nothing to prune.
    clock += 1000;
    bound = 1;
    await markers.refresh();
    expect(prune).toHaveBeenCalledTimes(2);
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
      canFreeze: true,
    });
    markers.judgeEntriesOf(() => 0);
    clock += 1000;
    // Started, not waited for, and then the sandbox froze.
    void markers.refresh();
    clock += 60_000;
    expect(markers.behind).toBe(true);

    let caughtUp = false;
    const catchUp = markers
      .catchUp(async () => {})
      .then(() => (caughtUp = true));
    queries.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(caughtUp).toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
    queries.shift()!();
    await catchUp;
    expect(markers.behind).toBe(false);
  });

  describe("with a refresh in flight", () => {
    let clock: number;
    beforeEach(() => {
      clock = 1_000_000;
      jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    });
    afterEach(() => jest.useRealTimers());

    /** Move the clock and the timers on together: no freeze. */
    const run = (ms: number) => {
      for (let step = 0; step < ms; step += 250) {
        clock += 250;
        jest.advanceTimersByTime(250);
      }
    };
    const instance = (fails = false, canFreeze = true) => {
      const queries: (() => void)[] = [];
      const query = jest.fn(
        () =>
          new Promise<{ rows: RevalidationLogRow[]; truncated: boolean }>(
            (resolve, reject) =>
              queries.push(() =>
                fails
                  ? reject(new Error("throttled"))
                  : resolve({ rows: [], truncated: false }),
              ),
          ),
      );
      const markers = new TrackedTagMarkers({
        markers: { read: jest.fn() } as unknown as TagMarkerTable,
        log: { query } as unknown as RevalidationLog,
        refreshIntervalMs: 1000,
        clock: () => clock,
        canFreeze,
      });
      markers.judgeEntriesOf(() => 0);
      return { markers, query, queries };
    };

    it("waits for a fresh query after a freeze, even once the late tick has run", async () => {
      const { markers, query, queries } = instance();
      clock += 1000;
      void markers.refresh();
      clock += 60_000;
      // After the thaw the overdue tick can run before any request does.
      jest.advanceTimersByTime(250);

      let caughtUp = false;
      const catchUp = markers
        .catchUp(async () => {})
        .then(() => (caughtUp = true));
      queries.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
      // What the first query knew predates the freeze.
      expect(markers.behind).toBe(true);
      expect(caughtUp).toBe(false);
      expect(query).toHaveBeenCalledTimes(2);
      queries.shift()!();
      await catchUp;
      expect(markers.behind).toBe(false);
    });

    it("in a container, which is never frozen, waits only for the query in flight", async () => {
      const { markers, query, queries } = instance(false, false);
      clock += 1000;
      void markers.refresh();
      // A long stall, not a freeze: no timer to tell them apart, none needed.
      clock += 60_000;

      const catchUp = markers.catchUp(async () => {});
      queries.shift()!();
      await catchUp;
      expect(query).toHaveBeenCalledTimes(1);
      expect(markers.behind).toBe(false);
    });

    it("is caught up once the catch-up's slow query returns, the process running throughout", async () => {
      for (const fails of [false, true]) {
        const { markers, queries } = instance(fails);
        clock += 60_000;
        expect(markers.behind).toBe(true);
        const catchUp = markers.catchUp(async () => {});
        run(3000);
        queries.shift()!();
        await catchUp;
        // Or the first `'use cache'` lookup would wait for another query,
        // inside the render: one request, two waits.
        expect(markers.behind).toBe(false);
      }
    });

    it("waits only for a slow query in flight, the process running throughout", async () => {
      const { markers, query, queries } = instance();
      clock += 60_000;
      const first = markers.catchUp(async () => {});
      run(2500);
      // Past the grace into the query, but the query is as fresh as any.
      let caughtUp = false;
      const second = markers
        .catchUp(async () => {})
        .then(() => (caughtUp = true));
      queries.shift()!();
      await first;
      await new Promise((resolve) => setImmediate(resolve));
      expect(caughtUp).toBe(true);
      await second;
      expect(query).toHaveBeenCalledTimes(1);
    });
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

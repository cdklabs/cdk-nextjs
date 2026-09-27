/* eslint-disable import/no-extraneous-dependencies */
jest.mock("@aws-sdk/client-s3");
jest.mock("@aws-sdk/client-dynamodb");

import {
  AttributeValue,
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
import type {
  CacheEntry,
  CacheHandler,
} from "next/dist/server/lib/cache-handlers/types";
import {
  CacheBucket,
  RevalidationLog,
  TagMarkerTable,
} from "./aws-cache-store";
import { readStream, UseCacheTagManifest } from "./use-cache-common";
import { createDefaultUseCacheHandler } from "./use-cache-default-handler";
import { createRemoteUseCacheHandler } from "./use-cache-remote-handler";

/** The input an automocked SDK command was constructed with. */
const commandInput = (command: unknown, type: unknown) => {
  const mock = type as jest.Mock;
  return mock.mock.calls[mock.mock.instances.indexOf(command)][0];
};

/**
 * S3 as a map. Every "instance" in these tests is a separate handler over the
 * same map, which is what the cache bucket is to separate Lambda instances.
 */
const objects = new Map<string, string>();
const s3Send = jest.fn(async (command: unknown) => {
  if (command instanceof PutObjectCommand) {
    const { Key, Body } = commandInput(command, PutObjectCommand);
    objects.set(Key, Body);
    return {};
  }
  if (command instanceof GetObjectCommand) {
    const { Key } = commandInput(command, GetObjectCommand);
    const body = objects.get(Key);
    if (body === undefined) {
      throw new NoSuchKey({ message: "NoSuchKey", $metadata: {} });
    }
    return {
      Body: { transformToString: async () => body },
      ContentType: "application/json; charset=utf-8",
    };
  }
  throw new Error("unexpected S3 command");
});

/** The revalidation table's marker rows, as a map. */
const rows = new Map<string, Record<string, AttributeValue>>();
/** Its revalidation log rows, by sort key. */
const logRows = new Map<string, Record<string, AttributeValue>>();
const dynamoSend = jest.fn(async (command: unknown) => {
  if (command instanceof UpdateItemCommand) {
    const { Key, ExpressionAttributeValues } = commandInput(
      command,
      UpdateItemCommand,
    );
    const row: Record<string, AttributeValue> = rows.get(Key.sk.S) ?? {
      sk: Key.sk,
    };
    const names: Record<string, string> = {
      ":timestamp": "revalidatedAt",
      ":stale": "staleAt",
      ":expired": "expiredAt",
    };
    for (const [name, value] of Object.entries(ExpressionAttributeValues)) {
      row[names[name]] = value as AttributeValue;
    }
    rows.set(Key.sk.S, row);
    return {};
  }
  if (command instanceof BatchGetItemCommand) {
    const { RequestItems } = commandInput(command, BatchGetItemCommand);
    const [[table, { Keys }]] = Object.entries(RequestItems) as [
      string,
      { Keys: { sk: { S: string } }[] },
    ][];
    return {
      Responses: {
        [table]: Keys.map(({ sk }) => rows.get(sk.S)).filter(Boolean),
      },
    };
  }
  if (command instanceof PutItemCommand) {
    const { Item } = commandInput(command, PutItemCommand);
    logRows.set(Item.sk.S, Item);
    return {};
  }
  if (command instanceof QueryCommand) {
    const { ExpressionAttributeValues } = commandInput(command, QueryCommand);
    const since = ExpressionAttributeValues[":since"].S as string;
    return {
      Items: Array.from(logRows.keys())
        .filter((sk) => sk >= since)
        .sort()
        .map((sk) => logRows.get(sk)),
    };
  }
  throw new Error("unexpected DynamoDB command");
});

(S3Client as jest.Mock).mockImplementation(() => ({ send: s3Send }));
(DynamoDBClient as jest.Mock).mockImplementation(() => ({ send: dynamoSend }));

const s3Calls = (type: unknown) =>
  s3Send.mock.calls.filter(([command]) => command instanceof (type as never))
    .length;
const dynamoCalls = (type: unknown) =>
  dynamoSend.mock.calls.filter(
    ([command]) => command instanceof (type as never),
  ).length;

/** One compute instance's view of the shared table. */
function tagManifest(refreshIntervalMs = 0) {
  return new UseCacheTagManifest({
    markers: new TagMarkerTable(new DynamoDBClient({}), "table", "build"),
    log: new RevalidationLog(new DynamoDBClient({}), "table", "build"),
    refreshIntervalMs,
  });
}

function bucket() {
  return new CacheBucket(new S3Client({}), "bucket");
}

function remoteInstance(tags = tagManifest()) {
  return createRemoteUseCacheHandler({
    bucket: bucket(),
    buildId: "build",
    tags,
  });
}

function defaultInstance(tags = tagManifest()) {
  return createDefaultUseCacheHandler({ tags });
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function entry(text: string, extra: Partial<CacheEntry> = {}): CacheEntry {
  return {
    value: streamOf(text),
    tags: ["posts"],
    stale: 300,
    timestamp: performance.timeOrigin + performance.now(),
    expire: 3600,
    revalidate: 900,
    ...extra,
  };
}

async function textOf(result: CacheEntry | undefined) {
  return result
    ? new TextDecoder().decode(await readStream(result.value))
    : undefined;
}

/** A request's worth of what Next.js does before reading an entry. */
async function read(handler: CacheHandler, key: string) {
  await handler.refreshTags();
  return textOf(await handler.get(key, []));
}

beforeEach(() => {
  objects.clear();
  rows.clear();
  logRows.clear();
});

describe("cacheHandlers.remote", () => {
  it("answers every instance from the entry any one of them stored", async () => {
    const a = remoteInstance();
    const b = remoteInstance();

    await a.set("k", Promise.resolve(entry("from-a")));

    expect(await read(b, "k")).toBe("from-a");
    expect(Array.from(objects.keys())).toEqual([
      expect.stringMatching(/^build\/_use-cache\/[0-9a-f]{64}\.entry$/),
    ]);
  });

  it("serves a repeat read from memory", async () => {
    const b = remoteInstance();
    await remoteInstance().set("k", Promise.resolve(entry("v")));
    await read(b, "k");
    s3Send.mockClear();
    expect(await read(b, "k")).toBe("v");
    expect(s3Calls(GetObjectCommand)).toBe(0);
  });

  it("expires the entry on every instance when a tag is revalidated", async () => {
    const a = remoteInstance();
    const b = remoteInstance();
    await a.set(
      "k",
      Promise.resolve(entry("old", { timestamp: Date.now() - 1000 })),
    );
    expect(await read(a, "k")).toBe("old");
    expect(await read(b, "k")).toBe("old");

    await a.updateTags(["posts"]);

    expect(await read(a, "k")).toBeUndefined();
    expect(await read(b, "k")).toBeUndefined();
    // A fresh instance reading the stale object from S3 misses too.
    expect(await read(remoteInstance(), "k")).toBeUndefined();
  });

  it("serves a profile-revalidated entry stale, for Next.js to regenerate", async () => {
    const a = remoteInstance();
    await a.set(
      "k",
      Promise.resolve(entry("old", { timestamp: Date.now() - 1000 })),
    );
    await a.updateTags(["posts"], { expire: 3600 });

    const b = remoteInstance();
    await b.refreshTags();
    const result = await b.get("k", []);
    expect(result?.revalidate).toBe(-1);
    expect(await textOf(result)).toBe("old");
  });

  it("picks up another instance's regenerated entry once its own is stale", async () => {
    const a = remoteInstance();
    const b = remoteInstance();
    const past = performance.timeOrigin + performance.now() - 10_000;
    await a.set(
      "k",
      Promise.resolve(entry("v1", { timestamp: past, revalidate: 1 })),
    );
    expect(await read(b, "k")).toBe("v1");

    await a.set("k", Promise.resolve(entry("v2")));
    // `b`'s memory copy is past `revalidate`, so S3 is asked for a newer one.
    expect(await read(b, "k")).toBe("v2");
  });

  it("does not serve an entry past its expire", async () => {
    const past = performance.timeOrigin + performance.now() - 10_000;
    await remoteInstance().set(
      "k",
      Promise.resolve(
        entry("v", { timestamp: past, revalidate: 1, expire: 2 }),
      ),
    );
    expect(await read(remoteInstance(), "k")).toBeUndefined();
  });

  it("makes a get wait for a pending set of the same key", async () => {
    const a = remoteInstance();
    let resolve: (value: CacheEntry) => void = () => {};
    const set = a.set("k", new Promise((r) => (resolve = r)));
    const get = a.get("k", []);
    resolve(entry("v"));
    expect(await textOf(await get)).toBe("v");
    await set;
  });

  it("stores nothing from a stream that errors", async () => {
    const a = remoteInstance();
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.error(new Error("render failed"));
      },
    });
    await a.set("k", Promise.resolve({ ...entry(""), value: failing }));
    expect(objects.size).toBe(0);
    expect(await read(a, "k")).toBeUndefined();
  });

  it("does not store an entry Next.js regenerates on every read", async () => {
    const a = remoteInstance();
    await a.set("k", Promise.resolve(entry("v", { expire: 0 })));
    expect(objects.size).toBe(0);
    expect(await read(a, "k")).toBeUndefined();
  });

  it("never serves an object stored for another key", async () => {
    const a = remoteInstance();
    await a.set("k", Promise.resolve(entry("v")));
    const [key] = Array.from(objects.keys());
    objects.set(key, objects.get(key)!.replace('"key":"k"', '"key":"other"'));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(await read(remoteInstance(), "k")).toBeUndefined();
    warn.mockRestore();
  });

  it("keeps working from memory when S3 fails", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    s3Send.mockRejectedValueOnce(new Error("SlowDown"));
    const a = remoteInstance();
    await a.set("k", Promise.resolve(entry("v")));
    expect(await read(a, "k")).toBe("v");
    s3Send.mockRejectedValueOnce(new Error("SlowDown"));
    expect(await read(remoteInstance(), "k")).toBeUndefined();
    error.mockRestore();
  });

  it("is memory-only without a bucket", async () => {
    const a = createRemoteUseCacheHandler({
      bucket: null,
      buildId: "build",
      tags: tagManifest(),
    });
    await a.set("k", Promise.resolve(entry("v")));
    expect(await read(a, "k")).toBe("v");
    expect(s3Send).not.toHaveBeenCalled();
  });

  it("reads an S3 entry's tags before trusting it, once per instance", async () => {
    await remoteInstance().set("k", Promise.resolve(entry("v")));
    const b = remoteInstance(tagManifest(60_000));
    dynamoSend.mockClear();
    await read(b, "k");
    await read(b, "k");
    expect(dynamoCalls(BatchGetItemCommand)).toBe(1);
  });
});

describe("cacheHandlers.remote, across a revalidation before an instance started", () => {
  afterEach(() => jest.restoreAllMocks());

  // A stores K1; C revalidates its tag; B starts after C's log row is behind
  // its cursor, stores K2 with the same tag, then reads K1 from S3.
  it("does not serve an older S3 entry as fresh after storing a newer one with its tag", async () => {
    const a = remoteInstance();
    await a.set(
      "k1",
      Promise.resolve(entry("before", { timestamp: Date.now() - 1000 })),
    );
    await remoteInstance().updateTags(["posts"], { expire: 0 });

    const later = Date.now() + 10_000;
    jest.spyOn(Date, "now").mockReturnValue(later);
    const b = remoteInstance();
    await b.set("k2", Promise.resolve(entry("after", { timestamp: later })));

    expect(await read(b, "k1")).toBeUndefined();
    expect(await read(b, "k2")).toBe("after");
  });
});

describe("cacheHandlers.default", () => {
  it("keeps entries in each instance's memory", async () => {
    const a = defaultInstance();
    const b = defaultInstance();
    await a.set("k", Promise.resolve(entry("v")));
    expect(await read(a, "k")).toBe("v");
    expect(await read(b, "k")).toBeUndefined();
    expect(s3Send).not.toHaveBeenCalled();
  });

  it("expires an entry on an instance that did not run revalidateTag", async () => {
    const a = defaultInstance();
    const b = defaultInstance();
    const created = { timestamp: Date.now() - 1000 };
    await a.set("k", Promise.resolve(entry("a", created)));
    await b.set("k", Promise.resolve(entry("b", created)));
    // Its first read of its own entry reads the tag's marker, once.
    expect(await read(b, "k")).toBe("b");

    // What Next.js does for `revalidateTag`: `updateTags` on every handler of
    // the instance that ran it - here, `a`.
    await a.updateTags(["posts"], { expire: 0 });
    dynamoSend.mockClear();

    expect(await read(a, "k")).toBeUndefined();
    expect(await read(b, "k")).toBeUndefined();
    // `b` learned of it from the log, not by re-reading its tags' markers.
    expect(dynamoCalls(QueryCommand)).toBeGreaterThan(0);
    expect(dynamoCalls(BatchGetItemCommand)).toBe(0);
  });

  it("waits for the refresh interval before re-reading tags", async () => {
    const b = defaultInstance(tagManifest(60_000));
    await b.set(
      "k",
      Promise.resolve(entry("b", { timestamp: Date.now() - 1000 })),
    );
    await read(b, "k");
    await defaultInstance().updateTags(["posts"]);
    dynamoSend.mockClear();

    // Inside the window: still served, and no read spent on it.
    expect(await read(b, "k")).toBe("b");
    expect(dynamoCalls(BatchGetItemCommand)).toBe(0);
    expect(dynamoCalls(QueryCommand)).toBe(0);
  });

  it("drops an entry past revalidate, as Next.js's in-memory handler does", async () => {
    const a = defaultInstance();
    const past = performance.timeOrigin + performance.now() - 10_000;
    await a.set(
      "k",
      Promise.resolve(entry("v", { timestamp: past, revalidate: 1 })),
    );
    expect(await read(a, "k")).toBeUndefined();
  });

  it("reports stale tags as revalidate -1", async () => {
    const a = defaultInstance();
    await a.set(
      "k",
      Promise.resolve(entry("v", { timestamp: Date.now() - 1000 })),
    );
    await a.updateTags(["posts"], { expire: 3600 });
    const result = await a.get("k", []);
    expect(result?.revalidate).toBe(-1);
  });

  it("answers getExpiration from another instance's revalidatePath", async () => {
    const a = defaultInstance();
    const b = defaultInstance();
    await a.updateTags(["_N_T_/blog/layout"]);
    const expiration = await b.getExpiration(["_N_T_/", "_N_T_/blog/layout"]);
    expect(expiration).toBeGreaterThan(0);
    expect(await b.getExpiration(["_N_T_/other"])).toBe(0);
  });

  it("writes one marker per tag for both handlers of an instance", async () => {
    const tags = tagManifest();
    const handlers = [defaultInstance(tags), remoteInstance(tags)];
    await Promise.all(handlers.map((h) => h.updateTags(["a", "b"])));
    expect(dynamoCalls(UpdateItemCommand)).toBe(2);
    expect(dynamoCalls(PutItemCommand)).toBe(2);
  });

  it("stores nothing from a stream that errors, and releases the pending get", async () => {
    const a = defaultInstance();
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("render failed"));
      },
    });
    await a.set("k", Promise.resolve({ ...entry(""), value: failing }));
    expect(await read(a, "k")).toBeUndefined();
  });
});

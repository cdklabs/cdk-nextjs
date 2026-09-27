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
  markerFor,
  markerState,
  markerUpdate,
  resolveAwsCacheConfig,
  REVALIDATION_LOG_MAX_PAGES,
  REVALIDATION_LOG_TTL_MS,
  RevalidationLog,
  TagMarkerTable,
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

  it("lets overrides win and reports what is unset as empty", () => {
    delete process.env.CDK_NEXTJS_CACHE_BUCKET_NAME;
    delete process.env.CDK_NEXTJS_REVALIDATION_TABLE_NAME;
    delete process.env.CDK_NEXTJS_BUILD_ID;
    delete process.env.AWS_REGION;
    expect(resolveAwsCacheConfig({ bucketName: "mine" })).toEqual({
      bucketName: "mine",
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
      const names: Record<string, string> = {
        ":timestamp": "revalidatedAt",
        ":stale": "staleAt",
        ":expired": "expiredAt",
      };
      for (const [name, value] of Object.entries(
        update.ExpressionAttributeValues!,
      )) {
        written[names[name]] = Number(value.N);
      }
      expect(written).toEqual(local);
    }
    expect(markerFor(1000, { expire: 60 })).toEqual({
      staleAt: 1000,
      expiredAt: 61000,
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
      UpdateExpression: "SET staleAt = :stale, expiredAt = :expired",
      ExpressionAttributeValues: {
        ":stale": { N: "1000" },
        ":expired": { N: "2000" },
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
    });
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
    expect(await bucket.get("k")).toEqual({
      body: "{}",
      contentType: "application/json",
    });
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

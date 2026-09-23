/* eslint-disable import/no-extraneous-dependencies */
jest.mock("@aws-sdk/client-dynamodb");
jest.mock("@aws-sdk/client-s3");

import {
  BatchWriteItemCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import { seedTagMappings } from "./seed-tag-mappings";

// The module under test constructs its clients at import time, which happens
// before any statement here runs, so patch the shared prototype rather than the
// constructor.
const mockDynamoSend = DynamoDBClient.prototype.send as unknown as jest.Mock;
const mockS3Send = S3Client.prototype.send as unknown as jest.Mock;

const props = {
  bucketName: "test-bucket",
  tableName: "test-table",
  buildId: "test-build-id",
};

/** The rows written, flattened out of however many batches it took. */
const writtenRows = () =>
  (BatchWriteItemCommand as unknown as jest.Mock).mock.calls.flatMap(
    ([input]) => input.RequestItems["test-table"],
  );

describe("seedTagMappings", () => {
  beforeEach(() => {
    mockDynamoSend.mockReset();
    mockS3Send.mockReset();
    (BatchWriteItemCommand as unknown as jest.Mock).mockClear();
    mockDynamoSend.mockResolvedValue({});
  });

  it("writes the mapping rows a runtime `set` would have written", async () => {
    mockS3Send.mockResolvedValue({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            "_N_T_/": ["index", "blog/first"],
            posts: ["blog/first"],
          }),
        ),
      },
    });

    await seedTagMappings(props);

    const [getInput] = (GetObjectCommand as unknown as jest.Mock).mock.calls[0];
    expect(getInput).toMatchObject({
      Bucket: "test-bucket",
      Key: "test-build-id/_cdk-nextjs-tag-manifest.json",
    });

    // `tag#<s3Key>`, matching `buildS3Key`, because `revalidateTag` reads the S3
    // key straight back out of the sort key.
    expect(
      writtenRows()
        .map((row: any) => row.PutRequest.Item.sk.S)
        .sort(),
    ).toEqual([
      "_N_T_/#test-build-id/blog/first.json",
      "_N_T_/#test-build-id/index.json",
      "posts#test-build-id/blog/first.json",
    ]);
    // No `revalidatedAt`: a mapping row records only that an entry carries the
    // tag, and a timestamp here would make every seeded entry look revalidated.
    for (const row of writtenRows()) {
      expect(row.PutRequest.Item.pk.S).toBe("test-build-id");
      expect(row.PutRequest.Item.revalidatedAt).toBeUndefined();
    }
  });

  it("does nothing when the app has no tagged prerenders", async () => {
    mockS3Send.mockRejectedValue(
      new NoSuchKey({ $metadata: {}, message: "The key does not exist" }),
    );

    await expect(seedTagMappings(props)).resolves.toBeUndefined();
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it("warns when the manifest is unreadable for any other reason", async () => {
    // `AccessDenied` and a missing manifest seed nothing and look identical from
    // the outside, but only one of them is normal. Silently treating both as "no
    // tagged prerenders" hid a misconfigured bucket policy whose only symptom is
    // `revalidateTag` never invalidating CloudFront.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockS3Send.mockRejectedValue(new Error("AccessDenied"));

    await expect(seedTagMappings(props)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not read the tag manifest"),
    );
    expect(mockDynamoSend).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("splits into batches DynamoDB accepts and retries what it returns", async () => {
    const manifest = {
      bulk: Array.from({ length: 26 }, (_, i) => `page/${i}`),
    };
    mockS3Send.mockResolvedValue({
      Body: {
        transformToString: jest
          .fn()
          .mockResolvedValue(JSON.stringify(manifest)),
      },
    });
    mockDynamoSend.mockResolvedValueOnce({
      UnprocessedItems: {
        "test-table": [
          { PutRequest: { Item: { pk: { S: "test-build-id" } } } },
        ],
      },
    });

    await seedTagMappings(props);

    // 26 rows: a 25-row batch, a 1-row batch, and one retry of what came back
    // unprocessed.
    expect(mockDynamoSend).toHaveBeenCalledTimes(3);
  });

  it("retries a batch that threw, not just one that came back unprocessed", async () => {
    // A throttle or a brief network fault rejects the whole call, which is the
    // same situation as `UnprocessedItems` and was the one case that dropped 25
    // rows outright. Retried with backoff instead, so the cost of a transient
    // error is a delay rather than 25 prerenders `revalidateTag` cannot reach.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockS3Send.mockResolvedValue({
      Body: {
        transformToString: jest
          .fn()
          .mockResolvedValue(JSON.stringify({ posts: ["blog/first"] })),
      },
    });
    mockDynamoSend.mockRejectedValueOnce(
      new Error("ProvisionedThroughputExceededException"),
    );

    await seedTagMappings(props);

    expect(mockDynamoSend).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("says so loudly when nothing could be seeded at all", async () => {
    // Zero rows written is indistinguishable from an app with no tagged
    // prerenders unless it is reported: every later `revalidateTag` silently
    // leaves the CDN serving the pre-revalidation page.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockS3Send.mockResolvedValue({
      Body: {
        transformToString: jest
          .fn()
          .mockResolvedValue(JSON.stringify({ posts: ["blog/first"] })),
      },
    });
    mockDynamoSend.mockRejectedValue(new Error("AccessDeniedException"));

    await seedTagMappings(props);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("None of the 1 tag mappings could be seeded"),
    );
    warn.mockRestore();
  });

  it("counts failures across concurrent workers", async () => {
    // The counter is shared by four workers, so the read-modify-write has to
    // happen after the await: `unseeded += await …` read `unseeded` before
    // yielding, both workers read 0, and the last assignment won. Two failed
    // batches then reported "25 of 50 unseeded" instead of tripping the
    // total-failure branch — the one signal that no prerender is reachable by
    // `revalidateTag` at all.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockS3Send.mockResolvedValue({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            posts: Array.from({ length: 50 }, (_, i) => `page/${i}`),
          }),
        ),
      },
    });
    mockDynamoSend.mockRejectedValue(new Error("AccessDeniedException"));

    await seedTagMappings(props);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("None of the 50 tag mappings could be seeded"),
    );
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("unseeded"));
    warn.mockRestore();
    // Two batches, each burning its five attempts with backoff.
  }, 15_000);
});

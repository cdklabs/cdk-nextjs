/* eslint-disable import/no-extraneous-dependencies */
jest.mock("@aws-sdk/client-dynamodb");
jest.mock("@aws-sdk/client-s3");

import {
  BatchWriteItemCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
    mockS3Send.mockRejectedValue(new Error("NoSuchKey"));

    await expect(seedTagMappings(props)).resolves.toBeUndefined();
    expect(mockDynamoSend).not.toHaveBeenCalled();
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
});

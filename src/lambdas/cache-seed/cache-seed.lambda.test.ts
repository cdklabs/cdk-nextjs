/* eslint-disable import/no-extraneous-dependencies */
import type { CloudFormationCustomResourceEvent, Context } from "aws-lambda";

const logged: unknown[] = [];
jest.mock(
  "debug",
  () =>
    () =>
    (...args: unknown[]) =>
      logged.push(...args),
);
jest.mock("./seed-cache", () => ({
  seedCache: jest.fn(async () => ({
    status: "seeded",
    written: 1,
    skipped: 0,
  })),
}));
jest.mock("./zip-seed", () => ({
  openZipSeed: jest.fn(async () => ({ entries: [], close: async () => {} })),
}));
jest.mock("../utils", () => ({
  ...jest.requireActual("../utils"),
  cfnResponse: jest.fn(async () => undefined),
}));

import { handler, HOTSWAP_RESPONSE_URL } from "./cache-seed.lambda";
import { seedCache } from "./seed-cache";
import { openZipSeed } from "./zip-seed";
import { cfnResponse } from "../utils";

const context = {
  getRemainingTimeInMillis: () => 900_000,
  logStreamName: "stream",
} as unknown as Context;

const properties = {
  ServiceToken: "token",
  BuildId: "b1",
  DestinationBucketName: "cache-bucket",
  SourceBucketName: "assets-bucket",
  SourceObjectKey: "abc.zip",
};

const event = {
  RequestType: "Create",
  ResponseURL:
    "https://cloudformation-custom-resource-response.example/?X-Amz-Signature=secret",
  StackId: "stack",
  RequestId: "request",
  LogicalResourceId: "CacheSeed",
  ResourceType: "Custom::CDKBucketDeployment",
  ServiceToken: "token",
  ResourceProperties: properties,
} as CloudFormationCustomResourceEvent;

/**
 * What `cdk deploy --hotswap` invokes a `Custom::CDKBucketDeployment`'s
 * ServiceToken with (`isHotswappableS3BucketDeploymentChange` in aws-cdk's
 * toolkit-lib): an Update with placeholders for every request field, and
 * every property, ServiceToken aside, stringified.
 */
const hotswapEvent = {
  RequestType: "Update",
  ResponseURL: HOTSWAP_RESPONSE_URL,
  PhysicalResourceId: HOTSWAP_RESPONSE_URL,
  StackId: HOTSWAP_RESPONSE_URL,
  RequestId: HOTSWAP_RESPONSE_URL,
  LogicalResourceId: HOTSWAP_RESPONSE_URL,
  ResourceProperties: {
    BuildId: "b2",
    DestinationBucketName: "cache-bucket",
    SourceBucketName: "assets-bucket",
    SourceObjectKey: "def.zip",
  },
} as unknown as CloudFormationCustomResourceEvent;

describe("cache-seed handler", () => {
  beforeEach(() => {
    logged.length = 0;
    jest.clearAllMocks();
  });

  it("seeds the build from the asset and answers CloudFormation", async () => {
    await handler(event, context);

    const [props] = (seedCache as jest.Mock).mock.calls[0];
    expect(props).toMatchObject({ bucketName: "cache-bucket", buildId: "b1" });
    await props.openSeed();
    expect(openZipSeed).toHaveBeenCalledWith({
      bucketName: "assets-bucket",
      key: "abc.zip",
    });
    expect(cfnResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        event,
        responseStatus: "SUCCESS",
        physicalResourceId: "nextjs-cache-seed",
      }),
    );
  });

  it("reports FAILED to CloudFormation when the seed fails", async () => {
    (seedCache as jest.Mock).mockRejectedValueOnce(new Error("SlowDown"));
    jest.spyOn(console, "error").mockImplementationOnce(() => {});

    await handler({ ...event, RequestType: "Update" } as never, context);

    expect(cfnResponse).toHaveBeenCalledWith(
      expect.objectContaining({ responseStatus: "FAILED" }),
    );
  });

  it("seeds nothing on Delete", async () => {
    await handler(
      {
        ...event,
        RequestType: "Delete",
        PhysicalResourceId: "nextjs-cache-seed",
      } as never,
      context,
    );

    expect(seedCache).not.toHaveBeenCalled();
    expect(cfnResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        responseStatus: "SUCCESS",
        physicalResourceId: "nextjs-cache-seed",
      }),
    );
  });

  it("never logs the presigned ResponseURL", async () => {
    await handler(event, context);

    expect(JSON.stringify(logged)).not.toContain("X-Amz-Signature");
    expect(JSON.stringify(logged)).toContain("CacheSeed");
    // The response itself still goes to it.
    expect(cfnResponse).toHaveBeenCalledWith(
      expect.objectContaining({ event, responseStatus: "SUCCESS" }),
    );
  });

  it("seeds on a hotswap and sends no response", async () => {
    const result = await handler(hotswapEvent, context);

    expect(seedCache).toHaveBeenCalledWith(
      expect.objectContaining({ bucketName: "cache-bucket", buildId: "b2" }),
    );
    expect(result).toEqual({ status: "seeded", written: 1, skipped: 0 });
    // There is no request to answer: a PUT to the placeholder would throw.
    expect(cfnResponse).not.toHaveBeenCalled();
  });

  it("fails a hotswap invoke whose seed fails, for the log", async () => {
    (seedCache as jest.Mock).mockRejectedValueOnce(new Error("SlowDown"));
    jest.spyOn(console, "error").mockImplementationOnce(() => {});

    await expect(handler(hotswapEvent, context)).rejects.toThrow("SlowDown");
    expect(cfnResponse).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    // What the hotswap's stringify makes of an object.
    ["stringified object", "[object Object]"],
  ])("refuses a %s property", async (_, value) => {
    jest.spyOn(console, "error").mockImplementationOnce(() => {});

    await expect(
      handler(
        {
          ...hotswapEvent,
          ResourceProperties: {
            ...hotswapEvent.ResourceProperties,
            BuildId: value,
          },
        } as never,
        context,
      ),
    ).rejects.toThrow("BuildId property must be a non-empty string");
    expect(seedCache).not.toHaveBeenCalled();
  });

  it("keeps a margin of at least 5 s under a short timeout", async () => {
    const start = Date.now();
    await handler(event, {
      ...context,
      getRemainingTimeInMillis: () => 20_000,
    });

    // 20 s left: a tenth would be 2 s, so the 5 s floor applies.
    const { deadline } = (seedCache as jest.Mock).mock.calls[0][0];
    expect(deadline - start).toBeLessThanOrEqual(15_000 + 50);
    expect(deadline - start).toBeGreaterThanOrEqual(15_000 - 50);
  });

  it("leaves time to seed under a timeout shorter than the 5 s floor", async () => {
    const start = Date.now();
    await handler(event, { ...context, getRemainingTimeInMillis: () => 4_000 });

    // The floor is capped at half the time left: 2 s to seed.
    const { deadline } = (seedCache as jest.Mock).mock.calls[0][0];
    expect(deadline - start).toBeLessThanOrEqual(2_000 + 50);
    expect(deadline - start).toBeGreaterThanOrEqual(2_000 - 50);
  });
});

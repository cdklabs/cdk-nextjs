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
  seedCache: jest.fn(async () => ({ status: "seeded", copied: 1, skipped: 0 })),
}));
jest.mock("../utils", () => ({
  ...jest.requireActual("../utils"),
  cfnResponse: jest.fn(async () => undefined),
}));

import { handler } from "./cache-seed.lambda";
import { seedCache } from "./seed-cache";
import { cfnResponse } from "../utils";

const context = {
  getRemainingTimeInMillis: () => 900_000,
  logStreamName: "stream",
} as unknown as Context;

const event = {
  RequestType: "Create",
  ResponseURL:
    "https://cloudformation-custom-resource-response.example/?X-Amz-Signature=secret",
  StackId: "stack",
  RequestId: "request",
  LogicalResourceId: "CacheSeed",
  ResourceType: "Custom::NextjsCacheSeed",
  ServiceToken: "token",
  ResourceProperties: {
    ServiceToken: "token",
    buildId: "b1",
    cacheBucketName: "cache-bucket",
  },
} as CloudFormationCustomResourceEvent;

describe("cache-seed handler", () => {
  beforeEach(() => {
    logged.length = 0;
    jest.clearAllMocks();
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

  it("keeps a margin of at least 5 s under a short timeout", async () => {
    const start = Date.now();
    await handler(
      { buildId: "b1", cacheBucketName: "cache-bucket" },
      { ...context, getRemainingTimeInMillis: () => 20_000 },
    );

    // 20 s left: a tenth would be 2 s, so the 5 s floor applies.
    const { deadline } = (seedCache as jest.Mock).mock.calls[0][0];
    expect(deadline - start).toBeLessThanOrEqual(15_000 + 50);
    expect(deadline - start).toBeGreaterThanOrEqual(15_000 - 50);
  });

  it("leaves time to copy under a timeout shorter than the 5 s floor", async () => {
    const start = Date.now();
    await handler(
      { buildId: "b1", cacheBucketName: "cache-bucket" },
      { ...context, getRemainingTimeInMillis: () => 4_000 },
    );

    // The floor is capped at half the time left: 2 s to copy.
    const { deadline } = (seedCache as jest.Mock).mock.calls[0][0];
    expect(deadline - start).toBeLessThanOrEqual(2_000 + 50);
    expect(deadline - start).toBeGreaterThanOrEqual(2_000 - 50);
  });
});

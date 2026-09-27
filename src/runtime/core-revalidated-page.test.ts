/* eslint-disable import/no-extraneous-dependencies */
/**
 * The cache handler's half of `res.revalidate()`'s CDN invalidation: the hook
 * `S3CacheHandler` registers for `invalidateRevalidatedPage` in `core.ts`. The
 * runtime's half is in `core.test.ts`.
 */
jest.mock("@aws-sdk/client-s3");
jest.mock("@aws-sdk/client-dynamodb");
jest.mock("@aws-sdk/client-cloudfront");
jest.mock("@aws-sdk/client-ssm");

import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { SSMClient } from "@aws-sdk/client-ssm";
import type { CacheHandlerContext } from "next/dist/server/lib/incremental-cache";
import { S3CacheHandler } from "../adapter/s3-cache-handler";

const HOOK = Symbol.for("cdk-nextjs.invalidateRevalidatedPage");
const globals = globalThis as Record<symbol, unknown>;
type Hook = (routes: readonly string[]) => Promise<void>;

const cloudFrontSend = jest.fn();
(CloudFrontClient as jest.Mock).mockImplementation(() => ({
  send: cloudFrontSend,
}));
(SSMClient as jest.Mock).mockImplementation(() => ({
  send: jest.fn(async () => ({ Parameter: { Value: "EDISTRIBUTION" } })),
}));

const context = { dev: false } as CacheHandlerContext;
const env = { ...process.env };

beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  delete globals[HOOK];
  cloudFrontSend.mockReset().mockResolvedValue({});
  (CreateInvalidationCommand as unknown as jest.Mock).mockClear();
  process.env.CDK_NEXTJS_BUILD_ID = "build-1";
});

afterEach(() => {
  process.env = { ...env };
  jest.restoreAllMocks();
});

function invalidatedPaths(): string[] {
  const [input] = (CreateInvalidationCommand as unknown as jest.Mock).mock
    .calls[0];
  return input.InvalidationBatch.Paths.Items;
}

describe("the revalidated-page hook", () => {
  it("is registered only behind a distribution", () => {
    new S3CacheHandler({ context });
    expect(globals[HOOK]).toBeUndefined();

    process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "param";
    new S3CacheHandler({ context });
    expect(typeof globals[HOOK]).toBe("function");
  });

  it("invalidates the page and its data route under basePath", async () => {
    process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "param";
    process.env.CDK_NEXTJS_BASE_PATH = "base";
    new S3CacheHandler({ context });
    await (globals[HOOK] as Hook)([
      "/blog/hello",
      "/_next/data/build-1/blog/hello.json",
    ]);
    expect(invalidatedPaths()).toEqual([
      "/base/blog/hello*",
      "/base/_next/data/build-1/blog/hello.json*",
    ]);
  });

  it("spells out the root rather than invalidating the whole app", async () => {
    process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "param";
    new S3CacheHandler({ context });
    await (globals[HOOK] as Hook)(["/", "/_next/data/build-1/index.json"]);
    expect(invalidatedPaths()).toEqual([
      "/",
      "/?*",
      "/_next/data/build-1/index.json*",
    ]);
  });

  it("sends every path once, in one invalidation", async () => {
    process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "param";
    new S3CacheHandler({ context });
    await (globals[HOOK] as Hook)([
      "/blog",
      "/_next/data/build-1/en/blog.json",
      "/en/blog",
      "/blog",
    ]);
    expect(CreateInvalidationCommand).toHaveBeenCalledTimes(1);
    expect(invalidatedPaths()).toEqual([
      "/blog*",
      "/_next/data/build-1/en/blog.json*",
      "/en/blog*",
    ]);
  });
});

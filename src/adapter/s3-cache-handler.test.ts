/* eslint-disable import/no-extraneous-dependencies */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// What `require.cache` holds in a running server. Jest's `createRequire` hands
// out a cache of its own that nothing is ever loaded into, so the handler's
// lookup of Next.js's tag manifest reads this stand-in instead.
const mockModuleCache: Record<string, unknown> = {};
jest.mock("node:module", () => ({
  ...jest.requireActual("node:module"),
  createRequire: () => ({ cache: mockModuleCache }),
}));
// Mock AWS SDK
jest.mock("@aws-sdk/client-s3");
jest.mock("@aws-sdk/client-dynamodb");
jest.mock("@aws-sdk/client-cloudfront");
jest.mock("@aws-sdk/client-ssm");

import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import {
  BatchGetItemCommand,
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";
import { CacheHandlerContext } from "next/dist/server/lib/incremental-cache";
import {
  IncrementalCacheValue,
  CachedRouteKind,
  IncrementalCacheKind,
} from "next/dist/server/response-cache";
import { S3CacheHandler } from "./s3-cache-handler";
import { sharedTagManifest } from "./use-cache-common";
import { REVALIDATED_PAGE_HOOK } from "../runtime/manifest";

const mockS3Send = jest.fn();
const mockDynamoSend = jest.fn();
const mockCloudFrontSend = jest.fn();
const mockSsmSend = jest.fn();

(S3Client as jest.Mock).mockImplementation(() => ({
  send: mockS3Send,
}));

(DynamoDBClient as jest.Mock).mockImplementation(() => ({
  send: mockDynamoSend,
}));

(CloudFrontClient as jest.Mock).mockImplementation(() => ({
  send: mockCloudFrontSend,
}));

(SSMClient as jest.Mock).mockImplementation(() => ({
  send: mockSsmSend,
}));

describe("S3DynamoCacheHandler", () => {
  let handler: S3CacheHandler;
  let mockContext: CacheHandlerContext;
  let distDir: string | undefined;

  /** Stage `required-server-files.json` for an app with `basePath: "/base"`. */
  const useBasePath = () => {
    distDir = mkdtempSync(join(tmpdir(), "s3-cache-handler-"));
    writeFileSync(
      join(distDir, "required-server-files.json"),
      JSON.stringify({ config: { basePath: "/base" } }),
    );
    mockContext.serverDistDir = join(distDir, "server");
  };

  // Helper to create set context with tags
  const createSetContext = (tags: string[]) => ({
    fetchCache: true as const,
    tags,
  });

  /**
   * The input a mocked command was constructed with. The SDK's command classes
   * are automocked, so an instance carries nothing of its own.
   */
  const commandInput = (command: unknown, type: unknown) => {
    const mock = type as jest.Mock;
    return mock.mock.calls[mock.mock.instances.indexOf(command)][0];
  };

  /**
   * Answer DynamoDB by command type rather than by call order: `revalidateTag`
   * writes its tag marker before querying the tag's mapping rows, and which of
   * those comes first is an implementation detail. `get` is the marker row every
   * requested tag has, as a `GetItem` would have returned it.
   */
  const dynamoResponses = (responses: {
    query?: unknown;
    get?: { Item?: Record<string, unknown> };
  }) => {
    mockDynamoSend.mockImplementation((command: unknown) => {
      if (command instanceof QueryCommand) {
        return Promise.resolve(responses.query ?? {});
      }
      if (command instanceof BatchGetItemCommand) {
        const { RequestItems } = commandInput(command, BatchGetItemCommand);
        const [[table, { Keys }]] = Object.entries(RequestItems) as [
          string,
          { Keys: { sk: unknown }[] },
        ][];
        const item = responses.get?.Item;
        return Promise.resolve({
          Responses: {
            [table]: item ? Keys.map(({ sk }) => ({ ...item, sk })) : [],
          },
        });
      }
      return Promise.resolve({});
    });
  };

  /**
   * Drop the process's tag manifest, so the next handler starts with one of
   * its own, as a new instance does.
   */
  const resetTagManifest = () => {
    delete (globalThis as Record<symbol, unknown>)[
      Symbol.for("cdk-nextjs.use-cache.tag-manifest")
    ];
  };

  beforeEach(() => {
    mockContext = { dev: false } as CacheHandlerContext;
    resetTagManifest();

    // Set up environment variables
    process.env.CDK_NEXTJS_CACHE_BUCKET_NAME = "test-bucket";
    process.env.CDK_NEXTJS_REVALIDATION_TABLE_NAME = "test-table";
    process.env.CDK_NEXTJS_BUILD_ID = "test-build-id";
    process.env.AWS_REGION = "us-east-1";

    // Suppress expected warnings globally (tests deliberately trigger warnings)
    jest.spyOn(console, "warn").mockImplementation();

    handler = new S3CacheHandler({
      context: mockContext,
    });

    // Reset mocks
    mockS3Send.mockReset();
    // An empty bucket: no object, such as no build tag manifest.
    mockS3Send.mockResolvedValue({});
    mockDynamoSend.mockReset();
    mockCloudFrontSend.mockReset();
    mockSsmSend.mockReset();
  });

  afterEach(() => {
    // Clean up environment variables
    delete process.env.CDK_NEXTJS_CACHE_BUCKET_NAME;
    delete process.env.CDK_NEXTJS_REVALIDATION_TABLE_NAME;
    delete process.env.CDK_NEXTJS_BUILD_ID;
    delete process.env.AWS_REGION;
    delete process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME;
    delete process.env.CDK_NEXTJS_DISTRIBUTION_ID;
    if (distDir) {
      rmSync(distDir, { recursive: true, force: true });
      distDir = undefined;
    }

    // Restore console.warn
    jest.restoreAllMocks();
  });

  describe("get", () => {
    it("should return null when S3 bucket is not configured", async () => {
      delete process.env.CDK_NEXTJS_CACHE_BUCKET_NAME;

      const handlerWithoutBucket = new S3CacheHandler({
        context: mockContext,
      });

      const result = await handlerWithoutBucket.get("test-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });
      expect(result).toBeNull();
    });

    it("should retrieve and parse cache value from S3", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>test</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      const cacheValue = {
        lastModified: Date.now(),
        value: testData,
      };

      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: jest
            .fn()
            .mockResolvedValue(JSON.stringify(cacheValue)),
        },
        ContentType: "application/json",
      });

      const result = await handler.get("test-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });

      expect(result).toEqual(cacheValue);
      expect(mockS3Send).toHaveBeenCalledWith(expect.any(GetObjectCommand));
    });

    it("hands back the lifetime the entry was stored with", async () => {
      // next 16.4 ages an entry by this over its own per-process lifetimes, so
      // an instance that never rendered the page still revalidates it on time.
      const stored = (cacheControl: unknown) =>
        mockS3Send.mockResolvedValueOnce({
          Body: {
            transformToString: jest.fn().mockResolvedValue(
              JSON.stringify({
                lastModified: 1,
                value: { kind: CachedRouteKind.APP_PAGE, html: "<p/>" },
                cacheControl,
              }),
            ),
          },
        });
      const get = () =>
        handler.get("/isr/1", {
          kind: IncrementalCacheKind.APP_PAGE,
          isFallback: false,
        });

      stored({ revalidate: 60, expire: 300 });
      expect((await get())?.cacheControl).toEqual({
        revalidate: 60,
        expire: 300,
      });
      stored({ revalidate: false });
      expect((await get())?.cacheControl).toEqual({
        revalidate: false,
        expire: undefined,
      });
      // An entry stored before this, or a malformed one, leaves Next.js on the
      // lifetime it knows.
      for (const malformed of [
        undefined,
        { revalidate: 0 },
        { expire: 5 },
        "60",
      ]) {
        stored(malformed);
        expect((await get())?.cacheControl).toBeUndefined();
      }
    });

    it("should return null when S3 object not found", async () => {
      mockS3Send.mockResolvedValueOnce({
        Body: null,
      });

      const result = await handler.get("missing-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });
      expect(result).toBeNull();
    });

    it("invalidates a seeded prerender only when its tag marker is newer", async () => {
      // A build-time prerender is written as a file by the adapter's
      // `onBuildComplete`, never through `set`, so it has no `tags` array and no
      // DynamoDB mapping rows - its tags live in the render's
      // `x-next-cache-tags` header. Two bugs met here: those header tags were
      // ignored, so `revalidateTag` could not reach any static page; and the
      // mapping rows `set` writes were stamped `revalidatedAt = now`, which is
      // *after* the entry's own `lastModified`, so a tagged entry looked
      // revalidated the moment it was stored and every request re-rendered.
      // Measured against next.js's `test/e2e/app-dir/resume-data-cache`.
      const lastModified = Date.now();
      const seeded = {
        lastModified,
        value: {
          kind: CachedRouteKind.APP_PAGE,
          html: "<html>seeded</html>",
          headers: { "x-next-cache-tags": "_N_T_/,_N_T_/page,test" },
        },
      };
      const s3Body = () => ({
        Body: {
          transformToString: jest
            .fn()
            .mockResolvedValue(JSON.stringify(seeded)),
        },
        ContentType: "application/json",
      });
      mockS3Send.mockImplementation((command: unknown) =>
        Promise.resolve(command instanceof GetObjectCommand ? s3Body() : {}),
      );
      const getCtx = {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      } as const;
      // Each step below changes the markers DynamoDB holds; a new instance
      // reads them afresh.
      const freshHandler = () => {
        resetTagManifest();
        return new S3CacheHandler({ context: mockContext });
      };

      // No marker at all: the tag was never revalidated.
      dynamoResponses({});
      expect(await freshHandler().get("index", getCtx)).toMatchObject({
        lastModified,
      });

      // A marker older than the entry means the entry already reflects it.
      dynamoResponses({
        get: { Item: { revalidatedAt: { N: String(lastModified - 1000) } } },
      });
      expect(await freshHandler().get("index", getCtx)).toMatchObject({
        lastModified,
      });
      expect(mockS3Send).not.toHaveBeenCalledWith(
        expect.any(DeleteObjectCommand),
      );

      // A newer marker: the entry comes back marked expired, and stays in S3.
      dynamoResponses({
        get: { Item: { revalidatedAt: { N: String(lastModified + 1000) } } },
      });
      expect(await freshHandler().get("index", getCtx)).toMatchObject({
        lastModified: -1,
        value: seeded.value,
      });
      expect(mockS3Send).not.toHaveBeenCalledWith(
        expect.any(DeleteObjectCommand),
      );
    });

    it("reports a revalidated response entry as expired rather than as a miss", async () => {
      // `lastModified: -1` is how a cache handler says "expired, re-render
      // before answering": `IncrementalCache.get` turns it into `isStale: -1`,
      // which `app-page-runtime` reads as an on-demand revalidation and answers
      // with a blocking render of this route, then stores it. Returning `null`
      // is not equivalent. A miss on a PPR route whose `prerender-manifest.json`
      // entry has a `fallback` (`compute: "resuming"`) is answered from the
      // route's fallback shell - `cache-control: private, no-store`, no
      // `x-nextjs-cache` - and without `partialPrefetching` nothing ever
      // upgrades that back into a concrete entry. So the first `revalidateTag`
      // to reach a page left it uncacheable and dynamically resumed per request
      // for the rest of the deployment's life, which is what the isr e2e's
      // missing `x-nextjs-cache` header was.
      const lastModified = Date.now();
      const stored = {
        lastModified,
        tags: ["collection"],
        value: {
          kind: CachedRouteKind.APP_PAGE,
          html: "<html>isr</html>",
          headers: { "x-next-cache-tags": "collection" },
        },
      };
      mockS3Send.mockImplementation((command: unknown) =>
        Promise.resolve(
          command instanceof GetObjectCommand
            ? {
                Body: {
                  transformToString: jest
                    .fn()
                    .mockResolvedValue(JSON.stringify(stored)),
                },
                ContentType: "application/json",
              }
            : {},
        ),
      );
      dynamoResponses({
        get: { Item: { revalidatedAt: { N: String(lastModified + 1000) } } },
      });

      const result = await handler.get("isr/1", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });

      expect(result).toEqual({ lastModified: -1, value: stored.value });
      // The body is still there for the render that fails, and `set` overwrites
      // it with a `lastModified` past the marker.
      expect(mockS3Send).not.toHaveBeenCalledWith(
        expect.any(DeleteObjectCommand),
      );
    });

    it("reports a revalidated fetch entry as a miss so the request refetches", async () => {
      // The opposite of a response entry: reusing a revalidated `fetch` body is
      // serving stale data, so this reads as a miss, like Next.js's own
      // `FileSystemCache` does for its `revalidatedTags`.
      const lastModified = Date.now();
      const stored = {
        lastModified,
        tags: ["collection"],
        value: {
          kind: CachedRouteKind.FETCH,
          data: { headers: {}, body: "stale", status: 200, url: "/api" },
          revalidate: 10,
        },
      };
      mockS3Send.mockImplementation((command: unknown) =>
        Promise.resolve(
          command instanceof GetObjectCommand
            ? {
                Body: {
                  transformToString: jest
                    .fn()
                    .mockResolvedValue(JSON.stringify(stored)),
                },
                ContentType: "application/json",
              }
            : {},
        ),
      );
      dynamoResponses({
        get: { Item: { revalidatedAt: { N: String(lastModified + 1000) } } },
      });

      const result = await handler.get("fetch-key", {
        kind: IncrementalCacheKind.FETCH,
        revalidate: 10,
        fetchUrl: "https://example.test/api",
        fetchIdx: 1,
        tags: ["collection"],
        softTags: [],
      });

      expect(result).toBeNull();
      // Not deleted: the refetch this provokes overwrites it through `set`.
      // Deleting it here raced that write, so a concurrent request's fresh
      // entry could be the one removed.
      expect(mockS3Send).not.toHaveBeenCalledWith(
        expect.any(DeleteObjectCommand),
      );
      expect(DeleteItemCommand as unknown as jest.Mock).not.toHaveBeenCalled();
    });

    it("checks a fetch entry against the request's implicit tags, not its own", async () => {
      // An untagged `cache: "force-cache"` fetch is stored with no tags at all -
      // the implicit `_N_T_/<path>` chain reaches the handler only as
      // `ctx.softTags`, which is the source Next.js's own `FileSystemCache` reads
      // for a `FETCH` get. Checking the stored tags instead left this entry with
      // nothing to check and no `revalidatePath` could ever evict it.
      const lastModified = Date.now();
      const stored = {
        lastModified,
        tags: [],
        value: {
          kind: CachedRouteKind.FETCH,
          data: { headers: {}, body: "stale", status: 200, url: "/api" },
          revalidate: 10,
        },
      };
      mockS3Send.mockImplementation((command: unknown) =>
        Promise.resolve(
          command instanceof GetObjectCommand
            ? {
                Body: {
                  transformToString: jest
                    .fn()
                    .mockResolvedValue(JSON.stringify(stored)),
                },
                ContentType: "application/json",
              }
            : {},
        ),
      );
      dynamoResponses({
        get: { Item: { revalidatedAt: { N: String(lastModified + 1000) } } },
      });

      const result = await handler.get("fetch-key", {
        kind: IncrementalCacheKind.FETCH,
        revalidate: 10,
        fetchUrl: "https://next-data-api-endpoint.test/api/random",
        fetchIdx: 1,
        tags: [],
        softTags: ["_N_T_/layout", "_N_T_/dynamic"],
      });

      expect(result).toBeNull();
      const [{ RequestItems }] = (BatchGetItemCommand as unknown as jest.Mock)
        .mock.calls[0];
      expect(
        RequestItems["test-table"].Keys.map(
          (key: { sk: { S: string } }) => key.sk.S,
        ),
      ).toEqual(["_N_T_/layout", "_N_T_/dynamic"]);
    });

    describe("a tag revalidated with a profile", () => {
      // `revalidateTag("posts", "max")` is stale-while-revalidate: the entry is
      // served once more while a background render replaces it, and expires
      // outright only after the profile's `expire`. Treating it as `updateTag`
      // made every such call a blocking re-render.
      const lastModified = Date.now() - 1000;
      const stored = {
        lastModified,
        value: {
          kind: CachedRouteKind.APP_PAGE,
          html: "<html>posts</html>",
          headers: { "x-next-cache-tags": "posts" },
        },
      };
      const getCtx = {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      } as const;
      const manifestPath = join(
        "/deployment/node_modules/next/dist/server/lib/incremental-cache",
        "tags-manifest.external.js",
      );
      // The module the server loads, resolved for real, so a Next.js upgrade
      // that moves or reshapes it fails here rather than silently turning
      // stale-while-revalidate into blocking renders.
      const realManifestPath =
        require.resolve("next/dist/server/lib/incremental-cache/tags-manifest.external.js");

      beforeEach(() => {
        mockS3Send.mockImplementation((command: unknown) =>
          Promise.resolve(
            command instanceof GetObjectCommand
              ? {
                  Body: {
                    transformToString: jest
                      .fn()
                      .mockResolvedValue(JSON.stringify(stored)),
                  },
                  ContentType: "application/json",
                }
              : {},
          ),
        );
      });

      afterEach(() => {
        delete mockModuleCache[manifestPath];
        delete mockModuleCache[realManifestPath];
      });

      it("serves the entry and marks the tag stale in Next.js's manifest", async () => {
        const next = jest.requireActual(realManifestPath);
        mockModuleCache[realManifestPath] = { exports: next };
        const staleAt = lastModified + 500;
        dynamoResponses({
          get: {
            Item: {
              staleAt: { N: String(staleAt) },
              expiredAt: { N: String(Date.now() + 60_000) },
            },
          },
        });

        expect(await handler.get("posts", getCtx)).toEqual({
          lastModified,
          value: stored.value,
        });
        // Where `IncrementalCache.get` reads it, to answer `isStale: true`.
        expect(next.tagsManifest.get("posts")).toEqual({ stale: staleAt });
        expect(next.areTagsStale(["posts"], lastModified)).toBe(true);
      });

      it("expires the entry when Next.js's manifest cannot be found", async () => {
        // A stale mark nothing reads would serve the entry as fresh; a blocking
        // render is the safe side of that.
        dynamoResponses({
          get: { Item: { staleAt: { N: String(lastModified + 500) } } },
        });

        expect(await handler.get("posts", getCtx)).toMatchObject({
          lastModified: -1,
        });
      });

      it("expires the entry once the profile's expire has passed", async () => {
        dynamoResponses({
          get: {
            Item: {
              staleAt: { N: String(lastModified + 100) },
              expiredAt: { N: String(lastModified + 500) },
            },
          },
        });

        expect(await handler.get("posts", getCtx)).toMatchObject({
          lastModified: -1,
        });
      });

      describe("behind a distribution", () => {
        // `revalidateTag`'s invalidation goes out before the stale entry is
        // served, and the stale response carries the entry's original
        // `s-maxage`: CloudFront caches it again. Only the regeneration's `set`
        // knows when the fresh entry exists to be fetched instead.
        let cdnHandler: S3CacheHandler;
        const regenerated = stored.value as unknown as IncrementalCacheValue;
        const invalidatedPaths = (): string[][] =>
          (CreateInvalidationCommand as unknown as jest.Mock).mock.calls.map(
            ([input]) => input.InvalidationBatch.Paths.Items,
          );

        beforeEach(() => {
          process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
          cdnHandler = new S3CacheHandler({ context: mockContext });
          mockModuleCache[manifestPath] = {
            exports: { tagsManifest: new Map() },
          };
          dynamoResponses({
            get: { Item: { staleAt: { N: String(lastModified + 500) } } },
          });
          mockSsmSend.mockResolvedValue({
            Parameter: { Value: "test-distribution-id" },
          });
          mockCloudFrontSend.mockResolvedValue({});
        });

        it("invalidates the page again once its regeneration is stored", async () => {
          await cdnHandler.get("posts", getCtx);
          expect(invalidatedPaths()).toEqual([]);

          await cdnHandler.set("posts", regenerated, {
            cacheControl: { revalidate: false, expire: undefined },
            isRoutePPREnabled: false,
            isFallback: false,
          } as any);

          expect(invalidatedPaths()).toEqual([["/posts*"]]);

          // Once: a later write of the same page is an ordinary one.
          await cdnHandler.set("posts", regenerated, {
            cacheControl: { revalidate: false, expire: undefined },
            isRoutePPREnabled: false,
            isFallback: false,
          } as any);
          expect(invalidatedPaths()).toHaveLength(1);
        });

        it("remembers a stale memory hit by the key it was read under", async () => {
          await cdnHandler.isRevalidated(stored, getCtx, "posts");
          await cdnHandler.set("posts", regenerated, {
            isRoutePPREnabled: false,
            isFallback: false,
          } as any);

          expect(invalidatedPaths()).toEqual([["/posts*"]]);
        });

        it("does not invalidate after an ordinary write", async () => {
          await cdnHandler.set("posts", regenerated, {
            isRoutePPREnabled: false,
            isFallback: false,
          } as any);

          expect(invalidatedPaths()).toEqual([]);
        });

        it("forgets a stale page that is deleted instead of regenerated", async () => {
          await cdnHandler.get("posts", getCtx);
          await cdnHandler.set("posts", null, {
            isRoutePPREnabled: false,
            isFallback: false,
          } as any);
          await cdnHandler.set("posts", regenerated, {
            isRoutePPREnabled: false,
            isFallback: false,
          } as any);

          expect(invalidatedPaths()).toEqual([]);
        });
      });
    });

    it("should handle S3 errors and return null", async () => {
      mockS3Send.mockRejectedValueOnce(new Error("S3 Error"));

      const result = await handler.get("error-key", {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });
      expect(result).toBeNull();
    });
  });

  describe("tag marker cache", () => {
    // Every cache hit checks its tags' markers, and all of a deployment's
    // markers share one partition key: read per request, they capped a route's
    // cache hits at ~1,900 req/s. Each instance holds them for a second.
    const lastModified = Date.now() - 60_000;
    const stored = {
      lastModified,
      value: {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>cached</html>",
        headers: { "x-next-cache-tags": "_N_T_/page,posts" },
      },
    };
    const getCtx = {
      kind: IncrementalCacheKind.APP_PAGE,
      isFallback: false,
    } as const;
    const markerReads = () =>
      mockDynamoSend.mock.calls.filter(
        ([command]) => command instanceof BatchGetItemCommand,
      ).length;
    // What `get` answers for a revalidated page: expired, not a miss.
    const expired = { lastModified: -1 };
    const revalidatedAfterStore = {
      get: { Item: { revalidatedAt: { N: String(lastModified + 1000) } } },
    };

    beforeEach(() => {
      mockS3Send.mockImplementation((command: unknown) =>
        Promise.resolve(
          command instanceof GetObjectCommand
            ? {
                Body: {
                  transformToString: jest
                    .fn()
                    .mockResolvedValue(JSON.stringify(stored)),
                },
                ContentType: "application/json",
              }
            : {},
        ),
      );
      dynamoResponses({});
    });

    it("answers checks within the TTL from the markers it already read", async () => {
      await handler.get("page", getCtx);
      await handler.get("page", getCtx);

      expect(markerReads()).toBe(1);
    });

    it("shares one read between concurrent checks", async () => {
      await Promise.all([
        handler.get("page", getCtx),
        handler.get("page", getCtx),
        handler.get("page", getCtx),
      ]);

      expect(markerReads()).toBe(1);
    });

    it("sees its own revalidateTag at once, and logs it for the others", async () => {
      expect(await handler.get("page", getCtx)).toMatchObject({ lastModified });

      dynamoResponses(revalidatedAfterStore);
      await handler.revalidateTag("posts");

      expect(await handler.get("page", getCtx)).toMatchObject(expired);
      const puts = mockDynamoSend.mock.calls.filter(
        ([command]) => command instanceof PutItemCommand,
      );
      expect(puts).toHaveLength(1);
      expect(commandInput(puts[0][0], PutItemCommand).Item).toMatchObject({
        pk: { S: "test-build-id#log" },
        sk: { S: expect.stringMatching(/^\d{15}#posts$/) },
        revalidatedAt: { N: expect.any(String) },
        ttl: { N: expect.any(String) },
      });
    });

    it("writes each tag once when the 'use cache' handlers get the same call", async () => {
      // Next.js calls `revalidateTag` here and `updateTags` on every
      // `cacheHandlers` entry, and all of them share one manifest.
      await Promise.all([
        handler.revalidateTag(["posts"]),
        sharedTagManifest().update(["posts"], undefined),
      ]);

      const writes = mockDynamoSend.mock.calls.filter(
        ([command]) =>
          command instanceof UpdateItemCommand ||
          command instanceof PutItemCommand,
      );
      expect(writes).toHaveLength(2);
    });
  });

  describe("set", () => {
    // Mapping rows exist only to name CloudFront paths, so only a deployment
    // with a distribution keeps them.
    beforeEach(() => {
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      handler = new S3CacheHandler({ context: mockContext });
    });

    it("keeps no mapping rows without a distribution to invalidate", async () => {
      // The Regional constructs have no CloudFront. A row per tag per `set`,
      // and the S3 read before a delete to name them, bought nothing there.
      delete process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME;
      const regional = new S3CacheHandler({ context: mockContext });
      mockS3Send.mockResolvedValue({});
      mockDynamoSend.mockResolvedValue({});

      await regional.set(
        "/isr/1",
        {
          kind: CachedRouteKind.APP_PAGE,
          html: "<p/>",
          rscData: undefined,
          headers: { "x-next-cache-tags": "tag" },
          postponed: undefined,
          segmentData: undefined,
          status: undefined,
        },
        createSetContext([]),
      );
      await regional.set("/isr/1", null, { isFallback: false });

      expect(mockDynamoSend).not.toHaveBeenCalled();
      expect(mockS3Send).not.toHaveBeenCalledWith(expect.any(GetObjectCommand));
      expect(mockS3Send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
    });

    it("should store cache value in S3", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>set test</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      mockS3Send.mockResolvedValueOnce({});
      mockDynamoSend.mockResolvedValue({});

      await handler.set("set-key", testData, createSetContext(["tag1"]));

      expect(mockS3Send).toHaveBeenCalledWith(expect.any(PutObjectCommand));
      expect(mockDynamoSend).toHaveBeenCalledWith(
        expect.any(UpdateItemCommand),
      );
    });

    it("stores a response entry's lifetime, and none for a fetch entry", async () => {
      const page: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<p/>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };
      mockS3Send.mockResolvedValue({});
      mockDynamoSend.mockResolvedValue({});
      const storedBodies = () =>
        (PutObjectCommand as unknown as jest.Mock).mock.calls.map(([input]) =>
          JSON.parse(input.Body),
        );

      await handler.set("/isr/1", page, {
        cacheControl: { revalidate: 60, expire: 300 },
        isRoutePPREnabled: false,
        isFallback: false,
      });
      await handler.set("fetch-key", page, createSetContext([]));

      const [response, fetch] = storedBodies().slice(-2);
      expect(response.cacheControl).toEqual({ revalidate: 60, expire: 300 });
      expect(fetch).not.toHaveProperty("cacheControl");
    });

    it("should not store when S3 bucket is not configured", async () => {
      delete process.env.CDK_NEXTJS_CACHE_BUCKET_NAME;

      const handlerWithoutBucket = new S3CacheHandler({
        context: mockContext,
      });

      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>no bucket</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      await handlerWithoutBucket.set(
        "no-bucket-key",
        testData,
        createSetContext([]),
      );

      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it("maps the tags a page carries only in its x-next-cache-tags header", async () => {
      // `ResponseCache.set` builds a page's `ctx` without tags, so the render's
      // header is the only place they exist. No mapping row meant `revalidateTag`
      // found nothing to invalidate and CloudFront kept the stale HTML.
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>tagged</html>",
        rscData: undefined,
        headers: { "x-next-cache-tags": "header-tag,other-tag" },
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      mockS3Send.mockResolvedValue({});
      mockDynamoSend.mockResolvedValue({});

      await handler.set("/isr/1", testData, createSetContext([]));

      const mappingKeys = (UpdateItemCommand as unknown as jest.Mock).mock.calls
        .map(([input]) => input.Key.sk.S)
        .sort();
      expect(mappingKeys).toEqual([
        "header-tag#test-build-id/isr/1.json",
        "other-tag#test-build-id/isr/1.json",
      ]);
    });

    it("prefers the context's tags over the header when both are present", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>tagged</html>",
        rscData: undefined,
        headers: { "x-next-cache-tags": "header-tag" },
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      mockS3Send.mockResolvedValue({});
      mockDynamoSend.mockResolvedValue({});

      await handler.set("/isr/1", testData, createSetContext(["ctx-tag"]));

      const mappingKeys = (UpdateItemCommand as unknown as jest.Mock).mock.calls
        .map(([input]) => input.Key.sk.S)
        .sort();
      expect(mappingKeys).toEqual(["ctx-tag#test-build-id/isr/1.json"]);
    });

    it("hashes a mapping row's sort key past DynamoDB's 1024 bytes, keeping the key in s3Key", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>tagged</html>",
        rscData: undefined,
        headers: {},
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };
      const tag = "t".repeat(256);
      const cacheKey = `/route-cache/APP_PAGE/${"a".repeat(64)}/$/${"p".repeat(700)}`;

      mockS3Send.mockResolvedValue({});
      mockDynamoSend.mockResolvedValue({});

      await handler.set(cacheKey, testData, createSetContext([tag]));

      const [input] = (UpdateItemCommand as unknown as jest.Mock).mock.calls[0];
      expect(input.Key.sk.S).toMatch(
        new RegExp(`^${tag}#test-build-id/#[0-9a-f]{64}$`),
      );
      expect(input.ExpressionAttributeValues[":s3Key"].S).toBe(
        `test-build-id${cacheKey}.json`,
      );
    });

    it("hashes the tag into a mapping row's prefix when even a hashed row would pass 1024 bytes", async () => {
      // An implicit tag is as long as its path.
      const tag = `_N_T_/${"p".repeat(1000)}`;
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>tagged</html>",
        rscData: undefined,
        headers: {},
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };
      mockS3Send.mockResolvedValue({});
      mockDynamoSend.mockResolvedValue({});

      await handler.set("/isr/1", testData, createSetContext([tag]));

      const [input] = (UpdateItemCommand as unknown as jest.Mock).mock.calls[0];
      const sk: string = input.Key.sk.S;
      expect(sk).toMatch(/^#[0-9a-f]{64}#test-build-id\/isr\/1\.json$/);
      expect(Buffer.byteLength(sk)).toBeLessThanOrEqual(1024);

      // `revalidateTag` queries the same prefix.
      dynamoResponses({ query: { Items: [] } });
      await handler.revalidateTag(tag);
      const queried = (QueryCommand as unknown as jest.Mock).mock.calls.map(
        ([query]) => query.ExpressionAttributeValues[":skPrefix"]?.S,
      );
      expect(queried).toContain(sk.slice(0, 66));
    });

    it("stores an entry whose S3 key would pass 1024 bytes under a hashed object key", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>long</html>",
        rscData: undefined,
        headers: {},
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };
      const cacheKey = `/route-cache/APP_PAGE/${"a".repeat(64)}/$/${"p".repeat(950)}`;
      mockS3Send.mockResolvedValue({});
      mockDynamoSend.mockResolvedValue({});

      await handler.set(cacheKey, testData, createSetContext(["t"]));

      const [put] = (PutObjectCommand as unknown as jest.Mock).mock.calls[0];
      expect(put.Key).toMatch(/^test-build-id\/_long-key\/[0-9a-f]{64}\.long$/);
      // The mapping keeps the name a CloudFront path is recovered from.
      const [mapping] = (UpdateItemCommand as unknown as jest.Mock).mock
        .calls[0];
      expect(mapping.ExpressionAttributeValues[":s3Key"].S).toBe(
        `test-build-id${cacheKey}.json`,
      );

      (GetObjectCommand as unknown as jest.Mock).mockClear();
      await handler.get(cacheKey, {
        kind: IncrementalCacheKind.APP_PAGE,
        isFallback: false,
      });
      const [get] = (GetObjectCommand as unknown as jest.Mock).mock.calls[0];
      expect(get.Key).toBe(put.Key);
    });

    it("removes a deleted page's mapping rows, reading its tags from S3", async () => {
      // A response delete - a cached route that starts answering `notFound()` -
      // arrives as `set(key, null, { cacheControl, ... })` with no tags at all,
      // so the entry itself is the only place its mapping rows can be named
      // from. Left behind, they resolve on the next `revalidateTag` to a cache
      // key whose object is gone and spend a CloudFront wildcard path on it.
      const stored = {
        lastModified: Date.now(),
        tags: ["collection", "_N_T_/isr/1"],
        value: {
          kind: CachedRouteKind.APP_PAGE,
          html: "<html>gone</html>",
        },
      };
      mockS3Send.mockImplementation((command: unknown) =>
        Promise.resolve(
          command instanceof GetObjectCommand
            ? {
                Body: {
                  transformToString: jest
                    .fn()
                    .mockResolvedValue(JSON.stringify(stored)),
                },
                ContentType: "application/json",
              }
            : {},
        ),
      );
      mockDynamoSend.mockResolvedValue({});

      await handler.set("/isr/1", null, {
        cacheControl: { revalidate: 60, expire: undefined },
        isRoutePPREnabled: false,
        isFallback: false,
      });

      expect(mockS3Send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
      const deletedKeys = (DeleteItemCommand as unknown as jest.Mock).mock.calls
        .map(([input]) => input.Key.sk.S)
        .sort();
      // Mapping rows only. The bare-tag marker row belongs to the tag, and
      // `checkIfRevalidated` reads it for every other entry carrying it.
      expect(deletedKeys).toEqual([
        "_N_T_/isr/1#test-build-id/isr/1.json",
        "collection#test-build-id/isr/1.json",
      ]);
    });

    it("deletes a fetch entry's mapping rows from the context's tags alone", async () => {
      // `ctx` carries them here, so the pre-delete read is skipped: only the
      // DeleteObject reaches S3.
      mockS3Send.mockResolvedValue({});
      mockDynamoSend.mockResolvedValue({});

      await handler.set("fetch-key", null, createSetContext(["ctx-tag"]));

      expect(mockS3Send).not.toHaveBeenCalledWith(expect.any(GetObjectCommand));
      const deletedKeys = (
        DeleteItemCommand as unknown as jest.Mock
      ).mock.calls.map(([input]) => input.Key.sk.S);
      expect(deletedKeys).toEqual(["ctx-tag#test-build-id/fetch-key.json"]);
    });

    it("deletes no mapping rows for an untagged entry", async () => {
      mockS3Send.mockImplementation((command: unknown) =>
        Promise.resolve(
          command instanceof GetObjectCommand
            ? {
                Body: {
                  transformToString: jest.fn().mockResolvedValue(
                    JSON.stringify({
                      lastModified: Date.now(),
                      value: { kind: CachedRouteKind.APP_PAGE, html: "<p/>" },
                    }),
                  ),
                },
                ContentType: "application/json",
              }
            : {},
        ),
      );
      mockDynamoSend.mockResolvedValue({});

      await handler.set("/untagged", null, { isFallback: false });

      expect(mockS3Send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
      expect(DeleteItemCommand as unknown as jest.Mock).not.toHaveBeenCalled();
    });

    it("still deletes the object when its tags cannot be read", async () => {
      mockS3Send.mockImplementation((command: unknown) =>
        command instanceof GetObjectCommand
          ? Promise.reject(new Error("S3 Get Error"))
          : Promise.resolve({}),
      );
      mockDynamoSend.mockResolvedValue({});

      await expect(
        handler.set("/isr/1", null, { isFallback: false }),
      ).resolves.not.toThrow();

      expect(mockS3Send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
    });

    it("should handle S3 errors gracefully", async () => {
      const testData: IncrementalCacheValue = {
        kind: CachedRouteKind.APP_PAGE,
        html: "<html>error test</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        segmentData: undefined,
        status: undefined,
      };

      mockS3Send.mockRejectedValueOnce(new Error("S3 Put Error"));

      // Should not throw
      await expect(
        handler.set("error-key", testData, createSetContext([])),
      ).resolves.not.toThrow();
    });
  });

  describe("revalidateTag", () => {
    it("should record the revalidation without deleting the tag's S3 entries", async () => {
      const mockQueryResponse = {
        Items: [
          { sk: { S: "test-tag#cache-key-1" } },
          { sk: { S: "test-tag#cache-key-2" } },
        ],
      };

      dynamoResponses({ query: mockQueryResponse });
      mockS3Send.mockResolvedValue({});

      await handler.revalidateTag("test-tag");

      // No distribution, so no mapping rows to read: the marker is all of it.
      expect(mockDynamoSend).not.toHaveBeenCalledWith(expect.any(QueryCommand));
      expect(mockDynamoSend).toHaveBeenCalledWith(
        expect.any(UpdateItemCommand),
      );
      // The marker row is the invalidation; `get` reads it and hands the entry
      // back expired so Next.js re-renders the route and replaces the object.
      // Deleting the objects here made the next request a hard miss, which on a
      // PPR route is answered from the uncacheable fallback shell for good.
      expect(mockS3Send).not.toHaveBeenCalledWith(
        expect.any(DeleteObjectCommand),
      );

      // The tag marker `checkIfRevalidated` reads: keyed by the bare tag, so
      // entries with no mapping row of their own still see the revalidation.
      const markerWrite = (UpdateItemCommand as unknown as jest.Mock).mock.calls
        .map(([input]) => input)
        .find((input) => input.Key.sk.S === "test-tag");
      expect(markerWrite).toMatchObject({
        UpdateExpression: "SET revalidatedAt = :revalidatedAt",
      });
    });

    it("should not revalidate when DynamoDB table is not configured", async () => {
      delete process.env.CDK_NEXTJS_REVALIDATION_TABLE_NAME;

      const handlerWithoutTable = new S3CacheHandler({
        context: mockContext,
      });

      await handlerWithoutTable.revalidateTag("test-tag");

      expect(mockDynamoSend).not.toHaveBeenCalled();
    });

    it("should handle DynamoDB errors gracefully", async () => {
      mockDynamoSend.mockRejectedValueOnce(new Error("DynamoDB Error"));

      // Should not throw
      await expect(handler.revalidateTag("error-tag")).resolves.not.toThrow();
    });

    it("should create a CloudFront invalidation for affected paths when a distribution parameter is configured", async () => {
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });

      const mockQueryResponse = {
        Items: [
          { sk: { S: "test-tag#test-build-id/isr/1.json" } },
          { sk: { S: "test-tag#test-build-id/isr/2.json" } },
        ],
      };

      dynamoResponses({ query: mockQueryResponse });
      mockS3Send.mockResolvedValue({}); // For delete commands
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithDistribution.revalidateTag("test-tag");

      expect(mockSsmSend).toHaveBeenCalledWith(expect.any(Object));
      expect(mockCloudFrontSend).toHaveBeenCalledWith(
        expect.any(CreateInvalidationCommand),
      );
      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      expect(invalidationInput.DistributionId).toBe("test-distribution-id");
      // One trailing wildcard per page: an invalidation path matches only the
      // query string it spells out, and a page's RSC payload is cached under
      // `?_rsc=<hash>` - `/isr/1*` covers it, and the slash variant, for one
      // of the fifteen wildcards instead of two.
      expect(invalidationInput.InvalidationBatch.Paths.Items).toEqual([
        "/isr/1*",
        "/isr/2*",
      ]);
    });

    /**
     * next >= 16.3.8 scopes a page's key by its source route:
     * `route-cache/<kind>/<hash>/$<pathname>`, the pathname through
     * `normalizePagePath`. Read as a path, it named no URI the distribution has.
     */
    it("invalidates the pathname inside a next 16.3.8 route-cache key", async () => {
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });
      const key = (pathname: string) =>
        `test-tag#test-build-id/route-cache/APP_PAGE/${"a".repeat(64)}/$${pathname}.json`;
      dynamoResponses({
        query: {
          Items: [
            { sk: { S: key("/isr/1") } },
            { sk: { S: key("/index/index") } },
          ],
        },
      });
      mockS3Send.mockResolvedValue({});
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithDistribution.revalidateTag("test-tag");

      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      expect(invalidationInput.InvalidationBatch.Paths.Items).toEqual([
        "/isr/1*",
        "/index*",
      ]);
    });

    it("invalidates the path of a mapping row whose key is in s3Key", async () => {
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });
      dynamoResponses({
        query: {
          Items: [
            {
              sk: { S: `test-tag#test-build-id/#${"b".repeat(64)}` },
              s3Key: { S: "test-build-id/long/page.json" },
            },
          ],
        },
      });
      mockS3Send.mockResolvedValue({});
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithDistribution.revalidateTag("test-tag");

      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      expect(invalidationInput.InvalidationBatch.Paths.Items).toEqual([
        "/long/page*",
      ]);
    });

    it("does not read a marker row one `#` longer as a mapping row", async () => {
      // No build ID leaves no key prefix to tell the two apart by, and the
      // marker row of tag `test-tag#` (sk `test-tag#`) matches `test-tag#`.
      process.env.CDK_NEXTJS_BUILD_ID = "";
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });
      dynamoResponses({ query: { Items: [{ sk: { S: "test-tag#" } }] } });
      mockS3Send.mockResolvedValue({});
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithDistribution.revalidateTag("test-tag");

      expect(CreateInvalidationCommand).not.toHaveBeenCalled();
    });

    it("invalidates an older app's route named /route-cache", async () => {
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });
      dynamoResponses({
        query: {
          Items: [{ sk: { S: "test-tag#test-build-id/route-cache/foo.json" } }],
        },
      });
      mockS3Send.mockResolvedValue({});
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithDistribution.revalidateTag("test-tag");

      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      expect(invalidationInput.InvalidationBatch.Paths.Items).toEqual([
        "/route-cache/foo*",
      ]);
    });

    it("invalidates a distribution whose ID is in the environment without SSM", async () => {
      // NextjsGlobalContainers: the task can name the distribution directly.
      process.env.CDK_NEXTJS_DISTRIBUTION_ID = "direct-distribution-id";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });
      dynamoResponses({
        query: { Items: [{ sk: { S: "test-tag#test-build-id/isr/1.json" } }] },
      });
      mockS3Send.mockResolvedValue({});
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithDistribution.revalidateTag("test-tag");

      expect(mockSsmSend).not.toHaveBeenCalled();
      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      expect(invalidationInput.DistributionId).toBe("direct-distribution-id");
    });

    it("splits a mapping row at the tag's length, so a tag containing # still resolves", async () => {
      // A tag is app-defined: `revalidateTag("user#42")` is legal. Splitting at
      // the first "#" left "42#test-build-id/account.json" as the S3 key, whose
      // invalidation path names nothing CloudFront cached, so the page stayed
      // stale while the row was stamped revalidated and never retried.
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });

      dynamoResponses({
        query: { Items: [{ sk: { S: "user#42#test-build-id/account.json" } }] },
      });
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithDistribution.revalidateTag("user#42");

      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      expect(invalidationInput.InvalidationBatch.Paths.Items).toEqual([
        "/account*",
      ]);
    });

    it("invalidates the path a revalidatePath tag names even with no mapping rows", async () => {
      // A build-time prerender has no mapping rows, so the query comes back
      // empty and there is nothing to derive a CloudFront path from - except the
      // tag, which for `revalidatePath` is `_N_T_<path>`. Without this the CDN
      // answers with the pre-revalidation page until `s-maxage=31536000`
      // expires. Measured against next.js's `test/e2e/app-dir/trailingslash`.
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });

      dynamoResponses({ query: { Items: [] } });
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithDistribution.revalidateTag("_N_T_/en/legacy/");

      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      // Both slash variants, which the trailing wildcard covers: a
      // `trailingSlash` app's cached URI is the redirect target, not the route.
      expect(invalidationInput.InvalidationBatch.Paths.Items).toEqual([
        "/en/legacy*",
      ]);
    });

    it("invalidates the URI under the app's basePath, not the bare route", async () => {
      // CloudFront cached `/base/isr/1`; the cache key and the `revalidatePath`
      // tag both name `/isr/1`, because Next.js strips `basePath` before routing
      // and never shows it to the cache handler. Invalidating the bare route
      // matches nothing at the edge, so the stale page survives until
      // `s-maxage` expires.
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      useBasePath();
      const handlerWithBasePath = new S3CacheHandler({
        context: mockContext,
      });

      dynamoResponses({
        query: {
          Items: [
            { sk: { S: "test-tag#test-build-id/isr/1.json" } },
            { sk: { S: "test-tag#test-build-id/index.json" } },
          ],
        },
      });
      mockS3Send.mockResolvedValue({});
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithBasePath.revalidateTag("test-tag");

      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      expect(invalidationInput.InvalidationBatch.Paths.Items).toEqual(
        expect.arrayContaining([
          "/base/isr/1*",
          // The app's root under a `basePath` is `/base`, not `/base/`, and
          // spelled out: `/base*` would be the whole app.
          "/base",
          "/base?*",
          "/base/",
          "/base/?*",
        ]),
      );
      expect(invalidationInput.InvalidationBatch.Paths.Items).not.toContain(
        "/isr/1",
      );
    });

    it("adds the basePath to a revalidatePath tag's path too", async () => {
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      useBasePath();
      const handlerWithBasePath = new S3CacheHandler({
        context: mockContext,
      });

      dynamoResponses({ query: { Items: [] } });
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithBasePath.revalidateTag("_N_T_/blog");

      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      expect(invalidationInput.InvalidationBatch.Paths.Items).toEqual([
        "/base/blog*",
      ]);
    });

    it("does not invalidate a CloudFront path for an app tag", async () => {
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });

      dynamoResponses({ query: { Items: [] } });

      await handlerWithDistribution.revalidateTag("posts");

      // Nothing to invalidate: an app tag names no path, and no entry is mapped
      // to it.
      expect(mockCloudFrontSend).not.toHaveBeenCalled();
    });

    it("should not call SSM or CloudFront when no distribution parameter is configured", async () => {
      const mockQueryResponse = {
        Items: [{ sk: { S: "test-tag#test-build-id/isr/1.json" } }],
      };

      dynamoResponses({ query: mockQueryResponse });
      mockS3Send.mockResolvedValue({});

      await handler.revalidateTag("test-tag");

      expect(mockSsmSend).not.toHaveBeenCalled();
      expect(mockCloudFrontSend).not.toHaveBeenCalled();
    });

    it("should handle SSM/CloudFront invalidation errors gracefully", async () => {
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });

      const mockQueryResponse = {
        Items: [{ sk: { S: "test-tag#test-build-id/isr/1.json" } }],
      };

      dynamoResponses({ query: mockQueryResponse });
      mockS3Send.mockResolvedValue({});
      mockSsmSend.mockRejectedValueOnce(new Error("SSM Error"));

      await expect(
        handlerWithDistribution.revalidateTag("test-tag"),
      ).resolves.not.toThrow();
    });

    it("invalidates the page itself for a revalidatePath(path, 'page') tag", async () => {
      // `revalidatePath(path, type)` appends the type to the implicit tag, so the
      // tag reads `_N_T_/pricing/page` - a path no URL has. Taking it literally
      // invalidated nothing that existed, which is the whole of the bug: the
      // second argument silently turned CDN invalidation off.
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });

      dynamoResponses({ query: { Items: [] } });
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithDistribution.revalidateTag("_N_T_/pricing/page");

      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      expect(invalidationInput.InvalidationBatch.Paths.Items).toEqual(
        expect.arrayContaining(["/pricing*"]),
      );
    });

    it("skips mapping rows that name no cached URI", async () => {
      // A dynamic template and a fetch-cache entry are both rows a real tag
      // carries, and neither is a URL: `/blog/[slug]` matches nothing at the edge
      // (CloudFront has no such URI), and a fetch key is a hash of the request.
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });

      dynamoResponses({
        query: {
          Items: [
            { sk: { S: "test-tag#test-build-id/blog/[slug].json" } },
            {
              sk: {
                S: "test-tag#test-build-id/0123456789abcdef0123456789abcdef.json",
              },
            },
            { sk: { S: "test-tag#test-build-id/blog/hello.json" } },
          ],
        },
      });
      mockS3Send.mockResolvedValue({});
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithDistribution.revalidateTag("test-tag");

      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      const items: string[] = invalidationInput.InvalidationBatch.Paths.Items;
      expect(items).toEqual(["/blog/hello*"]);
      expect(items.some((path) => path.includes("["))).toBe(false);
      expect(items.some((path) => path.includes("0123456789abcdef"))).toBe(
        false,
      );
    });

    it("walks every Query page of a tag's mapping rows", async () => {
      // One `Query` answers with at most 1 MB. A tag on a large app runs past
      // that, and taking only the first page deleted some of the tag's entries
      // and invalidated only some of its paths - a partial revalidation that
      // looks like a cache bug.
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });

      let queries = 0;
      mockDynamoSend.mockImplementation((command: unknown) => {
        if (command instanceof QueryCommand) {
          queries++;
          return Promise.resolve(
            queries === 1
              ? {
                  Items: [{ sk: { S: "test-tag#test-build-id/isr/1.json" } }],
                  LastEvaluatedKey: { pk: { S: "test-build-id" } },
                }
              : { Items: [{ sk: { S: "test-tag#test-build-id/isr/2.json" } }] },
          );
        }
        return Promise.resolve({});
      });
      mockS3Send.mockResolvedValue({});
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithDistribution.revalidateTag("test-tag");

      expect(queries).toBe(2);
      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      expect(invalidationInput.InvalidationBatch.Paths.Items).toEqual([
        "/isr/1*",
        "/isr/2*",
      ]);
    });

    it("collapses to one app-wide wildcard rather than sending many invalidations", async () => {
      // CloudFront caps a request at 15 wildcard paths and allows 15
      // invalidations in progress. A tag covering hundreds of pages therefore
      // cannot be spelled out: sending a request per 15 paths throttles, and a
      // throttled request is a page that stays stale.
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      const handlerWithDistribution = new S3CacheHandler({
        context: mockContext,
      });

      dynamoResponses({
        query: {
          Items: Array.from({ length: 200 }, (_, i) => ({
            sk: { S: `test-tag#test-build-id/isr/${i}.json` },
          })),
        },
      });
      mockS3Send.mockResolvedValue({});
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await handlerWithDistribution.revalidateTag("test-tag");

      expect(mockCloudFrontSend).toHaveBeenCalledTimes(1);
      const [invalidationInput] = (
        CreateInvalidationCommand as unknown as jest.Mock
      ).mock.calls[0];
      expect(invalidationInput.InvalidationBatch.Paths.Items).toEqual(["/*"]);
    });

    /** A handler with a distribution, and DynamoDB answering `query` for it. */
    const withDistribution = (query: unknown) => {
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      dynamoResponses({ query });
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});
      return new S3CacheHandler({ context: mockContext });
    };
    const invalidations = (): string[][] =>
      (CreateInvalidationCommand as unknown as jest.Mock).mock.calls.map(
        ([input]) => input.InvalidationBatch.Paths.Items,
      );
    const pages = (tag: string, count: number) => ({
      Items: Array.from({ length: count }, (_, i) => ({
        sk: { S: `${tag}#test-build-id/isr/${i}.json` },
      })),
    });

    it("sends a tag's paths as one request while they fit", async () => {
      // CloudFront's wildcard quota is shared by every invalidation in
      // progress on the distribution. Splitting ten pages' twenty wildcards
      // into two back-to-back requests had the second rejected, and its pages
      // stayed stale at the edge.
      await withDistribution(pages("test-tag", 10)).revalidateTag("test-tag");

      expect(invalidations()).toHaveLength(1);
      expect(invalidations()[0]).toHaveLength(10);
    });

    it("collapses to the whole app past fifteen wildcards", async () => {
      await withDistribution(pages("test-tag", 16)).revalidateTag("test-tag");

      expect(invalidations()).toEqual([["/*"]]);
    });

    it("collapses to the whole app under a basePath, its root included", async () => {
      // Not `/base*`, which would also invalidate a sibling app at `/base2`.
      useBasePath();
      await withDistribution(pages("test-tag", 16)).revalidateTag("test-tag");

      expect(invalidations()).toEqual([["/base", "/base?*", "/base/*"]]);
    });

    it("invalidates the whole app under a basePath when a tag's rows cannot be read", async () => {
      useBasePath();
      jest.spyOn(console, "error").mockImplementation();
      const cdnHandler = withDistribution({ Items: [] });
      mockDynamoSend.mockImplementation((command: unknown) =>
        command instanceof QueryCommand
          ? Promise.reject(new Error("ProvisionedThroughputExceeded"))
          : Promise.resolve({}),
      );

      await cdnHandler.revalidateTag("posts");

      expect(invalidations()).toEqual([["/base", "/base?*", "/base/*"]]);
    });

    it("percent-encodes the routes it invalidates", async () => {
      // Cache keys are decoded pathnames, while CloudFront caches - and
      // invalidation paths match - the encoded URI the browser sent.
      await withDistribution({
        Items: [
          { sk: { S: "test-tag#test-build-id/blog/héllo.json" } },
          { sk: { S: "test-tag#test-build-id/blog/hello world.json" } },
          // Path delimiters Next.js re-escaped in the key stay as they are.
          { sk: { S: "test-tag#test-build-id/files/a%2Fb.json" } },
          { sk: { S: "test-tag#test-build-id/@user/50%.json" } },
        ],
      }).revalidateTag(["test-tag", "_N_T_/tags/c#?"]);

      expect(invalidations()).toEqual([
        [
          "/blog/h%C3%A9llo*",
          "/blog/hello%20world*",
          "/files/a%2Fb*",
          "/@user/50%25*",
          "/tags/c%23%3F*",
        ],
      ]);
    });

    it("invalidates every tag of one call in a single request", async () => {
      // `revalidateTag` hands the handler every tag a request revalidated at
      // once; a request per tag competes for the same quota.
      await withDistribution({ Items: [] }).revalidateTag([
        "_N_T_/a",
        "_N_T_/b",
      ]);

      expect(invalidations()).toEqual([["/a*", "/b*"]]);
    });

    it("invalidates the whole app when a tag has more rows than it walks", async () => {
      // The rows past the last page walked are pages too; invalidating only the
      // ones read left the rest stale at the edge for up to a year.
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      mockDynamoSend.mockImplementation((command: unknown) =>
        Promise.resolve(
          command instanceof QueryCommand
            ? {
                Items: [{ sk: { S: "test-tag#test-build-id/isr/1.json" } }],
                LastEvaluatedKey: { pk: { S: "test-build-id" } },
              }
            : {},
        ),
      );
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await new S3CacheHandler({ context: mockContext }).revalidateTag(
        "test-tag",
      );

      expect(invalidations()).toEqual([["/*"]]);
    });

    it("ignores rows that another tag sharing the prefix owns", async () => {
      // `begins_with(sk, "user#")` also matches the tag `user#42`: its bare
      // marker row, and its mapping rows. Read as `user`'s, they became
      // invalidation paths like `/42` that name nothing.
      await withDistribution({
        Items: [
          { sk: { S: "user#42" } },
          { sk: { S: "user#42#test-build-id/account.json" } },
          { sk: { S: "user#test-build-id/profile.json" } },
        ],
      }).revalidateTag("user");

      expect(invalidations()).toEqual([["/profile*"]]);
    });

    it("adds the build-time prerenders the build's tag manifest names, reading it once", async () => {
      // A prerender is written by the adapter, never through `set`, so it has
      // no mapping row: the manifest is the only record of its tags.
      const cdnHandler = withDistribution({
        Items: [{ sk: { S: "posts#test-build-id/blog/b.json" } }],
      });
      const manifestGets = () =>
        (GetObjectCommand as unknown as jest.Mock).mock.calls.filter(
          ([input]) =>
            input.Key === "test-build-id/_cdk-nextjs-tag-manifest.json",
        );
      mockS3Send.mockImplementation((command: unknown) =>
        Promise.resolve(
          command instanceof GetObjectCommand
            ? {
                Body: {
                  transformToString: async () =>
                    JSON.stringify({ posts: ["blog/a", "index"] }),
                },
              }
            : {},
        ),
      );

      await cdnHandler.revalidateTag("posts");
      await cdnHandler.revalidateTag("constructor");

      expect(invalidations()).toEqual([["/blog/b*", "/blog/a*", "/", "/?*"]]);
      expect(manifestGets()).toHaveLength(1);
    });

    it("invalidates the whole app when the build's tag manifest cannot be read, and reads it again next time", async () => {
      const cdnHandler = withDistribution({ Items: [] });
      mockS3Send.mockRejectedValueOnce(new Error("AccessDenied"));

      await cdnHandler.revalidateTag("posts");
      await cdnHandler.revalidateTag("posts");

      expect(invalidations()).toEqual([["/*"]]);
      expect(mockS3Send).toHaveBeenCalledTimes(2);
    });

    it("invalidates the whole app when a tag's marker row cannot be written", async () => {
      // Other instances would never see the revalidation, so no path list is
      // enough.
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      jest.spyOn(console, "error").mockImplementation();
      mockDynamoSend.mockImplementation((command: unknown) =>
        command instanceof QueryCommand
          ? Promise.resolve({ Items: [] })
          : Promise.reject(new Error("ProvisionedThroughputExceeded")),
      );
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await new S3CacheHandler({ context: mockContext }).revalidateTag("posts");

      expect(invalidations()).toEqual([["/*"]]);
    });

    it("invalidates the whole app when a tag's mapping rows cannot be read", async () => {
      // The marker row is written before the Query, so a failed Query leaves
      // the tag revalidated at the origin with no paths named for the edge.
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "test-param-name";
      jest.spyOn(console, "error").mockImplementation();
      mockDynamoSend.mockImplementation((command: unknown) =>
        command instanceof QueryCommand
          ? Promise.reject(new Error("ProvisionedThroughputExceeded"))
          : Promise.resolve({}),
      );
      mockSsmSend.mockResolvedValue({
        Parameter: { Value: "test-distribution-id" },
      });
      mockCloudFrontSend.mockResolvedValue({});

      await new S3CacheHandler({ context: mockContext }).revalidateTag([
        "_N_T_/a",
        "posts",
      ]);

      expect(invalidations()).toEqual([["/*"]]);
    });

    describe("when CloudFront's invalidation quota is full", () => {
      beforeEach(() => {
        jest.useFakeTimers();
      });
      afterEach(() => {
        jest.useRealTimers();
      });

      const quotaError = () =>
        Object.assign(
          new Error("Your request contains too many invalidations"),
          {
            name: "TooManyInvalidationsInProgress",
          },
        );

      it("retries as one app-wide wildcard after a backoff", async () => {
        const cdnHandler = withDistribution(pages("test-tag", 2));
        mockCloudFrontSend
          .mockRejectedValueOnce(quotaError())
          .mockResolvedValueOnce({});

        const done = cdnHandler.revalidateTag("test-tag");
        await jest.advanceTimersByTimeAsync(1000);
        await done;

        expect(invalidations()).toEqual([["/isr/0*", "/isr/1*"], ["/*"]]);
      });

      it("gives up after the last retry", async () => {
        const cdnHandler = withDistribution(pages("test-tag", 1));
        mockCloudFrontSend.mockRejectedValue(quotaError());

        const done = cdnHandler.revalidateTag("test-tag");
        await jest.advanceTimersByTimeAsync(3000);
        await expect(done).resolves.toBeUndefined();

        expect(invalidations()).toEqual([["/isr/0*"], ["/*"], ["/*"]]);
      });

      it("does not retry any other error", async () => {
        const cdnHandler = withDistribution(pages("test-tag", 1));
        mockCloudFrontSend.mockRejectedValue(new Error("AccessDenied"));

        await cdnHandler.revalidateTag("test-tag");

        expect(invalidations()).toEqual([["/isr/0*"]]);
      });

      it("retries the app's root under a basePath too", async () => {
        // `/base/*` matches neither `/base` nor `/base?_rsc=…`: retrying
        // `revalidatePath("/")` as that left the home page stale at the edge.
        useBasePath();
        const cdnHandler = withDistribution({ Items: [] });
        mockCloudFrontSend
          .mockRejectedValueOnce(quotaError())
          .mockResolvedValueOnce({});

        const done = cdnHandler.revalidateTag("_N_T_/");
        await jest.advanceTimersByTimeAsync(1000);
        await done;

        expect(invalidations()[1]).toEqual(["/base", "/base?*", "/base/*"]);
      });
    });

    it("records a profile's revalidation as stale now, expiring later", async () => {
      const before = Date.now();
      await handler.revalidateTag("posts", { expire: 60 });

      const [input] = (UpdateItemCommand as unknown as jest.Mock).mock.calls[0];
      expect(input.Key.sk.S).toBe("posts");
      expect(input.UpdateExpression).toBe(
        "SET staleAt = :staleAt, expiredAt = :expiredAt",
      );
      const staleAt = Number(input.ExpressionAttributeValues[":staleAt"].N);
      expect(staleAt).toBeGreaterThanOrEqual(before);
      expect(Number(input.ExpressionAttributeValues[":expiredAt"].N)).toBe(
        staleAt + 60_000,
      );
    });
  });

  /**
   * The cache handler's half of `res.revalidate()`'s CDN invalidation: the hook
   * it registers for `invalidateRevalidatedPage` in `runtime/core.ts`. The
   * runtime's half is in `core.test.ts`.
   */
  describe("the revalidated-page hook", () => {
    const HOOK = REVALIDATED_PAGE_HOOK;
    const globals = globalThis as Record<symbol, unknown>;
    type Hook = (routes: readonly string[]) => Promise<void>;

    beforeEach(() => {
      delete globals[HOOK];
      mockSsmSend.mockResolvedValue({ Parameter: { Value: "EDISTRIBUTION" } });
      mockCloudFrontSend.mockResolvedValue({});
      (CreateInvalidationCommand as unknown as jest.Mock).mockClear();
    });

    function invalidatedPaths(): string[] {
      const [input] = (CreateInvalidationCommand as unknown as jest.Mock).mock
        .calls[0];
      return input.InvalidationBatch.Paths.Items;
    }

    it("is registered only behind a distribution", () => {
      new S3CacheHandler({ context: mockContext });
      expect(globals[HOOK]).toBeUndefined();

      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "param";
      new S3CacheHandler({ context: mockContext });
      expect(typeof globals[HOOK]).toBe("function");
    });

    it("invalidates the page and its data route under basePath", async () => {
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "param";
      new S3CacheHandler({ context: mockContext, basePath: "base" });
      await (globals[HOOK] as Hook)([
        "/blog/hello",
        "/_next/data/test-build-id/blog/hello.json",
      ]);
      expect(invalidatedPaths()).toEqual([
        "/base/blog/hello*",
        "/base/_next/data/test-build-id/blog/hello.json*",
      ]);
    });

    it("spells out the root rather than invalidating the whole app", async () => {
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "param";
      new S3CacheHandler({ context: mockContext });
      await (globals[HOOK] as Hook)([
        "/",
        "/_next/data/test-build-id/index.json",
      ]);
      expect(invalidatedPaths()).toEqual([
        "/",
        "/?*",
        "/_next/data/test-build-id/index.json*",
      ]);
    });

    it("sends every path once, in one invalidation", async () => {
      process.env.CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME = "param";
      new S3CacheHandler({ context: mockContext });
      await (globals[HOOK] as Hook)([
        "/blog",
        "/_next/data/test-build-id/en/blog.json",
        "/en/blog",
        "/blog",
      ]);
      expect(CreateInvalidationCommand).toHaveBeenCalledTimes(1);
      expect(invalidatedPaths()).toEqual([
        "/blog*",
        "/_next/data/test-build-id/en/blog.json*",
        "/en/blog*",
      ]);
    });
  });

  describe("resetRequestCache", () => {
    it("should complete without errors", async () => {
      await expect(handler.resetRequestCache()).resolves.not.toThrow();
    });
  });
});

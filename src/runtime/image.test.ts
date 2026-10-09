/* eslint-disable import/no-extraneous-dependencies */
jest.mock("@aws-sdk/client-s3");
// The real module, with the one step that needs `sharp` stubbed out: these tests
// are about the response `handle` writes, not about optimizing an image.
jest.mock("next/dist/server/image-optimizer.js", () => ({
  ...jest.requireActual("next/dist/server/image-optimizer.js"),
  imageOptimizer: jest.fn(),
}));

import { mkdirSync, mkdtempSync } from "node:fs";
import { validateHeaderValue } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { imageOptimizer } from "next/dist/server/image-optimizer.js";
import { imageConfigDefault } from "next/dist/shared/lib/image-config.js";
import { ShimIncomingMessage } from "./http/request";
import { ResponseHead, ShimServerResponse } from "./http/response";
import { pipeToSink } from "./http/sink";
import {
  ImageOptimizerOptions,
  newImageResponseCache,
  RuntimeImageOptimizer,
} from "./image";
import { AdapterManifest } from "./manifest";
import { useNextFrom } from "./next-modules";

const PNG = Buffer.from("optimized-bytes");
const ETAG = "abc123";

/** A deployment root, which the dist dir the image cache uses sits under. */
function stage(): string {
  const root = mkdtempSync(join(tmpdir(), "cdk-nextjs-image-"));
  mkdirSync(join(root, ".next"));
  return root;
}

/** The app's `cacheHandler`, reduced to a map: what the S3 handler is to it. */
class MapCacheHandler {
  public static readonly entries = new Map<string, unknown>();
  public static options: Record<string, unknown> | undefined;
  public constructor(options: Record<string, unknown>) {
    MapCacheHandler.options = options;
  }
  public async get(key: string) {
    return MapCacheHandler.entries.get(key) ?? null;
  }
  public async set(key: string, value: unknown) {
    MapCacheHandler.entries.set(key, { value, lastModified: Date.now() });
  }
}

let imported: string | undefined;

const s3Hit = {
  send: async () => ({
    Body: [Buffer.from("upstream-bytes")],
    ContentType: "image/png",
    ETag: '"upstream"',
  }),
} as unknown as S3Client;

/** An optimizer over {@link MapCacheHandler}, as the adapter configures one. */
function optimizerFor(
  options: {
    images?: Record<string, unknown>;
    fetchInternal?: ImageOptimizerOptions["fetchInternal"];
    importModule?: ImageOptimizerOptions["importModule"];
    s3?: S3Client;
    bucket?: string;
  } = {},
): RuntimeImageOptimizer {
  const via = new RuntimeImageOptimizer({
    deploymentRoot: stage(),
    // Just the fields `loadImageRuntime` reads.
    manifest: {
      relativeProjectDir: "",
      config: {
        basePath: "",
        assetPrefix: "",
        distDir: ".next",
        experimental: {},
        images: {
          ...imageConfigDefault,
          localPatterns: undefined,
          ...options.images,
        },
        cacheHandler:
          "../node_modules/cdk-nextjs/lib/adapter/cache-handler.mjs",
        cacheMaxMemorySize: 0,
      },
    } as unknown as AdapterManifest,
    bucket: options.bucket ?? "assets",
    bucketKeyPrefix: "",
    fetchInternal:
      options.fetchInternal ??
      (async () => {
        throw new Error("Unexpected fetchInternal");
      }),
    importModule:
      options.importModule ??
      (async (url) => {
        imported = url;
        return { default: MapCacheHandler };
      }),
  });
  (via as unknown as { s3: S3Client }).s3 = options.s3 ?? s3Hit;
  return via;
}

let optimizer: RuntimeImageOptimizer;

beforeAll(() => {
  useNextFrom(join(__dirname, "../.."));
  optimizer = optimizerFor();
});

beforeEach(() => {
  MapCacheHandler.entries.clear();
  imported = undefined;
  (imageOptimizer as jest.Mock).mockClear();
  (imageOptimizer as jest.Mock).mockResolvedValue({
    buffer: PNG,
    contentType: "image/webp",
    maxAge: 60,
    etag: ETAG,
  });
});

interface Answer {
  readonly head: ResponseHead;
  readonly body: string;
}

async function request(
  src: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    via?: RuntimeImageOptimizer;
    waitUntil?: (promise: Promise<unknown>) => void;
  } = {},
): Promise<Answer> {
  const url = new URL(
    `https://shop.example.test/_next/image?url=${encodeURIComponent(src)}&w=640&q=75`,
  );
  const req = new ShimIncomingMessage({
    method: init.method ?? "GET",
    url: `${url.pathname}${url.search}`,
    headers: { accept: "image/webp", ...init.headers },
  });
  const res = new ShimServerResponse();
  let head: ResponseHead | undefined;
  const chunks: Buffer[] = [];
  const done = pipeToSink(
    req,
    res,
    {
      begin(responseHead) {
        head = responseHead;
        return new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
          },
        });
      },
    },
    { compress: false },
  );
  const pending: Array<Promise<unknown>> = [];
  await (init.via ?? optimizer).handle(
    req,
    res,
    url,
    init.waitUntil ?? ((promise) => pending.push(promise)),
  );
  await done;
  // Settled, not awaited: the runtime logs a rejection rather than failing on it.
  await Promise.allSettled(pending);
  return { head: head!, body: Buffer.concat(chunks).toString() };
}

describe("newImageResponseCache", () => {
  type ResponseCacheClass = Parameters<typeof newImageResponseCache>[0];

  /** next < 16.3.8's `ResponseCache`: `(minimal_mode, maxSize, ttl)`. */
  class LegacyResponseCache {
    readonly minimal_mode: unknown;
    constructor(minimalMode: unknown) {
      this.minimal_mode = minimalMode;
    }
  }
  /**
   * next >= 16.3.8's: `({ minimalMode, route, ... })`, throwing without a route.
   * The field is renamed here to show the choice doesn't depend on it.
   */
  class RouteResponseCache {
    readonly mode: unknown;
    constructor({
      minimalMode,
      route,
    }: {
      minimalMode: boolean;
      route?: unknown;
    }) {
      if (!route) throw new Error("Response cache requires a source route");
      this.mode = minimalMode;
    }
  }
  const construct = (ResponseCache: new (arg: never) => object) =>
    newImageResponseCache(
      ResponseCache as unknown as ResponseCacheClass,
    ) as unknown as Record<string, unknown>;

  it("passes { minimalMode, route: 'image' } to a next that takes it", () => {
    const cache = construct(RouteResponseCache);
    expect(cache).toBeInstanceOf(RouteResponseCache);
    expect(cache.mode).toBe(false);
  });

  // By what the constructor accepts, not the version: a canary cut before
  // 16.3.8's change reads as newer than it.
  it("passes minimalMode alone to a next that took the options as minimalMode", () => {
    const cache = construct(LegacyResponseCache);
    expect(cache).toBeInstanceOf(LegacyResponseCache);
    expect(cache.minimal_mode).toBe(false);
  });

  it("rethrows a constructor error that isn't the missing route", () => {
    class BrokenResponseCache {
      constructor() {
        throw new Error("boom");
      }
    }
    expect(() => construct(BrokenResponseCache)).toThrow("boom");
  });
});

describe("RuntimeImageOptimizer.isEnabled", () => {
  const withImages = (images: Record<string, unknown>) =>
    optimizerFor({ images });

  // Where `next start` answers 404 rather than optimize.
  it("is off for images.unoptimized and for a non-default loader", () => {
    expect(withImages({}).isEnabled()).toBe(true);
    expect(withImages({ unoptimized: true }).isEnabled()).toBe(false);
    expect(
      withImages({ loader: "custom", loaderFile: "./loader.js" }).isEnabled(),
    ).toBe(false);
  });
});

describe("RuntimeImageOptimizer response", () => {
  it("answers with the headers next start sends", async () => {
    const { head, body } = await request("/photos/logo.png");
    expect(head.statusCode).toBe(200);
    expect(head.headers).toMatchObject({
      "cache-control": "public, max-age=60, must-revalidate",
      "content-type": "image/webp",
      "content-length": String(PNG.length),
      "content-disposition": 'attachment; filename="logo.webp"',
      "content-security-policy": imageConfigDefault.contentSecurityPolicy,
      etag: ETAG,
      vary: "Accept",
      "x-nextjs-cache": "MISS",
    });
    expect(body).toBe(PNG.toString());
  });

  // Content-hashed, so the name changes whenever the bytes do.
  it("caches a statically imported image for a year, immutable", async () => {
    const { head } = await request("/_next/static/media/logo.3f2a1c.png");
    expect(head.headers["cache-control"]).toBe(
      "public, max-age=315360000, immutable",
    );
  });

  // `writeHead` rejects a header value outside latin1 with ERR_INVALID_CHAR,
  // and the Lambda sink writes the head through it.
  it("encodes a non-latin1 filename rather than sending it raw", async () => {
    const { head } = await request("/ümlaut-写真.png");
    const disposition = head.headers["content-disposition"];
    expect(disposition).toMatch(/^attachment; filename="[^"]*"; filename\*=/);
    expect(disposition).toContain(
      `filename*=UTF-8''${encodeURIComponent("ümlaut-写真.webp")}`,
    );
    expect(() =>
      validateHeaderValue("Content-Disposition", disposition),
    ).not.toThrow();
  });

  it.each([
    ["the exact tag", ETAG],
    ["a weak form of it", `W/${ETAG}`],
    ["a list containing it", `"other", ${ETAG}`],
    ["a wildcard", "*"],
  ])("answers 304 to If-None-Match with %s", async (_name, ifNoneMatch) => {
    const { head, body } = await request("/logo.png", {
      headers: { "if-none-match": ifNoneMatch },
    });
    expect(head.statusCode).toBe(304);
    expect(head.headers.etag).toBe(ETAG);
    expect(head.headers["cache-control"]).toBe(
      "public, max-age=60, must-revalidate",
    );
    expect(body).toBe("");
  });

  it("answers 200 to an If-None-Match that does not match", async () => {
    const { head } = await request("/logo.png", {
      headers: { "if-none-match": '"other"' },
    });
    expect(head.statusCode).toBe(200);
  });

  it("sends the headers but no body to HEAD", async () => {
    const { head, body } = await request("/logo.png", { method: "HEAD" });
    expect(head.statusCode).toBe(200);
    expect(head.headers["content-length"]).toBe(String(PNG.length));
    expect(body).toBe("");
  });
});

describe("RuntimeImageOptimizer sources", () => {
  // `next start` fetches a remote source only when `remotePatterns` or `domains`
  // allow it; the stage's config allows none. Anything else would make the
  // optimizer an open proxy into whatever it can reach.
  it.each([
    ["another origin", "https://evil.example.test/x.png"],
    ["instance metadata", "http://169.254.169.254/latest/meta-data/"],
    ["a protocol-relative url", "//evil.example.test/x.png"],
  ])("rejects a remote source that is not allowed: %s", async (_name, src) => {
    const { head, body } = await request(src);
    expect(head.statusCode).toBe(400);
    expect(body).toMatch(/"url" parameter/);
    expect(imageOptimizer).not.toHaveBeenCalled();
  });

  function withS3Miss(
    fetchInternal?: ImageOptimizerOptions["fetchInternal"],
  ): RuntimeImageOptimizer {
    return optimizerFor({
      fetchInternal,
      s3: {
        send: async () => {
          throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
        },
      } as unknown as S3Client,
    });
  }

  it("falls back to the app's routes for a source S3 has no file for", async () => {
    const fetchInternal = jest.fn(async () => ({
      statusCode: 200,
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=120",
      },
      body: Buffer.from("route-bytes"),
    }));
    const { head } = await request("/api/avatar?id=42", {
      via: withS3Miss(fetchInternal),
    });
    expect(head.statusCode).toBe(200);
    expect(fetchInternal).toHaveBeenCalledWith(
      "/api/avatar?id=42",
      expect.anything(),
      imageConfigDefault.maximumResponseBody,
    );
    expect((imageOptimizer as jest.Mock).mock.lastCall[0]).toMatchObject({
      buffer: Buffer.from("route-bytes"),
      contentType: "image/png",
      cacheControl: "public, max-age=120",
    });
  });

  // `NextjsRegionalContainers`: the file is on disk, and a GetObject for it is
  // a wasted round trip.
  it("goes straight to the app's routes when there is no bucket", async () => {
    const send = jest.fn();
    const fetchInternal = jest.fn(async () => ({
      statusCode: 200,
      headers: { "content-type": "image/png" },
      body: Buffer.from("disk-bytes"),
    }));
    const { head } = await request("/logo.png", {
      via: optimizerFor({
        bucket: "",
        fetchInternal,
        s3: { send } as unknown as S3Client,
      }),
    });
    expect(head.statusCode).toBe(200);
    expect(send).not.toHaveBeenCalled();
    expect(fetchInternal).toHaveBeenCalledWith(
      "/logo.png",
      expect.anything(),
      imageConfigDefault.maximumResponseBody,
    );
  });

  it("answers 400 when the route sends no body", async () => {
    const { head } = await request("/api/avatar?id=42", {
      via: withS3Miss(async () => ({
        statusCode: 404,
        headers: {},
        body: Buffer.alloc(0),
      })),
    });
    expect(head.statusCode).toBe(400);
  });

  it("answers an explicit 502 for a source served by another functionGroups group", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { head, body } = await request("/api/avatar?id=42", {
        via: withS3Miss(async () => ({
          statusCode: 0,
          headers: {},
          body: Buffer.alloc(0),
          otherGroup: "avatars",
        })),
      });
      expect(head.statusCode).toBe(502);
      expect(body).toMatch(/another functionGroups group/);
      expect(imageOptimizer).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  // `images.maximumResponseBody`, which `next start` enforces on local
  // sources too: past it, the source is not read into memory.
  it("answers 413 for a route response over maximumResponseBody", async () => {
    const { head } = await request("/api/export", {
      via: withS3Miss(async () => ({
        statusCode: 0,
        headers: {},
        body: Buffer.alloc(0),
        tooLarge: true,
      })),
    });
    expect(head.statusCode).toBe(413);
    expect(imageOptimizer).not.toHaveBeenCalled();
  });

  it("answers 413 for an S3 object over maximumResponseBody", async () => {
    const { head } = await request("/video.mp4", {
      via: optimizerFor({
        images: { maximumResponseBody: 10 },
        s3: {
          send: async () => ({
            Body: [Buffer.from("never read")],
            ContentLength: 11,
          }),
        } as unknown as S3Client,
      }),
    });
    expect(head.statusCode).toBe(413);
    expect(imageOptimizer).not.toHaveBeenCalled();
  });
});

describe("RuntimeImageOptimizer cache", () => {
  it("optimizes once, then answers from the cache handler", async () => {
    const via = optimizerFor();
    const first = await request("/photos/cached.png", { via });
    expect(first.head.headers["x-nextjs-cache"]).toBe("MISS");
    expect(first.body).toBe(PNG.toString());

    const second = await request("/photos/cached.png", { via });
    expect(second.head.statusCode).toBe(200);
    expect(second.head.headers["x-nextjs-cache"]).toBe("HIT");
    expect(second.body).toBe(PNG.toString());
    expect(second.head.headers.etag).toBe(ETAG);
    expect(imageOptimizer).toHaveBeenCalledTimes(1);

    // The entry `next start` would have written.
    const [entry] = [...MapCacheHandler.entries.values()] as Array<{
      value: { kind: string; extension: string };
    }>;
    expect(entry.value).toMatchObject({ kind: "IMAGE", extension: "webp" });
  });

  // Another instance: nothing in memory, so the hit is the cache handler's.
  it("shares the optimized image across instances", async () => {
    await request("/photos/shared.png", { via: optimizerFor() });
    const other = await request("/photos/shared.png", { via: optimizerFor() });
    expect(other.head.headers["x-nextjs-cache"]).toBe("HIT");
    expect(imageOptimizer).toHaveBeenCalledTimes(1);
  });

  // The manifest names it relative to the dist dir.
  it("loads the app's cacheHandler from where next start would", async () => {
    await request("/photos/cached.png", { via: optimizerFor() });
    expect(imported).toMatch(
      /^file:\/\/.*\/node_modules\/cdk-nextjs\/lib\/adapter\/cache-handler\.mjs$/,
    );
    expect(MapCacheHandler.options).toMatchObject({ dev: false });
  });

  // A transient failure loading the cacheHandler (EMFILE in a cold-start
  // burst) must not fail every later image request on the instance.
  it("retries loading the cacheHandler after a failed load", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const importModule = jest
        .fn()
        .mockRejectedValueOnce(new Error("EMFILE"))
        .mockResolvedValue({ default: MapCacheHandler });
      const via = optimizerFor({ importModule });
      expect(
        (await request("/photos/retry.png", { via })).head.statusCode,
      ).toBe(500);
      expect(
        (await request("/photos/retry.png", { via })).head.statusCode,
      ).toBe(200);
      expect(importModule).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
  });

  // The write of a fresh image goes to `waitUntil`, not in front of the
  // response: the image is sent before the cache handler has it.
  it("writes a miss to the cache after answering, through waitUntil", async () => {
    // A write that can't finish until released: if the response waited on it,
    // `request` would never return.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const set = MapCacheHandler.prototype.set;
    MapCacheHandler.prototype.set = async function (key, value) {
      await gate;
      return set.call(this, key, value);
    };
    try {
      const pending: Array<Promise<unknown>> = [];
      const first = await request("/photos/deferred.png", {
        via: optimizerFor(),
        waitUntil: (promise) => pending.push(promise),
      });
      expect(first.head.headers["x-nextjs-cache"]).toBe("MISS");
      expect(MapCacheHandler.entries.size).toBe(0);

      release();
      await Promise.all(pending);
      expect(MapCacheHandler.entries.size).toBe(1);
    } finally {
      MapCacheHandler.prototype.set = set;
    }
  });
});

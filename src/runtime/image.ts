/* eslint-disable import/no-extraneous-dependencies */
/**
 * `/_next/image`, folded into the runtime core.
 *
 * The response is written to a {@link ShimServerResponse} rather than straight to
 * a Lambda response stream, so it composes with routing: dispatch only classifies
 * a request as image optimization *after* middleware has had it, which is what
 * makes `NextResponse.rewrite()` onto an image work. That is also why there is no
 * longer a dedicated image optimization Lambda — middleware never ran for it.
 */
import { readFileSync } from "node:fs";
import { isAbsolute as isAbsolutePath, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { NextConfigComplete } from "next/dist/server/config-shared.js";
import type { CachedRouteKind } from "next/dist/server/response-cache/types.js";
import type { ShimIncomingMessage } from "./http/request";
import { asServerResponse, ShimServerResponse } from "./http/response";
import { fetchFromS3, resolveErrorResponse } from "./image-utils";
import { AdapterManifest } from "./manifest";
import { nextModule } from "./next-modules";
import { firstValue, s3Client } from "./util";

/**
 * Required through {@link nextModule} rather than imported, because `next` is
 * external to the shell bundles and does not resolve from where they sit. Every
 * type here is still the real one: `typeof import(...)` is erased.
 */
interface NextImageModules {
  readonly configShared: typeof import("next/dist/server/config-shared.js");
  readonly imageConfig: typeof import("next/dist/shared/lib/image-config.js");
  readonly optimizer: typeof import("next/dist/server/image-optimizer.js");
  readonly serveStatic: typeof import("next/dist/server/serve-static.js");
}

/** The modules only the image cache needs, loaded with it. */
interface NextImageCacheModules {
  readonly responseCache: typeof import("next/dist/server/response-cache/index.js");
}

/** A `cacheHandler` class, as `next.config`'s `cacheHandler` module exports it. */
type CacheHandlerClass = new (
  options: Record<string, unknown>,
) => NonNullable<
  ConstructorParameters<
    NextImageModules["optimizer"]["ImageOptimizerCache"]
  >[0]["cacheHandler"]
>;

export interface ImageOptimizerOptions {
  readonly deploymentRoot: string;
  readonly manifest: AdapterManifest;
  /** `CDK_NEXTJS_STATIC_ASSETS_BUCKET_NAME`. Empty when no images are served. */
  readonly bucket: string;
  /**
   * `CDK_NEXTJS_STATIC_ASSETS_KEY_PREFIX`. Empty when the assets sit at the root
   * of the bucket, which is the default.
   */
  readonly bucketKeyPrefix: string;
  /**
   * Requests a local source from the app's own routes, for one S3 has no file
   * for: `<Image src="/api/avatar?id=42">`, served by a route handler. `next
   * start` fetches every local source that way (`fetchInternalImage`); here it
   * is the fallback, since nearly every source is a file, and a `GetObject` is
   * far cheaper than a route invocation.
   *
   * Given the request being optimized, for its authority; like `next start`,
   * the viewer's cookies and other headers are not the implementation's to
   * forward.
   * @default - S3 only: a source that is not a file is a 400
   */
  readonly fetchInternal?: (
    href: string,
    req: ShimIncomingMessage,
  ) => Promise<InternalImageResponse>;
  /**
   * Loads the `cacheHandler` module from its file URL. A seam for tests, which
   * run as CommonJS and cannot `import()` a URL.
   * @default - `import()`
   */
  readonly importModule?: (url: string) => Promise<unknown>;
}

/** The response {@link ImageOptimizerOptions.fetchInternal} got. */
export interface InternalImageResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
  /**
   * The `functionGroups` group whose package has the route that serves the
   * source, when it is not this function's: there is no response to use, and
   * the optimizer answers an explicit 502 rather than a "not a valid image".
   */
  readonly otherGroup?: string;
}

/** What `required-server-files.json` is read for. */
interface RequiredServerFiles {
  config: NextConfigComplete;
}

export class RuntimeImageOptimizer {
  private readonly s3 = s3Client();
  private loaded?: ReturnType<typeof loadImageRuntime>;
  private imageCache?: Promise<ImageCache>;

  public constructor(private readonly options: ImageOptimizerOptions) {}

  /**
   * Whether the app serves `/_next/image` at all. `next start` answers 404
   * when `images.unoptimized` is set or a non-default `loader` is configured
   * (`next-server.js`), and so does the runtime: otherwise anyone can make the
   * compute run sharp and write the image cache on an endpoint the app turned
   * off.
   */
  public isEnabled(): boolean {
    this.loaded ??= loadImageRuntime(this.options);
    const { imagesConfig } = this.loaded;
    return imagesConfig.loader === "default" && !imagesConfig.unoptimized;
  }

  public async handle(
    req: ShimIncomingMessage,
    res: ShimServerResponse,
    url: URL,
    waitUntil?: (promise: Promise<unknown>) => void,
  ): Promise<void> {
    // Resolved on the first image request rather than at cold start: an app with
    // no `<Image>` should pay neither the `next` module loads nor the
    // `required-server-files.json` parse.
    this.loaded ??= loadImageRuntime(this.options);
    const { next, nextConfig, imagesConfig } = this.loaded;
    const {
      ImageError,
      ImageOptimizerCache,
      fetchExternalImage,
      imageOptimizer,
      sendResponse,
    } = next.optimizer;

    try {
      const params = ImageOptimizerCache.validateParams(
        req as unknown as Parameters<
          typeof ImageOptimizerCache.validateParams
        >[0],
        Object.fromEntries(url.searchParams),
        nextConfig,
        false,
      );
      if ("errorMessage" in params) {
        return sendText(res, 400, params.errorMessage);
      }

      const { href, isAbsolute } = params;
      const optimize = async (previousCacheEntry?: PreviousImageEntry) => {
        const upstream = isAbsolute
          ? await fetchExternalImage(
              href,
              imagesConfig.dangerouslyAllowLocalIP,
              imagesConfig.maximumResponseBody,
              imagesConfig.maximumRedirects,
            )
          : await this.fetchLocal(req, href, nextConfig, next.optimizer);

        const optimized = await imageOptimizer(
          upstream,
          params,
          {
            experimental: nextConfig.experimental,
            images: {
              dangerouslyAllowSVG: imagesConfig.dangerouslyAllowSVG,
              minimumCacheTTL: imagesConfig.minimumCacheTTL,
            },
          },
          { isDev: false, previousCacheEntry },
        );

        // `imageOptimizer` reports a failed optimization by returning the
        // untouched upstream image alongside `error` rather than throwing, so
        // without this a broken `sharp` install serves full-size originals with
        // a 200 indefinitely and nothing in the logs says why.
        if (optimized.error) {
          console.error(
            `Failed to optimize ${href}, serving the unoptimized original:`,
            optimized.error,
          );
        }
        return optimized;
      };

      // Next's own response writer, rather than a restatement of it, so the
      // headers `next start` sends come with it: the year-long `immutable` for
      // a `/_next/static/media` src, `If-None-Match` as `fresh` reads it (weak
      // and listed tags, `Cache-Control: no-cache`), a `Content-Disposition`
      // that RFC 5987-encodes a filename `writeHead` would reject as
      // non-latin1, `Content-Length`, and no body for HEAD. The restated
      // version had drifted on every one of those.
      const send = (
        extension: string,
        buffer: Buffer,
        etag: string,
        xCache: "MISS" | "HIT" | "STALE",
        maxAge: number,
      ) => {
        res.statusCode = 200;
        sendResponse(
          req as unknown as Parameters<typeof sendResponse>[0],
          asServerResponse(res),
          href,
          extension,
          buffer,
          etag,
          params.isStatic,
          xCache,
          imagesConfig,
          maxAge,
          false,
        );
      };

      // `next start`'s `handleNextImageRequest`, step for step: a
      // `ResponseCache` over an `ImageOptimizerCache` backed by the app's
      // `cacheHandler`, so a hit skips the fetch and `sharp`, a stale entry is
      // served while it is regenerated, and concurrent misses for one image
      // optimize it once. The app's `cacheHandler` is the S3 cache, which the
      // adapter turns on with `images.customCacheHandler`: with no CDN in front
      // (the Regional types) every request would otherwise run `sharp` again,
      // and behind CloudFront each edge miss is an S3 read instead.
      this.imageCache ??= loadImageCache(this.options, this.loaded);
      const cache = await this.imageCache;
      const entry = await cache.responses.get(
        ImageOptimizerCache.getCacheKey(params),
        async ({ previousCacheEntry }) => {
          const { buffer, contentType, maxAge, etag, upstreamEtag } =
            await optimize(previousCacheEntry as PreviousImageEntry);
          return {
            value: {
              kind: IMAGE_KIND,
              buffer,
              etag,
              extension: next.serveStatic.getExtension(contentType) ?? "",
              upstreamEtag,
            },
            cacheControl: { revalidate: maxAge, expire: undefined },
          };
        },
        {
          routeKind: IMAGE_KIND,
          incrementalCache: waitUntil
            ? deferWrites(cache.images, waitUntil)
            : cache.images,
          isFallback: false,
          // A stale entry is served at once and regenerated in the background;
          // without this, a Lambda could freeze with the regeneration half done.
          waitUntil,
        } as unknown as Parameters<ImageCache["responses"]["get"]>[2],
      );
      const value = entry?.value as
        | {
            kind: string;
            extension: string;
            buffer: Buffer;
            etag: string;
          }
        | null
        | undefined;
      if (value?.kind !== IMAGE_KIND) {
        throw new Error("The image cache returned no image entry");
      }
      send(
        value.extension,
        value.buffer,
        value.etag,
        entry!.isMiss ? "MISS" : entry!.isStale ? "STALE" : "HIT",
        entry!.cacheControl?.revalidate || 0,
      );
    } catch (error) {
      const { statusCode, message } = resolveErrorResponse(error, ImageError);
      if (statusCode >= 500) {
        console.error("Image optimization failed:", error);
      }
      sendText(res, statusCode, message);
    }
  }

  private async fetchLocal(
    req: ShimIncomingMessage,
    href: string,
    nextConfig: ReturnType<typeof loadImageRuntime>["nextConfig"],
    optimizer: NextImageModules["optimizer"],
  ) {
    try {
      const result = await fetchFromS3(this.s3, this.options.bucket, href, {
        urlBasePath: nextConfig.basePath,
        keyPrefix: this.options.bucketKeyPrefix,
        assetPrefix: nextConfig.assetPrefix,
      });
      return {
        buffer: result.buffer,
        contentType: result.contentType,
        cacheControl: null,
        etag: result.etag,
      };
    } catch (error) {
      const { fetchInternal } = this.options;
      const missing = error instanceof Error && error.name === "NoSuchKey";
      if (!fetchInternal || !missing) throw error;

      // What `fetchInternalImage` checks, and throws, for the same response.
      const response = await fetchInternal(href, req);
      if (response.otherGroup !== undefined) {
        // A deployment problem, not a bad `url`: see `NextjsRuntime.fetchInternal`,
        // which logs the details.
        throw new optimizer.ImageError(
          502,
          '"url" parameter is valid but its source is a route in another ' +
            "functionGroups group, which the image optimizer cannot fetch",
        );
      }
      if (!response.statusCode || response.body.length === 0) {
        throw new optimizer.ImageError(
          400,
          '"url" parameter is valid but internal response is invalid',
        );
      }
      return {
        buffer: response.body,
        contentType: firstValue(response.headers["content-type"]) ?? null,
        cacheControl: firstValue(response.headers["cache-control"]) ?? null,
        etag: optimizer.extractEtag(
          firstValue(response.headers.etag) ?? null,
          response.body,
        ),
      };
    }
  }
}

/**
 * `CachedRouteKind.IMAGE`, which is also `RouteKind.IMAGE`. Restated: the enum is
 * a runtime value of `next`, which the bundle cannot import.
 */
const IMAGE_KIND = "IMAGE" as CachedRouteKind.IMAGE;

/** `imageOptimizer`'s `previousCacheEntry`. */
type PreviousImageEntry = Parameters<
  NextImageModules["optimizer"]["imageOptimizer"]
>[3]["previousCacheEntry"];

interface ImageCache {
  readonly responses: InstanceType<
    NextImageCacheModules["responseCache"]["default"]
  >;
  readonly images: InstanceType<
    NextImageModules["optimizer"]["ImageOptimizerCache"]
  >;
}

/**
 * The app's `cacheHandler`, constructed the way `next start` constructs it for
 * images (`next-server.js`, `handleNextImageRequest`): once, and kept, so its
 * in-memory layer lasts across requests. Its path in `required-server-files.json`
 * is relative to the dist dir; see {@link cacheHandlerUrl}.
 */
async function loadImageCache(
  { deploymentRoot, manifest, importModule }: ImageOptimizerOptions,
  loaded: ReturnType<typeof loadImageRuntime>,
): Promise<ImageCache> {
  const { next, nextConfig } = loaded;
  const modules: NextImageCacheModules = {
    responseCache: nextModule("next/dist/server/response-cache/index.js"),
  };
  const distDir = join(
    deploymentRoot,
    manifest.relativeProjectDir,
    manifest.config.distDir,
  );
  let cacheHandler: InstanceType<CacheHandlerClass> | undefined;
  if (nextConfig.cacheHandler) {
    const url = cacheHandlerUrl(distDir, nextConfig.cacheHandler);
    const imported = (await (importModule
      ? importModule(url)
      : import(url))) as { default?: CacheHandlerClass } & CacheHandlerClass;
    const CacheHandler = imported.default ?? imported;
    cacheHandler = new CacheHandler({
      dev: false,
      flushToDisk: nextConfig.experimental.isrFlushToDisk,
      serverDistDir: join(distDir, "server"),
      maxMemoryCacheSize: nextConfig.cacheMaxMemorySize,
      revalidatedTags: [],
      _requestHeaders: {},
    });
  }
  return {
    responses: new modules.responseCache.default(false),
    images: new next.optimizer.ImageOptimizerCache({
      distDir,
      nextConfig,
      cacheHandler,
    }),
  };
}

/**
 * `formatDynamicImportPath` from `next/dist/lib/format-dynamic-import-path.js`,
 * restated: `next build` doesn't trace that module into the deployment, so
 * loading it failed every image request with the cache on.
 */
function cacheHandlerUrl(distDir: string, cacheHandler: string): string {
  const path = cacheHandler.startsWith("file://")
    ? fileURLToPath(cacheHandler)
    : cacheHandler;
  return pathToFileURL(
    isAbsolutePath(path) ? path : join(distDir, path),
  ).toString();
}

/**
 * `images`, with its `set` moved off the response's critical path.
 *
 * `ResponseCache` awaits the write of a freshly optimized image before it hands
 * the image back, so every miss paid an S3 `PutObject` (~30 ms measured) before
 * its first byte. The write is registered with `waitUntil` instead, which the
 * runtime drains before a Lambda invocation returns or a container shuts down,
 * so it still lands. A failed write is logged; the next request optimizes the
 * image again, which is what it would have done anyway.
 */
function deferWrites(
  images: ImageCache["images"],
  waitUntil: (promise: Promise<unknown>) => void,
): ImageCache["images"] {
  const deferred = Object.create(images) as ImageCache["images"];
  deferred.set = (...args: Parameters<ImageCache["images"]["set"]>) => {
    waitUntil(
      images.set(...args).catch((error: unknown) => {
        console.error("Failed to cache an optimized image:", error);
      }),
    );
    return Promise.resolve();
  };
  return deferred;
}

function sendText(
  res: ShimServerResponse,
  statusCode: number,
  body: string,
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain");
  res.end(body);
}

/**
 * The image config comes from the app's own `required-server-files.json`, not the
 * adapter manifest: `imageOptimizer` reads whole `experimental` and `images`
 * objects, and mirroring those into the manifest would be a second definition of
 * the same thing that silently goes stale on a `next` minor.
 */
function loadImageRuntime({ deploymentRoot, manifest }: ImageOptimizerOptions) {
  const next: NextImageModules = {
    configShared: nextModule("next/dist/server/config-shared.js"),
    imageConfig: nextModule("next/dist/shared/lib/image-config.js"),
    optimizer: nextModule("next/dist/server/image-optimizer.js"),
    serveStatic: nextModule("next/dist/server/serve-static.js"),
  };
  const path = join(
    deploymentRoot,
    manifest.relativeProjectDir,
    manifest.config.distDir,
    "required-server-files.json",
  );
  const required: RequiredServerFiles = JSON.parse(readFileSync(path, "utf-8"));
  const nextConfig = next.configShared.getNextConfigRuntime(required.config);
  return {
    next,
    nextConfig,
    imagesConfig: {
      ...next.imageConfig.imageConfigDefault,
      ...nextConfig.images,
    },
  };
}

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
import { join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import type { NextConfigComplete } from "next/dist/server/config-shared.js";
import type { ShimIncomingMessage } from "./http/request";
import { asServerResponse, ShimServerResponse } from "./http/response";
import { fetchFromS3, resolveErrorResponse } from "./image-utils";
import { AdapterManifest } from "./manifest";
import { nextModule } from "./next-modules";

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
}

/** The response {@link ImageOptimizerOptions.fetchInternal} got. */
export interface InternalImageResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}

/** What `required-server-files.json` is read for. */
interface RequiredServerFiles {
  config: NextConfigComplete;
}

export class RuntimeImageOptimizer {
  private readonly s3 = new S3Client({});
  private loaded?: ReturnType<typeof loadImageRuntime>;

  public constructor(private readonly options: ImageOptimizerOptions) {}

  public async handle(
    req: ShimIncomingMessage,
    res: ShimServerResponse,
    url: URL,
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
      const upstream = isAbsolute
        ? await fetchExternalImage(
            href,
            imagesConfig.dangerouslyAllowLocalIP,
            imagesConfig.maximumResponseBody,
            imagesConfig.maximumRedirects,
          )
        : await this.fetchLocal(req, href, nextConfig, next.optimizer);

      const {
        buffer,
        contentType,
        maxAge,
        etag,
        error: optimizationError,
      } = await imageOptimizer(
        upstream,
        params,
        {
          experimental: nextConfig.experimental,
          images: {
            dangerouslyAllowSVG: imagesConfig.dangerouslyAllowSVG,
            minimumCacheTTL: imagesConfig.minimumCacheTTL,
          },
        },
        { isDev: false },
      );

      // `imageOptimizer` reports a failed optimization by returning the untouched
      // upstream image alongside `error` rather than throwing, so without this a
      // broken `sharp` install serves full-size originals with a 200 indefinitely
      // and nothing in the logs says why.
      if (optimizationError) {
        console.error(
          `Failed to optimize ${href}, serving the unoptimized original:`,
          optimizationError,
        );
      }

      // Next's own response writer, rather than a restatement of it, so the
      // headers `next start` sends come with it: the year-long `immutable` for
      // a `/_next/static/media` src, `If-None-Match` as `fresh` reads it (weak
      // and listed tags, `Cache-Control: no-cache`), a `Content-Disposition`
      // that RFC 5987-encodes a filename `writeHead` would reject as
      // non-latin1, `Content-Length`, and no body for HEAD. The restated
      // version had drifted on every one of those.
      //
      // `MISS` because there is no image cache here to hit: every request that
      // reaches the origin is optimized afresh, and CloudFront is the cache.
      res.statusCode = 200;
      sendResponse(
        req as unknown as Parameters<typeof sendResponse>[0],
        asServerResponse(res),
        href,
        // `null` for a type `mime` doesn't know, which `sendResponse` handles
        // (no `Content-Type`, `image.bin`); its signature just doesn't say so.
        next.serveStatic.getExtension(contentType) ?? "",
        buffer,
        etag,
        params.isStatic,
        "MISS",
        imagesConfig,
        maxAge,
        false,
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
      if (!response.statusCode || response.body.length === 0) {
        throw new optimizer.ImageError(
          400,
          '"url" parameter is valid but internal response is invalid',
        );
      }
      return {
        buffer: response.body,
        contentType: firstHeader(response.headers["content-type"]) ?? null,
        cacheControl: firstHeader(response.headers["cache-control"]) ?? null,
        etag: optimizer.extractEtag(
          firstHeader(response.headers.etag) ?? null,
          response.body,
        ),
      };
    }
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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

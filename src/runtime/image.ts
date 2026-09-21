/* eslint-disable import/no-extraneous-dependencies */
/**
 * `/_next/image`, folded into the runtime core.
 *
 * Same logic as the standalone `src/image-optimization/handler.mts` Lambda, with
 * the response written to a {@link ShimServerResponse} instead of straight to a
 * Lambda response stream, so it composes with routing: dispatch only classifies a
 * request as image optimization *after* middleware has had it, which is what makes
 * `NextResponse.rewrite()` onto an image work.
 *
 * The validation, fetching, and error mapping are shared with that Lambda via
 * `../image-optimization/handler-utils`, so the two cannot drift while both exist.
 * The standalone Lambda is deleted in a later step of this release.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import type { NextConfigComplete } from "next/dist/server/config-shared.js";
import type { ShimIncomingMessage } from "./http/request";
import { ShimServerResponse } from "./http/response";
import { AdapterManifest } from "./manifest";
import { nextModule } from "./next-modules";
import {
  fetchFromS3,
  getFileNameWithExtension,
  resolveErrorResponse,
} from "../image-optimization/handler-utils";

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
        : await fetchFromS3(
            this.s3,
            this.options.bucket,
            href,
            nextConfig.basePath,
          ).then((result) => ({
            buffer: result.buffer,
            contentType: result.contentType,
            cacheControl: null,
            etag: result.etag,
          }));

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

      res.setHeader(
        "Cache-Control",
        `public, max-age=${maxAge}, must-revalidate`,
      );
      res.setHeader("ETag", etag);

      if (req.headers["if-none-match"] === etag) {
        res.statusCode = 304;
        res.end();
        return;
      }

      const fileName = getFileNameWithExtension(
        href,
        contentType,
        next.serveStatic.getExtension,
      );
      res.statusCode = 200;
      res.setHeader("Content-Type", contentType);
      res.setHeader("Vary", "Accept");
      res.setHeader(
        "Content-Disposition",
        `${imagesConfig.contentDispositionType}; ` +
          `filename="${fileName.replace(/"/g, "")}"`,
      );
      if (imagesConfig.contentSecurityPolicy) {
        res.setHeader(
          "Content-Security-Policy",
          imagesConfig.contentSecurityPolicy,
        );
      }
      res.end(buffer);
    } catch (error) {
      const { statusCode, message } = resolveErrorResponse(error, ImageError);
      if (statusCode >= 500) {
        console.error("Image optimization failed:", error);
      }
      sendText(res, statusCode, message);
    }
  }
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

/* eslint-disable import/no-extraneous-dependencies */
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { APIGatewayProxyEvent, LambdaFunctionURLEvent } from "aws-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import {
  ImageError,
  ImageOptimizerCache,
  imageOptimizer,
  fetchExternalImage,
} from "next/dist/server/image-optimizer.js";
import { getExtension } from "next/dist/server/serve-static.js";
import { imageConfigDefault } from "next/dist/shared/lib/image-config.js";
import {
  getNextConfigRuntime,
  type NextConfigComplete,
} from "next/dist/server/config-shared.js";
import getDebug from "debug";
import {
  fetchFromS3,
  getFileNameWithExtension,
  resolveErrorResponse,
} from "./handler-utils";

const debug = getDebug("cdk-nextjs:image-optimization");

const s3 = new S3Client({});

const STATIC_ASSETS_BUCKET =
  process.env.CDK_NEXTJS_STATIC_ASSETS_BUCKET_NAME || "";

interface RequiredServerFiles {
  config: NextConfigComplete;
}

const requiredServerFiles: RequiredServerFiles = JSON.parse(
  readFileSync("required-server-files.json", "utf-8"),
);
const nextConfig = getNextConfigRuntime(requiredServerFiles.config);
const imagesConfig = { ...imageConfigDefault, ...nextConfig.images };

/**
 * Next's `ImageOptimizerCache.validateParams` and this handler only ever read
 * `req.headers`, so a real `IncomingMessage`/`Socket` isn't needed. This shape
 * is common to both `LambdaFunctionURLEvent` (Global Functions) and
 * `APIGatewayProxyEvent` (Regional Functions, via streaming proxy integration).
 */
/**
 * Regional Functions reaches this handler through an API Gateway streaming
 * proxy integration, Global Functions through a Lambda Function URL. Only the
 * REST API event carries `httpMethod`.
 */
function isApiGatewayEvent(
  event: LambdaFunctionURLEvent | APIGatewayProxyEvent,
): event is APIGatewayProxyEvent {
  return "httpMethod" in event;
}

function getHeaders(
  event: LambdaFunctionURLEvent | APIGatewayProxyEvent,
): Pick<IncomingMessage, "headers"> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.headers)) {
    if (value !== undefined) {
      headers[key.toLowerCase()] = value;
    }
  }
  return { headers } as Pick<IncomingMessage, "headers">;
}

export const handler = awslambda.streamifyResponse(
  async (
    event: LambdaFunctionURLEvent | APIGatewayProxyEvent,
    responseStream: awslambda.HttpResponseStream,
  ): Promise<void> => {
    debug("Received event:", JSON.stringify(event, null, 2));

    try {
      const req = getHeaders(event);
      const query = event.queryStringParameters || {};

      const paramsResult = ImageOptimizerCache.validateParams(
        req as IncomingMessage,
        query,
        nextConfig,
        false,
      );

      if ("errorMessage" in paramsResult) {
        const stream = awslambda.HttpResponseStream.from(responseStream, {
          statusCode: 400,
          headers: { "Content-Type": "text/plain" },
        });
        stream.write(paramsResult.errorMessage);
        stream.end();
        return;
      }

      const { href, isAbsolute } = paramsResult;

      debug(
        `Image params: href=${href} width=${paramsResult.width} quality=${paramsResult.quality} mimeType=${paramsResult.mimeType}`,
      );

      const imageUpstream = isAbsolute
        ? await fetchExternalImage(
            href,
            imagesConfig.dangerouslyAllowLocalIP,
            imagesConfig.maximumResponseBody,
            imagesConfig.maximumRedirects,
          )
        : await fetchFromS3(
            s3,
            STATIC_ASSETS_BUCKET,
            href,
            nextConfig.basePath,
          ).then((result) => ({
            buffer: result.buffer,
            contentType: result.contentType,
            cacheControl: null,
            etag: result.etag,
          }));

      const {
        buffer: optimizedBuffer,
        contentType: optimizedContentType,
        maxAge,
        etag,
        error: optimizationError,
      } = await imageOptimizer(
        imageUpstream,
        paramsResult,
        {
          experimental: nextConfig.experimental,
          images: {
            dangerouslyAllowSVG: imagesConfig.dangerouslyAllowSVG,
            minimumCacheTTL: imagesConfig.minimumCacheTTL,
          },
        },
        { isDev: false },
      );

      // `imageOptimizer` reports a failed optimization by returning the
      // untouched upstream image alongside `error` rather than throwing, so
      // without this a broken `sharp` install serves full-size originals with
      // a 200 indefinitely and nothing in the logs says why.
      if (optimizationError) {
        console.error(
          `Failed to optimize ${href}, serving the unoptimized original:`,
          optimizationError,
        );
      }

      const ifNoneMatch = req.headers["if-none-match"];
      if (ifNoneMatch === etag) {
        const stream = awslambda.HttpResponseStream.from(responseStream, {
          statusCode: 304,
          headers: {
            "Cache-Control": `public, max-age=${maxAge}, must-revalidate`,
            ETag: etag,
          },
        });
        // A stream with zero payload bytes after the metadata delimiter makes
        // API Gateway's InvokeWithResponseStream integration return a 502: it
        // never recognizes the response as complete. A single space keeps the
        // stream non-empty. RFC 9110 forbids a body on a 304 though, so this
        // is confined to the integration that needs it rather than also being
        // sent to CloudFront and on to caches and HTTP/2 clients.
        if (isApiGatewayEvent(event)) {
          stream.write(" ");
        }
        stream.end();
        return;
      }

      const fileName = getFileNameWithExtension(
        href,
        optimizedContentType,
        getExtension,
      );
      const stream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 200,
        headers: {
          "Content-Type": optimizedContentType,
          "Cache-Control": `public, max-age=${maxAge}, must-revalidate`,
          ETag: etag,
          Vary: "Accept",
          "Content-Disposition": `${imagesConfig.contentDispositionType}; filename="${fileName.replace(/"/g, "")}"`,
          "Content-Security-Policy": imagesConfig.contentSecurityPolicy,
        },
      });
      stream.write(optimizedBuffer);
      stream.end();
    } catch (error) {
      debug("Error processing image:", error);
      const { statusCode, message } = resolveErrorResponse(error, ImageError);
      const stream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode,
        headers: { "Content-Type": "text/plain" },
      });
      stream.write(message);
      stream.end();
    }
  },
);

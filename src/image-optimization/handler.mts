/* eslint-disable import/no-extraneous-dependencies */
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { APIGatewayProxyEvent, LambdaFunctionURLEvent } from "aws-lambda";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
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

/** Mirrors Next.js's own `getFileNameWithExtension` in image-optimizer.js. */
function getFileNameWithExtension(
  url: string,
  contentType: string | null,
): string {
  const [urlWithoutQueryParams] = url.split("?", 1);
  const fileNameWithExtension = urlWithoutQueryParams.split("/").pop();
  if (!contentType || !fileNameWithExtension) {
    return "image.bin";
  }
  const [fileName] = fileNameWithExtension.split(".", 1);
  const extension = getExtension(contentType);
  return `${fileName}.${extension}`;
}

async function fetchFromS3(
  url: string,
): Promise<{ buffer: Buffer; contentType: string | null; etag: string }> {
  // `url` already includes `basePath` (baked in by next-image-loader for
  // static imports, or added manually per Next.js convention for string
  // paths), and static assets are uploaded to S3 under that same basePath
  // prefix, so the key matches the url as-is.
  const key = url.replace(/^\//, "");

  debug(`Fetching from S3: bucket=${STATIC_ASSETS_BUCKET} key=${key}`);

  const response = await s3.send(
    new GetObjectCommand({
      Bucket: STATIC_ASSETS_BUCKET,
      Key: key,
    }),
  );

  const body = response.Body;
  if (!body) {
    throw new Error(`Empty response from S3 for key: ${key}`);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }

  return {
    buffer: Buffer.concat(chunks),
    contentType: response.ContentType || null,
    etag: response.ETag || "",
  };
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
        : await fetchFromS3(href).then((result) => ({
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

      const ifNoneMatch = req.headers["if-none-match"];
      if (ifNoneMatch === etag) {
        const stream = awslambda.HttpResponseStream.from(responseStream, {
          statusCode: 304,
          headers: {
            "Cache-Control": `public, max-age=${maxAge}, must-revalidate`,
            ETag: etag,
          },
        });
        stream.end();
        return;
      }

      const fileName = getFileNameWithExtension(href, optimizedContentType);
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
      let statusCode = 500;
      let message = "Internal Server Error";
      if (error instanceof ImageError) {
        statusCode = error.statusCode;
        message = error.message;
      } else if (error instanceof Error && error.name === "NoSuchKey") {
        statusCode = 404;
        message = "Not Found";
      }
      const stream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode,
        headers: { "Content-Type": "text/plain" },
      });
      stream.write(message);
      stream.end();
    }
  },
);

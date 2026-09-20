/* eslint-disable import/no-extraneous-dependencies */
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ImageError } from "next/dist/server/image-optimizer.js";
import { getExtension } from "next/dist/server/serve-static.js";

/**
 * Fetches a non-absolute (local) image referenced by an `<Image>` from S3.
 *
 * `NextjsStaticAssets` uploads under `basePath` as a key prefix, so every key
 * includes it. `url` is inconsistent: next-image-loader bakes `basePath` into
 * the href for statically imported images, while plain string paths are passed
 * through as literally written by the app. So the prefix is normalized to
 * exactly one occurrence rather than simply added or removed.
 */
export async function fetchFromS3(
  s3: S3Client,
  bucket: string,
  url: string,
  basePath: string,
): Promise<{ buffer: Buffer; contentType: string | null; etag: string }> {
  // Matching on a path boundary keeps a sibling like "/basement/logo.png"
  // from being treated as basePath "/base" plus "ment/logo.png".
  const hasBasePath =
    !!basePath && (url === basePath || url.startsWith(`${basePath}/`));
  const withoutBasePath = hasBasePath ? url.slice(basePath.length) : url;
  const key = `${basePath}${withoutBasePath}`.replace(/^\//, "");

  const response = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
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

/** Mirrors Next.js's own `getFileNameWithExtension` in image-optimizer.js. */
export function getFileNameWithExtension(
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

/**
 * Maps an error thrown while processing an image request to the HTTP
 * status/message it should produce, preserving the status Next.js's own
 * `ImageError`/`fetchExternalImage` attach. A missing S3 object is mapped to
 * the same 400 Next.js's own local-image fetch path (`fetchInternalImage` in
 * image-optimizer.js) produces for a missing file: it never inspects the
 * internal request's status code, so a 404 there just flows into the normal
 * "not a valid image" content-type check as if it were malformed image
 * bytes. This mirrors that behavior instead of surfacing a 404, so Functions
 * and Containers deployments respond identically for this case.
 */
export function resolveErrorResponse(error: unknown): {
  statusCode: number;
  message: string;
} {
  if (error instanceof ImageError) {
    return { statusCode: error.statusCode, message: error.message };
  }
  if (error instanceof Error && error.name === "NoSuchKey") {
    return {
      statusCode: 400,
      message: "The requested resource isn't a valid image.",
    };
  }
  return { statusCode: 500, message: "Internal Server Error" };
}

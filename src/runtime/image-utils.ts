/* eslint-disable import/no-extraneous-dependencies */
/**
 * S3 fetching and error mapping for `/_next/image`, split out from
 * {@link ./image.ts} so it is unit-testable without `next` present.
 *
 * The two values from `next` that this file needs are passed in rather than
 * imported: `next` is external to the shell bundles, so a static `import` here
 * would be hoisted into the bundle where it cannot resolve. `image.ts` requires
 * them through `./next-modules` instead.
 */
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** Where the app is served versus where its assets were uploaded. */
export interface S3AssetLocation {
  /**
   * The app's own `basePath` — the prefix of the *URL* it is served at. Only
   * stripped from the href, never used to build a key: on the API Gateway
   * deployment types this is the stage name, which never appears in S3.
   */
  readonly urlBasePath: string;
  /**
   * `NextjsStaticAssets.keyPrefix`: the S3 key prefix the assets were uploaded
   * under, without a leading slash. Empty for a bucket-root deployment.
   */
  readonly keyPrefix: string;
}

/**
 * Fetches a non-absolute (local) image referenced by an `<Image>` from S3.
 *
 * `url` is inconsistent about the app's `basePath`: next-image-loader bakes it
 * into the href for statically imported images, while plain string paths are
 * passed through as literally written by the app. So it is stripped when present,
 * leaving a path relative to the asset root, and the bucket's own key prefix is
 * applied to that. Deriving the key from `basePath` instead is wrong whenever the
 * two differ, which they do for every API Gateway deployment.
 */
export async function fetchFromS3(
  s3: S3Client,
  bucket: string,
  url: string,
  location: S3AssetLocation,
): Promise<{ buffer: Buffer; contentType: string | null; etag: string }> {
  const { urlBasePath, keyPrefix } = location;
  // Matching on a path boundary keeps a sibling like "/basement/logo.png"
  // from being treated as basePath "/base" plus "ment/logo.png".
  const hasBasePath =
    !!urlBasePath && (url === urlBasePath || url.startsWith(`${urlBasePath}/`));
  const assetPath = (hasBasePath ? url.slice(urlBasePath.length) : url).replace(
    /^\/+/,
    "",
  );
  const prefix = keyPrefix.replace(/^\/+|\/+$/g, "");
  const key = prefix ? `${prefix}/${assetPath}` : assetPath;

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

/** `getExtension` from `next/dist/server/serve-static.js`. */
export type GetExtension =
  (typeof import("next/dist/server/serve-static.js"))["getExtension"];

/** `ImageError` from `next/dist/server/image-optimizer.js`. */
export type ImageErrorClass =
  (typeof import("next/dist/server/image-optimizer.js"))["ImageError"];

/** Mirrors Next.js's own `getFileNameWithExtension` in image-optimizer.js. */
export function getFileNameWithExtension(
  url: string,
  contentType: string | null,
  getExtension: GetExtension,
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
export function resolveErrorResponse(
  error: unknown,
  ImageError: ImageErrorClass,
): {
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

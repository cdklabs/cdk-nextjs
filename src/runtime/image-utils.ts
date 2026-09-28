/* eslint-disable import/no-extraneous-dependencies */
/**
 * S3 fetching and error mapping for `/_next/image`, split out from
 * {@link ./image.ts} so it is unit-testable without `next` present.
 *
 * The one value from `next` that this file needs is passed in rather than
 * imported: `next` is external to the shell bundles, so a static `import` here
 * would be hoisted into the bundle where it cannot resolve. `image.ts` requires
 * it through `./next-modules` instead.
 */
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { withoutPathPrefix } from "./util";

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
  /**
   * The app's `assetPrefix`, when it is a path (`/cdn`). Next.js puts it in
   * front of `/_next/` in place of `basePath`, so a statically imported image's
   * href is `/cdn/_next/static/media/…`, and `next start` strips it again when
   * it serves the file. An absolute `assetPrefix` makes the href absolute, which
   * never reaches here.
   * @default - none
   */
  readonly assetPrefix?: string;
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
 *
 * The key is percent-decoded, because an S3 key is the file's real name while
 * `url` is a URL path. `public/hello world.jpg` arrives here as
 * `/hello%20world.jpg` — the `url` query value is double-encoded, so decoding the
 * query string leaves one layer — and its object key is `hello world.jpg`.
 * Next.js's own `fetchInternalImage` gets the decode for free, since it makes an
 * HTTP subrequest and its static file server resolves the path against the
 * filesystem; skipping it here 400'd that file
 * (`next-image-legacy/unicode`). Unicode needs nothing: `äöüščří.png` survives
 * the query decode as itself and is already the object's name.
 *
 * Throws {@link ImageTooLargeError} rather than read past `maximumBody`
 * (`images.maximumResponseBody`), which `next start` enforces on local sources
 * too: a large `public/` file would otherwise be read into memory whole.
 */
export async function fetchFromS3(
  s3: S3Client,
  bucket: string,
  url: string,
  location: S3AssetLocation,
  maximumBody: number,
): Promise<{ buffer: Buffer; contentType: string | null; etag: string }> {
  const { urlBasePath, keyPrefix } = location;
  // The key is the path alone. `/logo.png?v=2` is a cache-buster on a file
  // named `logo.png`, and `next start` treats it as one: `fetchInternalImage`
  // routes the href as a request, whose query and fragment never reach the
  // static file lookup. Left on, they became part of the key, which missed.
  // Cut before decoding, so a `?` that is part of the name (`%3F`) survives.
  const path = withoutAssetPrefix(url.split(/[?#]/, 1)[0], location);
  // Matching on a path boundary keeps a sibling like "/basement/logo.png" from
  // being treated as basePath "/base" plus "ment/logo.png". It's still
  // indistinguishable from a real `public/base/` directory, which loses; that's
  // the right trade, since every statically imported image carries the prefix
  // and the alternative costs an S3 round trip per request to detect it.
  const assetPath = withoutPathPrefix(path, urlBasePath).replace(/^\/+/, "");
  const prefix = keyPrefix.replace(/^\/+|\/+$/g, "");
  const decoded = decodePath(assetPath);
  const key = prefix ? `${prefix}/${decoded}` : decoded;

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

  if ((response.ContentLength ?? 0) > maximumBody) {
    (body as { destroy?: () => void }).destroy?.();
    throw new ImageTooLargeError(key);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  // Counted as well, for an object without a `ContentLength`. Throwing out of
  // the loop destroys the stream.
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > maximumBody) {
      throw new ImageTooLargeError(key);
    }
    chunks.push(Buffer.from(chunk));
  }

  return {
    buffer: Buffer.concat(chunks),
    contentType: response.ContentType || null,
    etag: response.ETag || "",
  };
}

/**
 * `/cdn/_next/static/media/logo.png` → `/_next/static/media/logo.png`, for a
 * path `assetPrefix` of `/cdn`: only in front of `/_next/`, the one place
 * Next.js puts it.
 */
function withoutAssetPrefix(path: string, location: S3AssetLocation): string {
  const assetPrefix = location.assetPrefix?.replace(/\/+$/, "") ?? "";
  if (!assetPrefix.startsWith("/")) return path;
  return path.startsWith(`${assetPrefix}/_next/`)
    ? path.slice(assetPrefix.length)
    : path;
}

/**
 * Percent-decodes a URL path into the name the file actually has on disk, or in
 * S3. Falls back to the path as given when it isn't valid percent-encoding, which
 * is what a literal `%` in a filename looks like: `public/100%.png` is requested
 * as `/100%.png` (a `%` in a path is legal and browsers don't escape it), and
 * `decodeURIComponent` throws `URIError` on it. The undecoded name is the right
 * answer there, and a genuinely malformed request just misses the key and gets
 * the same 400 an absent file gets.
 */
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** A source over `images.maximumResponseBody`; see {@link fetchFromS3}. */
export class ImageTooLargeError extends Error {
  public constructor(key: string) {
    super(`S3 object ${key} is over images.maximumResponseBody`);
    this.name = "ImageTooLargeError";
  }
}

/** `ImageError` from `next/dist/server/image-optimizer.js`. */
export type ImageErrorClass =
  (typeof import("next/dist/server/image-optimizer.js"))["ImageError"];

/**
 * Maps an error thrown while processing an image request to the HTTP
 * status/message it should produce, preserving the status Next.js's own
 * `ImageError`/`fetchExternalImage` attach. A missing S3 object is mapped to
 * the same 400 Next.js's own local-image fetch path (`fetchInternalImage` in
 * image-optimizer.js) produces for a missing file: it never inspects the
 * internal request's status code, so a 404 there just flows into the normal
 * "not a valid image" content-type check as if it were malformed image
 * bytes. This mirrors that behavior instead of surfacing a 404, so Functions
 * and Containers deployments respond identically for this case. A source over
 * `images.maximumResponseBody` is the 413 `fetchInternalImage` answers.
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
  if (error instanceof ImageTooLargeError) {
    return {
      statusCode: 413,
      message: '"url" parameter is valid but internal response is invalid',
    };
  }
  if (error instanceof Error && error.name === "NoSuchKey") {
    return {
      statusCode: 400,
      message: "The requested resource isn't a valid image.",
    };
  }
  return { statusCode: 500, message: "Internal Server Error" };
}

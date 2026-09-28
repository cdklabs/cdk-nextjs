/**
 * Serving the static files that nothing in front of the compute answers.
 *
 * `NextjsStaticAssets` uploads `<distDir>/static` and `public` to S3, and
 * CloudFront / API Gateway route a file's own URL there — except on
 * `NextjsRegionalContainers`, which has nothing in front of it. What still
 * reaches the runtime is a file some *other* URL lands on: a `rewrites` entry
 * or a middleware rewrite onto `/maintenance.html`, `/en-US/robots.txt` in an
 * i18n app. The `NextjsRegionalContainers` image copies `public` and
 * `<distDir>/static` in and serves them off disk; the other types carry
 * neither, so a `public/` file is streamed from the assets bucket instead
 * ({@link serveS3PublicFile}).
 * Everything else in `manifest.staticFiles` lives under `<distDir>/server` —
 * `404.html`, `500.html`, `favicon.ico.body`, fully-static Pages Router HTML —
 * and reaches us, exactly as it reaches `next start`.
 *
 * Next.js's own `serveStatic` is used rather than a `createReadStream`, because it
 * is `send` underneath and that brings conditional requests (`If-None-Match`,
 * `If-Modified-Since`), `Range`, `ETag`, `Last-Modified`, and content-type
 * detection. Reimplementing those is how a "simple" file server ends up
 * disagreeing with `next start` on a 304.
 */
/* eslint-disable import/no-extraneous-dependencies */
import { extname } from "node:path";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  GetObjectCommandOutput,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import type { ShimIncomingMessage } from "./http/request";
import { asServerResponse, ShimServerResponse } from "./http/response";
import { nextModule } from "./next-modules";
import { drained, firstValue, s3Client } from "./util";

const SERVE_STATIC = "next/dist/server/serve-static.js";
type ServeStaticModule = typeof import("next/dist/server/serve-static.js");

/** Resolved on the first static-file request; see {@link nextModule}. */
let serveStaticModule: ServeStaticModule | undefined;

/**
 * Returns `false` when the file is not in the deployment package, which is the
 * caller's cue to fall through to a 404.
 *
 * That happens by design on every type but `NextjsRegionalContainers`, for `<distDir>/static` and
 * `public/` alike: neither is staged, being a second copy of bytes already in
 * S3. A `public/` file is then served by {@link serveS3PublicFile}; a
 * `<distDir>/static` one only gets here through a rewrite onto it, and is a 404.
 * The `NextjsRegionalContainers` image copies both in, so there they are found.
 */
export async function serveStaticFile(
  req: ShimIncomingMessage,
  res: ShimServerResponse,
  deploymentRoot: string,
  filePath: string,
  options: { readonly etag: boolean },
): Promise<boolean> {
  serveStaticModule ??= nextModule<ServeStaticModule>(SERVE_STATIC);
  const { serveStatic, getContentType } = serveStaticModule;
  setBodyFileContentType(res, filePath, getContentType);
  try {
    // Encoded, and relative to a `root`, which is how `next start` calls it:
    // `send` percent-decodes whatever path it is handed, as though it were a
    // URL. A raw filesystem path broke on any file name with a `%` in it —
    // `100%.png` failed to decode and answered an empty 400, and `a%20b.txt`
    // was looked up as `a b.txt`, serving a different file if there was one.
    await serveStatic(
      req as unknown as Parameters<typeof serveStatic>[0],
      asServerResponse(res),
      `/${filePath.split("/").map(encodeURIComponent).join("/")}`,
      { root: deploymentRoot, etag: options.etag },
    );
    return true;
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }
    const status = httpErrorStatus(error);
    // `send` emits its error before the first byte, so the head is still ours to
    // set; the guard is only for a shell that already committed one.
    if (status !== undefined && !res.headersSent) {
      res.statusCode = status;
      res.end();
      return true;
    }
    throw error;
  }
}

/**
 * The status a `send` error carries, for the errors that are the *client's*, not
 * ours.
 *
 * `serveStatic` is `send` underneath, and `send` rejects a failed precondition
 * with a 412 and an unsatisfiable `Range` with a 416 — both attached to the error
 * as `statusCode`. `next start` maps them back onto the response
 * (`next/dist/server/lib/router-server.js` special-cases 400/412/416); letting
 * them fall through to the caller's error path (`NextjsRuntime.sendError`, which
 * answers 500 with the app's error page) instead turned `If-Match: "stale"` into
 * a 500 and `Range: bytes=99999-` into a 500.
 *
 * Only 4xx is honored: a 5xx from `send` is a real failure and belongs in the
 * error path, with the stack.
 */
function httpErrorStatus(error: unknown): number | undefined {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return status;
  }
  return undefined;
}

/**
 * `send` types a response from the file's own extension, and a static metadata
 * route ships as `<route>.body` — `robots.txt.body`, `manifest.webmanifest.body`,
 * `favicon.ico.body`. `.body` is not a media type, so every one of them would go
 * out as `application/octet-stream`.
 *
 * Next.js's adapter API is where the type is lost: `build-complete.ts` pushes
 * these through `isStaticMetadataFile()` as a bare `STATIC_FILE` — `id`,
 * `pathname`, `filePath`, and nothing else — while the headers the route handler
 * actually set sit unreferenced in a sibling `<route>.meta`. `next start` reads
 * that file through the response cache and answers `text/plain`.
 *
 * Stripping `.body` puts the route's own extension back on the end, which for
 * this population is the same answer: the set is closed (`favicon.ico`, `icon.*`,
 * `apple-icon.*`, `opengraph-image.*`, `twitter-image.*`, `sitemap.xml`,
 * `robots.txt`, `manifest.{json,webmanifest}`) and every member's type is implied
 * by its extension. `send` skips its own detection when `Content-Type` is already
 * set (`send/index.js`, `type()`), so this wins without reaching for `opts`.
 */
function setBodyFileContentType(
  res: ShimServerResponse,
  filePath: string,
  getContentType: ServeStaticModule["getContentType"],
): void {
  if (!filePath.endsWith(".body") || res.getHeader("Content-Type")) {
    return;
  }
  const ext = extname(filePath.slice(0, -".body".length)).slice(1);
  if (!ext) {
    return;
  }
  const contentType = getContentType(ext);
  if (contentType) {
    res.setHeader("Content-Type", contentType);
  }
}

function isMissingFile(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  // ENOENT covers a missing file and `send`'s "No directory access"; ENOTDIR is
  // what a path segment that exists as a file produces.
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Where a type without `public/` on disk finds a file it does not carry. */
export interface S3PublicFile {
  /** `CDK_NEXTJS_STATIC_ASSETS_BUCKET_NAME`. */
  readonly bucket: string;
  /**
   * `NextjsStaticAssets.keyPrefix`, without a leading slash; empty for a
   * bucket-root deployment. `public/` is uploaded to the root of it.
   */
  readonly keyPrefix: string;
  /** The file's path relative to `public/`, unencoded: its real name. */
  readonly file: string;
  readonly etag: boolean;
}

/**
 * A `public/` file from the assets bucket, for the types whose deployment
 * roots list `public/` without carrying it. Returns `false` when the object is not there,
 * which is the caller's cue to fall through to a 404 as for a file missing from
 * disk.
 *
 * What `send` would have answered, as far as S3 can say it: the object's
 * `Content-Type`, `Content-Length`, `Last-Modified` and — unless
 * `generateEtags` is off — `ETag`; a 304 for a matching `If-None-Match` or, as
 * `fresh` has it, an `If-Modified-Since` without one; and a 206 or 416 for a
 * `Range`. S3 evaluates all of them itself.
 *
 * `Cache-Control` is, in order: a `headers()` rule's, the object's own
 * `CacheControl` metadata — what the edge serves the file's own URL with, so a
 * rewrite onto it caches the same way — and `send`'s default,
 * `public, max-age=0`.
 *
 * `If-Range` is not evaluated, because S3 has no counterpart: with one present
 * the `Range` is dropped and the whole file sent with a 200, which RFC 9110
 * allows (a server may ignore `Range`) and a range client accepts.
 */
export async function serveS3PublicFile(
  req: ShimIncomingMessage,
  res: ShimServerResponse,
  file: S3PublicFile,
): Promise<boolean> {
  const prefix = file.keyPrefix.replace(/^\/+|\/+$/g, "");
  const key = prefix ? `${prefix}/${file.file}` : file.file;
  const ifNoneMatch = file.etag
    ? firstValue(req.headers["if-none-match"])
    : undefined;
  // `fresh` ignores it next to an `If-None-Match`, even one it cannot match
  // because `generateEtags` is off.
  const ifModifiedSince = req.headers["if-none-match"]
    ? undefined
    : httpDate(firstValue(req.headers["if-modified-since"]));
  const range = req.headers["if-range"]
    ? undefined
    : firstValue(req.headers.range);
  let object: Omit<GetObjectCommandOutput, "Body"> & { Body?: unknown };
  try {
    object = await s3Client().send(
      req.method === "HEAD"
        ? new HeadObjectCommand({
            Bucket: file.bucket,
            Key: key,
            IfNoneMatch: ifNoneMatch,
            IfModifiedSince: ifModifiedSince,
            Range: range,
          })
        : new GetObjectCommand({
            Bucket: file.bucket,
            Key: key,
            IfNoneMatch: ifNoneMatch,
            IfModifiedSince: ifModifiedSince,
            Range: range,
          }),
    );
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    if (status === 304) {
      if (!res.getHeader("Cache-Control")) {
        res.setHeader("Cache-Control", "public, max-age=0");
      }
      // The object's own, not the client's `If-None-Match`, which can be a
      // list or `*`.
      const etag = (
        error as { $response?: { headers?: Record<string, string> } }
      ).$response?.headers?.etag;
      if (etag) res.setHeader("ETag", etag);
      res.statusCode = 304;
      res.end();
      return true;
    }
    if (status === 416) {
      // S3's `InvalidRange`. `send` adds `Content-Range: bytes */<size>`, which
      // S3's error does not carry; the status is what a client acts on.
      res.statusCode = 416;
      res.setHeader("Accept-Ranges", "bytes");
      res.end();
      return true;
    }
    const name = (error as { name?: string } | null)?.name;
    if (status === 404 || name === "NoSuchKey" || name === "NotFound") {
      return false;
    }
    throw error;
  }

  if (!res.getHeader("Content-Type") && object.ContentType) {
    res.setHeader("Content-Type", object.ContentType);
  }
  if (!res.getHeader("Cache-Control")) {
    res.setHeader("Cache-Control", object.CacheControl || "public, max-age=0");
  }
  if (object.AcceptRanges) res.setHeader("Accept-Ranges", object.AcceptRanges);
  if (object.ContentRange) {
    res.statusCode = 206;
    res.setHeader("Content-Range", object.ContentRange);
  }
  if (file.etag && object.ETag) res.setHeader("ETag", object.ETag);
  if (object.LastModified) {
    res.setHeader("Last-Modified", object.LastModified.toUTCString());
  }
  if (object.ContentLength !== undefined) {
    res.setHeader("Content-Length", String(object.ContentLength));
  }
  const body = object.Body;
  if (req.method === "HEAD" || !body) {
    res.end();
    return true;
  }
  const stream =
    body instanceof Readable
      ? body
      : Readable.from(body as AsyncIterable<Uint8Array>);
  try {
    for await (const chunk of stream) {
      if (!res.write(chunk) && !(await drained(res))) {
        // The client went away; the rest of the object is not wanted.
        return true;
      }
    }
    res.end();
  } finally {
    // A no-op once fully read; otherwise it releases the S3 connection.
    stream.destroy();
  }
  return true;
}

/** An HTTP date, or `undefined` for one that does not parse, as `fresh` treats it. */
function httpDate(value: string | undefined): Date | undefined {
  const date = value ? new Date(value) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

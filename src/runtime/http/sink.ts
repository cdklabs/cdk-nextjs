/**
 * Connecting a {@link ShimServerResponse} to the bytes-out side of a shell, and
 * the one thing that has to happen on the way: gzip.
 *
 * This lives in shared runtime code rather than in the Lambda shell on purpose.
 * Neither managed layer can compress a *streamed* response:
 *
 * - API Gateway's `minCompressionSize` is set (`src/nextjs-api.ts`) but inert,
 *   because cdk-nextjs also sets `ResponseTransferMode.STREAM`, and STREAM drops
 *   content encoding outright — "If you want to compress your integration
 *   response, do this in your integration".
 * - CloudFront requires the origin to send `Content-Length`, which a streamed
 *   response by definition does not. It still compresses non-streamed responses
 *   and S3 assets, so the gap is exactly streamed HTML and RSC payloads — the
 *   largest text responses we serve.
 *
 * Until the container path was dropped, Lambda Web Adapter did this for us, which
 * is why nothing in the old code mentions it. **Don't "fix" the API Gateway or
 * CloudFront settings expecting them to take over.**
 *
 * gzip rather than brotli: brotli's streaming throughput at default quality is
 * poor, and CloudFront prefers `br` only when the origin didn't already encode —
 * which stops applying the moment we set `content-encoding` ourselves.
 */
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants, createGzip } from "node:zlib";
import type { ShimIncomingMessage } from "./request";
import { ResponseHead, ShimServerResponse } from "./response";

export interface ResponseSink {
  /**
   * Set by the Lambda sink, for both integrations: a streamed Lambda response
   * with zero payload bytes after the metadata delimiter is not recognized as a
   * metadata response at all, so a single space is written instead of nothing.
   *
   * API Gateway answers 502. A Function URL is worse because it looks like it
   * worked: the prelude is discarded and the response arrives as a bare
   * `200 application/octet-stream` with an empty body, none of the app's headers,
   * and an HTTP/2 stream that does not close cleanly — whatever the real status
   * was. Measured against a `NextjsGlobalFunctions` deployment: `HEAD` on a 404
   * page answered `200`, and a server action whose reply is empty (an action that
   * only `redirect()`s, which Next.js answers with `x-action-redirect` and no
   * body) lost the redirect header and so never navigated.
   *
   * The pre-adapter image handler carried the same workaround for 304s. RFC 9110
   * forbids a body on 204/304, and a space technically violates that, but losing
   * the status entirely is the worse failure — and on the CloudFront path a
   * conditional request cannot reach the origin anyway, because `if-none-match`
   * is not in the dynamic cache policy's header allowlist. The container sink
   * writes to a real `ServerResponse` and does not set this.
   */
  readonly padEmptyBody?: boolean;
  /**
   * Called exactly once, before any body byte, with the final head. Returns the
   * stream the body is written to; {@link pipeToSink} ends it.
   */
  begin(head: ResponseHead): Writable;
}

/**
 * Content types worth compressing. Everything Next streams as HTML or an RSC
 * payload is `text/*`; images and fonts are already compressed, and gzipping an
 * optimized AVIF just burns CPU.
 */
const COMPRESSIBLE =
  /^(?:text\/|application\/(?:json|javascript|xml|manifest|rss\+xml|atom\+xml)|image\/svg\+xml)/;

/**
 * Statuses whose body must not be compressed: 204 and 304 have none, and a 206's
 * body is a byte range of the *uncompressed* representation.
 *
 * 206 is reachable — `serveStaticFile` is `send` underneath, which advertises
 * `Accept-Ranges: bytes` and honors `Range` on the static HTML the runtime serves
 * itself. Gzipping one produced a response whose `Content-Range` still described
 * the uncompressed slice (`withGzipHeaders` drops `content-length` but cannot
 * restate a range), so the client got bytes that did not match what it asked for.
 */
const UNCOMPRESSABLE_STATUS = new Set([204, 206, 304]);

export interface PipeOptions {
  /** `next.config` `compress`. */
  readonly compress: boolean;
}

/**
 * Pipe `res` into `sink`, gzipping when that is both allowed and useful.
 *
 * Resolves when the sink's stream has finished, which for Lambda is the point the
 * client has the whole response. Must be called *before* anything writes to
 * `res`, because it subscribes to the one-shot `"head"` event.
 */
export function pipeToSink(
  req: ShimIncomingMessage,
  res: ShimServerResponse,
  sink: ResponseSink,
  options: PipeOptions,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let piping = false;
    res.once("error", reject);
    // Destroyed before the head went out, and without an error: a client that
    // disconnected before the first byte, which `handle()` answers with
    // `res.destroy()`. `Transform.destroy()` with no argument emits only
    // `"close"`, and the pipeline below never started, so nothing else can ever
    // settle this promise — leaving `handle()` awaiting it forever, its
    // `waitUntil` work (ISR revalidation, cache writes) never flushed and the
    // in-flight render's closure retained for the life of the process.
    res.once("close", () => {
      if (!piping) {
        resolve();
      }
    });
    res.once("head", (head: ResponseHead) => {
      piping = true;
      const stages: Array<Transform | Writable> = [];

      const gzip = shouldGzip(req, res, head, options);
      if (gzip) {
        const compressor = createGzip();
        // Next.js calls `res.flush()` after each chunk it writes
        // (`next/dist/server/pipe-readable.js`); without forwarding it, streamed
        // HTML sits in zlib's buffer and the response arrives all at once.
        res.flush = () => compressor.flush(constants.Z_SYNC_FLUSH);
        stages.push(compressor);
      }
      if (sink.padEmptyBody) {
        stages.push(padEmptyBody());
      }
      stages.push(sink.begin(gzip ? withGzipHeaders(head) : head));

      pipeline(res, ...(stages as [Writable])).then(resolve, reject);
    });
  });
}

function shouldGzip(
  req: ShimIncomingMessage,
  res: ShimServerResponse,
  head: ResponseHead,
  options: PipeOptions,
): boolean {
  if (!options.compress) {
    return false;
  }
  if (req.method === "HEAD" || UNCOMPRESSABLE_STATUS.has(head.statusCode)) {
    return false;
  }
  // Next.js encodes some responses itself; double-encoding is not a thing.
  if (res.hasHeader("content-encoding")) {
    return false;
  }
  if (!COMPRESSIBLE.test(head.headers["content-type"] ?? "")) {
    return false;
  }
  return acceptsGzip(req.headers["accept-encoding"]);
}

/**
 * A `q=0` on gzip is a refusal, and both `*` forms have to be honored, so this
 * parses rather than substring-matching.
 */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) {
    return false;
  }
  let wildcard: boolean | undefined;
  for (const part of value.split(",")) {
    const [rawName, ...params] = part.split(";");
    const name = rawName.trim().toLowerCase();
    if (name !== "gzip" && name !== "*") {
      continue;
    }
    const q = params
      .map((p) => p.trim().toLowerCase())
      .find((p) => p.startsWith("q="));
    const accepted = q === undefined || Number(q.slice(2)) > 0;
    if (name === "gzip") {
      return accepted;
    }
    wildcard = accepted;
  }
  return wildcard ?? false;
}

function withGzipHeaders(head: ResponseHead): ResponseHead {
  const headers: Record<string, string> = {
    ...head.headers,
    "content-encoding": "gzip",
  };
  // The length we were told is the uncompressed one, and we do not know the
  // compressed one until the stream ends.
  delete headers["content-length"];
  const vary = headers.vary;
  if (!vary) {
    headers.vary = "Accept-Encoding";
  } else if (!/\baccept-encoding\b/i.test(vary)) {
    headers.vary = `${vary}, Accept-Encoding`;
  }
  return { ...head, headers };
}

/** See {@link ResponseSink.padEmptyBody}. */
function padEmptyBody(): Transform {
  let wroteSomething = false;
  return new Transform({
    transform(chunk, _encoding, callback) {
      wroteSomething = true;
      callback(null, chunk);
    },
    flush(callback) {
      callback(null, wroteSomething ? undefined : " ");
    },
  });
}

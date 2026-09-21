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
   * Set by the API Gateway sink. A response stream with zero payload bytes after
   * the metadata delimiter makes API Gateway's `InvokeWithResponseStream`
   * integration answer 502 — it never recognizes the response as complete — so a
   * single space is written instead of nothing. `src/image-optimization/` already
   * carries this workaround for 304s; it is confined to the integration that
   * needs it because RFC 9110 forbids a body on 204/304 and CloudFront, caches,
   * and HTTP/2 clients all see the unpadded version.
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

/** No body to compress. */
const BODYLESS_STATUS = new Set([204, 304]);

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
    res.once("error", reject);
    res.once("head", (head: ResponseHead) => {
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
  if (req.method === "HEAD" || BODYLESS_STATUS.has(head.statusCode)) {
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

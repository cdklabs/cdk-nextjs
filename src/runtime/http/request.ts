/**
 * A synthesized `http.IncomingMessage`.
 *
 * Both shells use this — the Lambda shell because it has an event rather than a
 * socket, and the container shell so that the code paths Next.js exercises are
 * the ones the Lambda e2e suite covers. Handing Containers a real
 * `IncomingMessage` would mean the container suite proves nothing about Lambda.
 *
 * Derived from `serverless-http`'s `lib/request.js` (MIT, © Doug Moscrop) — the
 * fake-socket shape and the `_read` push are its work:
 * https://github.com/dougmoscrop/serverless-http/blob/master/lib/request.js
 *
 * What Next.js actually reads off `req` (`next/dist/server/base-http/node.js`,
 * `NodeNextRequest`): `method`, `url` (which it *reassigns* during
 * normalization), `headers`, `cookies` (which it *assigns*), the
 * `NEXT_REQUEST_META` symbol, `fetchMetrics`, and `on("data"|"end"|"error")`.
 * Nothing else, so nothing else needs to be faithful.
 */
import { IncomingMessage } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";

export interface IncomingMessageInit {
  readonly method: string;
  /**
   * Origin-form target: path + query, never absolute. This is what Next.js
   * parses and rewrites, so it must be exactly what the route resolved to.
   */
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  /**
   * `undefined` for bodyless requests. A `Readable` is piped through with
   * backpressure; a `Buffer` is pushed in one go.
   */
  readonly body?: Readable | Buffer;
  /** Fills `req.socket.remoteAddress`, which `x-forwarded-for` handling reads. */
  readonly remoteAddress?: string;
  /** `false` for the container shell behind an ALB terminating TLS. */
  readonly encrypted?: boolean;
}

/**
 * The subset of `net.Socket` that `IncomingMessage`'s constructor and Next.js
 * touch. A real socket cannot be synthesized, and nothing needs one.
 */
function fakeSocket(init: IncomingMessageInit) {
  return {
    encrypted: init.encrypted ?? true,
    readable: false,
    remoteAddress: init.remoteAddress,
    address: () => ({ port: init.encrypted === false ? 80 : 443 }),
    end: () => {},
    destroy: () => {},
    // `send` (used by `serveStatic`) checks this before streaming a file.
    writable: true,
  };
}

export class ShimIncomingMessage extends IncomingMessage {
  /** Set by Next.js's `NodeNextRequest.originalRequest` getter. */
  public cookies?: unknown;
  public fetchMetrics?: unknown;

  private source?: Readable;
  private pumping = false;

  public constructor(init: IncomingMessageInit) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super(fakeSocket(init) as any);

    const headers = { ...init.headers };
    const body = init.body;
    if (
      Buffer.isBuffer(body) &&
      headers["content-length"] === undefined &&
      headers["transfer-encoding"] === undefined
    ) {
      // RFC 9110: a body without a length is unframed. Next.js's body parsing
      // for Pages API routes reads `content-length`, and API Gateway / Function
      // URL events do not always carry one.
      headers["content-length"] = String(Buffer.byteLength(body));
    }

    this.method = init.method.toUpperCase();
    this.url = init.url;
    this.headers = headers;
    this.httpVersion = "1.1";
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;

    if (body === undefined) {
      this.complete = true;
      this.push(null);
    } else if (Buffer.isBuffer(body)) {
      this.complete = true;
      this.push(body);
      this.push(null);
    } else {
      this.source = body;
    }
  }

  public override _read(size?: number): void {
    const source = this.source;
    if (!source) {
      return;
    }
    if (this.pumping) {
      source.resume();
      return;
    }
    this.pumping = true;
    source.on("data", (chunk: Buffer) => {
      if (!this.push(chunk)) {
        source.pause();
      }
    });
    source.on("end", () => {
      this.complete = true;
      this.push(null);
    });
    source.on("error", (error) => {
      this.destroy(error);
    });
    void size;
  }

  /**
   * `IncomingMessage.prototype._destroy` reaches for the socket — it calls
   * `stream.finished()` on it to wait for the connection to close — and throws
   * `ERR_INVALID_ARG_TYPE` on the synthesized one. There is no connection to tear
   * down here, so the destroy is just completed, after the `"aborted"` that
   * signals a truncated request.
   */
  public override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.readableEnded || !this.complete) {
      this.aborted = true;
      this.emit("aborted");
    }
    callback(error);
  }
}

export function createIncomingMessage(
  init: IncomingMessageInit,
): ShimIncomingMessage {
  return new ShimIncomingMessage(init);
}

/** Lowercases and flattens a `Headers` into `IncomingHttpHeaders`. */
export function toIncomingHttpHeaders(headers: Headers): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  headers.forEach((value, name) => {
    if (name === "set-cookie") {
      // The only request header Node models as an array.
      result["set-cookie"] = headers.getSetCookie();
      return;
    }
    result[name] = value;
  });
  return result;
}

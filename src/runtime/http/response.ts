/**
 * A synthesized, streaming `http.ServerResponse`.
 *
 * The response *is* the stream: this is a `Transform` that Next.js writes into,
 * and the shell pipes into its own byte sink (`awslambda.HttpResponseStream` for
 * Functions, the real `ServerResponse` for Containers). Status and headers are
 * emitted once as a {@link ResponseHead} on the `"head"` event, because Lambda's
 * response stream needs them in a prelude *before* any body byte.
 *
 * Modeled on OpenNext's `OpenNextNodeResponse` (MIT, © 2022 SST):
 * https://github.com/opennextjs/opennextjs-aws/blob/main/packages/open-next/src/http/openNextResponse.ts
 *
 * Deliberately much smaller than that file. OpenNext's shim doubles as a
 * `BaseNextResponse` and re-implements the middleware header merge, because
 * OpenNext reimplements routing. We hand this object to `handler(req, res, ctx)`,
 * which wraps it in Next.js's own `NodeNextResponse`
 * (`next/dist/server/base-http/node.js`) — so the contract is just "be a
 * `ServerResponse`", and the header-merge logic belongs to `@next/routing`.
 */
import { STATUS_CODES } from "node:http";
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import { Transform } from "node:stream";
import type { TransformCallback } from "node:stream";

export interface ResponseHead {
  readonly statusCode: number;
  readonly statusMessage?: string;
  /**
   * Flat header map with `set-cookie` removed — a `Record<string, string>`
   * cannot represent it, and both sinks take cookies separately.
   */
  readonly headers: Record<string, string>;
  readonly cookies: string[];
}

/**
 * Splits a `set-cookie` value that has already been comma-joined somewhere
 * upstream. The lookbehind is the whole point: `Expires=Thu, 01 Jan 2026` has a
 * comma inside one cookie, and splitting there silently corrupts the cookie.
 */
const SET_COOKIE_SPLIT = /(?<!Expires=\w{3}),\s*/;

export function splitSetCookie(value: string | string[] | number): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => splitSetCookie(entry));
  }
  return String(value)
    .split(SET_COOKIE_SPLIT)
    .map((cookie) => cookie.trim())
    .filter(Boolean);
}

type HeaderValue = string | number | string[];

/** Node never calls these, and Next.js never calls them either. */
function unsupported(method: string): never {
  throw new Error(
    `res.${method}() is not supported by the cdk-nextjs runtime. Next.js does ` +
      `not call it, so reaching this means something else is writing the ` +
      `response.`,
  );
}

export class ShimServerResponse extends Transform {
  public statusCode = 200;
  public statusMessage?: string;
  public headersSent = false;
  /** Accepted and ignored: there is no socket to schedule a `Date` header on. */
  public sendDate = false;
  public strictContentLength = false;
  public chunkedEncoding = false;
  public shouldKeepAlive = false;
  public useChunkedEncodingByDefault = false;
  /** Set by Next.js in a few places; never read by us. */
  public req?: unknown;
  /**
   * Installed by the runtime core when it inserts gzip, so that Next.js's
   * per-chunk `if ("flush" in res) res.flush()` actually reaches the
   * compressor. Without it, streamed HTML sits in zlib's buffer.
   */
  public flush?: () => void;

  /** Lowercased name → original casing + value, mirroring Node's own store. */
  private readonly headerStore = new Map<
    string,
    { name: string; value: HeaderValue }
  >();
  private head?: ResponseHead;

  public constructor() {
    super();
  }

  // --- header API -----------------------------------------------------------

  public setHeader(name: string, value: HeaderValue): this {
    this.headerStore.set(name.toLowerCase(), { name, value });
    return this;
  }

  public appendHeader(name: string, value: string | string[]): this {
    const key = name.toLowerCase();
    const current = this.headerStore.get(key);
    if (current === undefined) {
      return this.setHeader(name, value);
    }
    const values = Array.isArray(current.value)
      ? current.value
      : [String(current.value)];
    this.headerStore.set(key, {
      name: current.name,
      value: values.concat(value),
    });
    return this;
  }

  public getHeader(name: string): HeaderValue | undefined {
    return this.headerStore.get(name.toLowerCase())?.value;
  }

  public getHeaders(): OutgoingHttpHeaders {
    const headers: OutgoingHttpHeaders = {};
    for (const { name, value } of this.headerStore.values()) {
      headers[name.toLowerCase()] = value;
    }
    return headers;
  }

  public getHeaderNames(): string[] {
    return [...this.headerStore.keys()];
  }

  public hasHeader(name: string): boolean {
    return this.headerStore.has(name.toLowerCase());
  }

  public removeHeader(name: string): void {
    this.headerStore.delete(name.toLowerCase());
  }

  public writeHead(
    statusCode: number,
    statusMessageOrHeaders?: string | OutgoingHttpHeaders | HeaderValue[],
    maybeHeaders?: OutgoingHttpHeaders | HeaderValue[],
  ): this {
    this.statusCode = statusCode;
    let headers = maybeHeaders;
    if (typeof statusMessageOrHeaders === "string") {
      this.statusMessage = statusMessageOrHeaders;
    } else if (statusMessageOrHeaders !== undefined) {
      headers = statusMessageOrHeaders;
    }

    if (Array.isArray(headers)) {
      // Node accepts a flat even/odd `[name, value, name, value]` array here,
      // not only tuples. Next.js does pass the flat form.
      const flat = Array.isArray(headers[0]) ? headers.flat() : headers;
      for (let i = 0; i < flat.length; i += 2) {
        this.setHeader(String(flat[i]), flat[i + 1] as HeaderValue);
      }
    } else if (headers) {
      for (const [name, value] of Object.entries(headers)) {
        if (value !== undefined) {
          this.setHeader(name, value as HeaderValue);
        }
      }
    }

    this.flushHeaders();
    return this;
  }

  /**
   * Freezes status + headers and emits them as the `"head"` event. Called
   * explicitly by Next.js before it streams, and lazily by this class on the
   * first byte or on `end()` when it isn't.
   */
  public flushHeaders(): void {
    if (this.headersSent) {
      return;
    }
    this.headersSent = true;
    this.head = this.buildHead();
    this.emit("head", this.head);
  }

  /** The emitted head, once `headersSent` is true. */
  public get responseHead(): ResponseHead | undefined {
    return this.head;
  }

  /** Deprecated on `ServerResponse`, but `NodeNextResponse.sent` reads it. */
  public get finished(): boolean {
    return this.writableEnded;
  }

  private buildHead(): ResponseHead {
    const headers: Record<string, string> = {};
    let cookies: string[] = [];
    for (const { name, value } of this.headerStore.values()) {
      const key = name.toLowerCase();
      if (key === "set-cookie") {
        cookies = splitSetCookie(value);
        continue;
      }
      if (Array.isArray(value)) {
        if (key === "location") {
          // Next.js sends an array `Location` when a cacheHandler `get` returns
          // null for a page that calls `redirect()`. Comma-joining produces a
          // URL that resolves to nothing, so take the last write.
          console.warn(
            `[cdk-nextjs] Next.js set ${value.length} Location headers ` +
              `(${value.join(" | ")}); using the last one.`,
          );
          headers[key] = String(value[value.length - 1]);
          continue;
        }
        headers[key] = value.join(", ");
        continue;
      }
      headers[key] = String(value);
    }
    return {
      statusCode: this.statusCode,
      statusMessage: this.statusMessage ?? STATUS_CODES[this.statusCode],
      headers,
      cookies,
    };
  }

  // --- stream ---------------------------------------------------------------

  public override _transform(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    // Lazily, because Next.js only calls `flushHeaders()` on the paths that
    // stream. `sendPayload` just writes and ends.
    this.flushHeaders();
    callback(null, chunk);
  }

  public override _flush(callback: TransformCallback): void {
    // An empty body still needs a status line.
    this.flushHeaders();
    callback();
  }

  // --- the rest of the ServerResponse surface -------------------------------

  public addTrailers(): never {
    return unsupported("addTrailers");
  }
  public assignSocket(): never {
    return unsupported("assignSocket");
  }
  public detachSocket(): never {
    return unsupported("detachSocket");
  }
  public writeContinue(): never {
    return unsupported("writeContinue");
  }
  public writeEarlyHints(): never {
    return unsupported("writeEarlyHints");
  }
  public writeProcessing(): never {
    return unsupported("writeProcessing");
  }
}

/**
 * `ShimServerResponse` is structurally a `ServerResponse` for everything Next.js
 * touches, but not nominally one (no socket, no trailers). The entrypoint
 * signature wants the real type, so the cast is centralized here with the
 * reasoning attached rather than repeated at each call site.
 */
export function asServerResponse(res: ShimServerResponse): ServerResponse {
  return res as unknown as ServerResponse;
}

import { Writable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { createIncomingMessage, ShimIncomingMessage } from "./request";
import { ResponseHead, ShimServerResponse } from "./response";
import { acceptsGzip, pipeToSink, ResponseSink } from "./sink";

class CollectingSink implements ResponseSink {
  public head?: ResponseHead;
  public readonly chunks: Buffer[] = [];

  public constructor(public readonly padEmptyBody = false) {}

  public begin(head: ResponseHead): Writable {
    this.head = head;
    const chunks = this.chunks;
    return new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
  }

  public get body(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function requestWith(
  headers: Record<string, string>,
  method = "GET",
): ShimIncomingMessage {
  return createIncomingMessage({ method, url: "/", headers });
}

interface PipeCase {
  readonly req?: ShimIncomingMessage;
  readonly compress?: boolean;
  readonly padEmptyBody?: boolean;
}

/** Runs one response through the sink and resolves once the sink is finished. */
async function run(
  write: (res: ShimServerResponse) => void,
  options: PipeCase = {},
): Promise<CollectingSink> {
  const req = options.req ?? requestWith({ "accept-encoding": "gzip" });
  const res = new ShimServerResponse();
  const sink = new CollectingSink(options.padEmptyBody);
  const done = pipeToSink(req, res, sink, {
    compress: options.compress ?? true,
  });
  write(res);
  await done;
  return sink;
}

describe("pipeToSink compression", () => {
  it("gzips compressible content when the client accepts it", async () => {
    const sink = await run((res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Length", "13");
      res.end("<p>hello</p>");
    });
    expect(sink.head?.headers["content-encoding"]).toBe("gzip");
    // The length we were told is the uncompressed one and the compressed one is
    // not known until the stream ends.
    expect(sink.head?.headers["content-length"]).toBeUndefined();
    expect(sink.head?.headers.vary).toBe("Accept-Encoding");
    expect(gunzipSync(sink.body).toString("utf-8")).toBe("<p>hello</p>");
  });

  it("appends to an existing vary rather than replacing it", async () => {
    const sink = await run((res) => {
      res.setHeader("Content-Type", "text/html");
      res.setHeader("Vary", "Cookie");
      res.end("x");
    });
    expect(sink.head?.headers.vary).toBe("Cookie, Accept-Encoding");
  });

  it("forwards res.flush() to the compressor so streamed HTML is not buffered", async () => {
    const seen: number[] = [];
    const sink = await run((res) => {
      res.setHeader("Content-Type", "text/html");
      res.write("<html>");
      // Next.js does exactly this after every chunk (`pipe-readable.js`).
      res.flush?.();
      seen.push(1);
      res.end("</html>");
    });
    expect(seen).toEqual([1]);
    expect(gunzipSync(sink.body).toString("utf-8")).toBe("<html></html>");
  });

  it.each([
    ["an incompressible content type", { "content-type": "image/avif" }],
    ["an already-encoded body", { "content-encoding": "br" }],
  ])("does not gzip %s", async (_name, headers) => {
    const sink = await run((res) => {
      for (const [name, value] of Object.entries(headers)) {
        res.setHeader(name, value);
      }
      res.end("body");
    });
    expect(sink.head?.headers["content-encoding"]).not.toBe("gzip");
    expect(sink.body.toString("utf-8")).toBe("body");
  });

  it("does not gzip a 206, whose body is a range of the stored bytes", async () => {
    // The one uncompressable status that carries a body. `content-range` counts
    // bytes of the representation the client asked for, so gzipping the slice
    // makes the range meaningless - and a client stitching ranges together
    // (video, a resumed download) cannot use it.
    const sink = await run((res) => {
      res.statusCode = 206;
      res.setHeader("Content-Type", "text/plain");
      res.setHeader("Content-Range", "bytes 0-3/1000");
      res.end("body");
    });
    expect(sink.head?.headers["content-encoding"]).toBeUndefined();
    expect(sink.body.toString("utf-8")).toBe("body");
  });

  it("does not gzip when the client did not offer it", async () => {
    const sink = await run(
      (res) => {
        res.setHeader("Content-Type", "text/html");
        res.end("body");
      },
      { req: requestWith({}) },
    );
    expect(sink.head?.headers["content-encoding"]).toBeUndefined();
    expect(sink.body.toString("utf-8")).toBe("body");
  });

  it("does not gzip when next.config sets compress: false", async () => {
    const sink = await run(
      (res) => {
        res.setHeader("Content-Type", "text/html");
        res.end("body");
      },
      { compress: false },
    );
    expect(sink.head?.headers["content-encoding"]).toBeUndefined();
  });

  it.each([
    ["a HEAD request", { method: "HEAD", status: 200 }],
    ["a 204", { method: "GET", status: 204 }],
    ["a 304", { method: "GET", status: 304 }],
  ])("does not gzip %s", async (_name, { method, status }) => {
    const sink = await run(
      (res) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "text/html");
        res.end();
      },
      { req: requestWith({ "accept-encoding": "gzip" }, method) },
    );
    expect(sink.head?.headers["content-encoding"]).toBeUndefined();
  });
});

describe("pipeToSink empty-body padding", () => {
  it("writes a single space when the sink asks for it", async () => {
    const sink = await run(
      (res) => {
        res.statusCode = 304;
        res.end();
      },
      { padEmptyBody: true },
    );
    // Zero payload bytes after the prelude makes API Gateway answer 502, and
    // makes a Function URL drop the prelude and answer a bare
    // `200 application/octet-stream`.
    expect(sink.body.toString("utf-8")).toBe(" ");
  });

  it("pads a HEAD response, whose body is empty by definition", async () => {
    const sink = await run(
      (res) => {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("content-length", "5798");
        res.end();
      },
      {
        padEmptyBody: true,
        req: requestWith({ "accept-encoding": "gzip" }, "HEAD"),
      },
    );
    expect(sink.body.toString("utf-8")).toBe(" ");
    // The head still describes what a GET would return; the padding byte is not
    // a body and the integration overwrites `content-length` with 0.
    expect(sink.head?.headers["content-length"]).toBe("5798");
  });

  it("leaves a non-empty body alone", async () => {
    const sink = await run((res) => res.end("real"), {
      padEmptyBody: true,
      compress: false,
    });
    expect(sink.body.toString("utf-8")).toBe("real");
  });

  it("sends nothing for an empty body when the sink does not ask", async () => {
    const sink = await run((res) => {
      res.statusCode = 304;
      res.end();
    });
    expect(sink.body).toHaveLength(0);
  });
});

describe("pipeToSink lifecycle", () => {
  /**
   * `handle()` awaits this promise before it flushes `waitUntil` work — ISR
   * revalidation, cache writes — and before the request's closures can be
   * collected. A client that disconnects before the first byte destroys the
   * response without an error, which emits only `"close"`: the pipeline never
   * started, so nothing else can settle the promise and the await never returned.
   */
  it("settles when the response is destroyed before the head goes out", async () => {
    const req = requestWith({});
    const res = new ShimServerResponse();
    const done = pipeToSink(req, res, new CollectingSink(), {
      compress: true,
    });

    res.destroy();

    await expect(done).resolves.toBeUndefined();
  });

  // The normal path has to keep settling on the pipeline, not on `"close"`: the
  // body must be fully flushed into the sink by the time this resolves.
  it("still settles on the pipeline once the head has gone out", async () => {
    const sink = await run(
      (res) => {
        res.setHeader("content-type", "text/plain");
        res.end("body");
      },
      { compress: false },
    );

    expect(sink.body.toString()).toBe("body");
  });

  it("rejects when the response errors", async () => {
    const req = requestWith({});
    const res = new ShimServerResponse();
    const done = pipeToSink(req, res, new CollectingSink(), {
      compress: true,
    });

    res.destroy(new Error("boom"));

    await expect(done).rejects.toThrow("boom");
  });
});

describe("acceptsGzip", () => {
  it.each([
    ["gzip", true],
    ["gzip, deflate, br", true],
    ["GZIP;q=0.5", true],
    ["gzip;q=0", false],
    ["*", true],
    ["*;q=0", false],
    // An explicit gzip preference wins over the wildcard, in either order.
    ["*;q=0, gzip", true],
    ["gzip;q=0, *", false],
    ["br, deflate", false],
    ["", false],
    [undefined, false],
  ])("%s → %s", (header, expected) => {
    expect(acceptsGzip(header)).toBe(expected);
  });

  it("joins a repeated header before parsing", () => {
    expect(acceptsGzip(["br", "gzip"])).toBe(true);
  });
});

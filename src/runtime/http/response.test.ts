import { ResponseHead, ShimServerResponse, splitSetCookie } from "./response";

/** Collects the head and the body bytes the way a sink would. */
function collect(res: ShimServerResponse): {
  head: () => ResponseHead | undefined;
  body: () => string;
} {
  let head: ResponseHead | undefined;
  const chunks: Buffer[] = [];
  res.once("head", (value: ResponseHead) => {
    head = value;
  });
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  return {
    head: () => head,
    body: () => Buffer.concat(chunks).toString("utf-8"),
  };
}

function finished(res: ShimServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    res.once("end", resolve);
    res.once("error", reject);
    res.resume();
  });
}

describe("ShimServerResponse head", () => {
  it("emits status and headers once, on the first body byte", async () => {
    const res = new ShimServerResponse();
    const sink = collect(res);
    res.setHeader("Content-Type", "text/html");
    expect(sink.head()).toBeUndefined();

    res.write("<p>hi</p>");
    expect(sink.head()).toEqual({
      statusCode: 200,
      statusMessage: "OK",
      headers: { "content-type": "text/html" },
      cookies: [],
    });
    res.end();
    await finished(res);
    expect(sink.body()).toBe("<p>hi</p>");
  });

  it("still emits a head for an empty body", async () => {
    const res = new ShimServerResponse();
    const sink = collect(res);
    res.statusCode = 204;
    res.end();
    await finished(res);
    expect(sink.head()?.statusCode).toBe(204);
  });

  it("is idempotent, so an explicit flushHeaders() plus a write emits once", () => {
    const res = new ShimServerResponse();
    const heads: ResponseHead[] = [];
    res.on("head", (head: ResponseHead) => heads.push(head));
    res.flushHeaders();
    res.write("a");
    res.flushHeaders();
    expect(heads).toHaveLength(1);
    expect(res.headersSent).toBe(true);
  });

  it("reports `finished` once ended, which NodeNextResponse.sent reads", async () => {
    const res = new ShimServerResponse();
    collect(res);
    expect(res.finished).toBe(false);
    res.end("x");
    await finished(res);
    expect(res.finished).toBe(true);
  });
});

describe("ShimServerResponse headers", () => {
  it("keeps set-cookie out of the flat map", () => {
    const res = new ShimServerResponse();
    const sink = collect(res);
    res.appendHeader("Set-Cookie", "a=1; Path=/");
    res.appendHeader("Set-Cookie", "b=2; Path=/");
    res.setHeader("X-Other", "keep");
    res.flushHeaders();
    expect(sink.head()?.cookies).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(sink.head()?.headers).toEqual({ "x-other": "keep" });
  });

  it("joins other repeated headers with a comma", () => {
    const res = new ShimServerResponse();
    const sink = collect(res);
    res.setHeader("Vary", ["Accept", "Cookie"]);
    res.flushHeaders();
    expect(sink.head()?.headers.vary).toBe("Accept, Cookie");
  });

  it("takes the last of multiple Location values and warns", () => {
    const res = new ShimServerResponse();
    const sink = collect(res);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    res.setHeader("Location", ["/first", "/second"]);
    res.flushHeaders();
    // Comma-joining would produce a URL that resolves to nothing.
    expect(sink.head()?.headers.location).toBe("/second");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("is case-insensitive and supports the rest of the header API", () => {
    const res = new ShimServerResponse();
    res.setHeader("X-A", "1");
    expect(res.getHeader("x-a")).toBe("1");
    expect(res.hasHeader("X-A")).toBe(true);
    expect(res.getHeaderNames()).toEqual(["x-a"]);
    expect(res.getHeaders()).toEqual({ "x-a": "1" });
    res.removeHeader("X-A");
    expect(res.hasHeader("x-a")).toBe(false);
  });
});

describe("ShimServerResponse.writeHead", () => {
  it("accepts a status message plus a header object", () => {
    const res = new ShimServerResponse();
    const sink = collect(res);
    res.writeHead(301, "Moved", { Location: "/there" });
    expect(sink.head()).toEqual({
      statusCode: 301,
      statusMessage: "Moved",
      headers: { location: "/there" },
      cookies: [],
    });
  });

  it("accepts the flat even/odd array form Next.js passes", () => {
    const res = new ShimServerResponse();
    const sink = collect(res);
    res.writeHead(200, ["Content-Type", "text/plain", "X-B", "2"]);
    expect(sink.head()?.headers).toEqual({
      "content-type": "text/plain",
      "x-b": "2",
    });
  });

  it("accepts the tuple array form", () => {
    const res = new ShimServerResponse();
    const sink = collect(res);
    res.writeHead(200, [
      ["Content-Type", "text/plain"],
      ["X-B", "2"],
    ] as unknown as string[][]);
    expect(sink.head()?.headers).toEqual({
      "content-type": "text/plain",
      "x-b": "2",
    });
  });
});

describe("splitSetCookie", () => {
  it("does not split the comma inside an Expires date", () => {
    expect(
      splitSetCookie("a=1; Expires=Thu, 01 Jan 2026 00:00:00 GMT, b=2; Path=/"),
    ).toEqual(["a=1; Expires=Thu, 01 Jan 2026 00:00:00 GMT", "b=2; Path=/"]);
  });

  it("flattens an array and drops empties", () => {
    expect(splitSetCookie(["a=1", "b=2, c=3", ""])).toEqual([
      "a=1",
      "b=2",
      "c=3",
    ]);
  });
});

describe("unsupported ServerResponse methods", () => {
  it.each(["addTrailers", "assignSocket", "writeContinue", "writeEarlyHints"])(
    "throws a named error from %s()",
    (method) => {
      const res = new ShimServerResponse() as unknown as Record<
        string,
        () => void
      >;
      expect(() => res[method]()).toThrow(`res.${method}()`);
    },
  );
});

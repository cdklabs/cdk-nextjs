import { Readable } from "node:stream";
import { createIncomingMessage, toIncomingHttpHeaders } from "./request";

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

describe("createIncomingMessage", () => {
  it("exposes the request line and headers Next.js reads", () => {
    const req = createIncomingMessage({
      method: "get",
      url: "/a?b=c",
      headers: { host: "example.test" },
    });
    // Uppercased: Next.js compares `req.method === "POST"` in several places.
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/a?b=c");
    expect(req.headers.host).toBe("example.test");
    expect(req.httpVersion).toBe("1.1");
  });

  it("ends the stream immediately when there is no body", async () => {
    const req = createIncomingMessage({
      method: "GET",
      url: "/",
      headers: {},
    });
    expect(req.complete).toBe(true);
    await expect(readAll(req)).resolves.toBe("");
  });

  it("frames a Buffer body with a content-length", async () => {
    const req = createIncomingMessage({
      method: "POST",
      url: "/api",
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"a":1}'),
    });
    // Pages API body parsing reads `content-length`, and neither Function URL
    // nor API Gateway events reliably carry one.
    expect(req.headers["content-length"]).toBe("7");
    await expect(readAll(req)).resolves.toBe('{"a":1}');
  });

  it("leaves an existing content-length alone", () => {
    const req = createIncomingMessage({
      method: "POST",
      url: "/api",
      headers: { "content-length": "99" },
      body: Buffer.from("ab"),
    });
    expect(req.headers["content-length"]).toBe("99");
  });

  it("pipes a streamed body through", async () => {
    const req = createIncomingMessage({
      method: "PUT",
      url: "/upload",
      headers: { "transfer-encoding": "chunked" },
      body: Readable.from([Buffer.from("one "), Buffer.from("two")]),
    });
    await expect(readAll(req)).resolves.toBe("one two");
    expect(req.complete).toBe(true);
  });

  it("destroys itself when the source stream errors", async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error("upstream gone"));
      },
    });
    const req = createIncomingMessage({
      method: "POST",
      url: "/",
      headers: {},
      body: source,
    });
    await expect(readAll(req)).rejects.toThrow("upstream gone");
  });

  it("fills the socket fields that `send` and x-forwarded-for handling read", () => {
    const req = createIncomingMessage({
      method: "GET",
      url: "/",
      headers: {},
      remoteAddress: "203.0.113.7",
      encrypted: false,
    });
    expect(req.socket.remoteAddress).toBe("203.0.113.7");
    // `serveStatic` checks `res.socket.writable` before streaming a file.
    expect(req.socket.writable).toBe(true);
  });
});

describe("toIncomingHttpHeaders", () => {
  it("flattens a Headers, keeping set-cookie as an array", () => {
    const headers = new Headers({ "x-a": "1" });
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");
    expect(toIncomingHttpHeaders(headers)).toEqual({
      "x-a": "1",
      "set-cookie": ["a=1", "b=2"],
    });
  });
});

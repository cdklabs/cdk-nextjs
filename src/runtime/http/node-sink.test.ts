import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { NodeResponseSink } from "./node-sink";
import { ResponseHead } from "./response";

/**
 * A real `node:http` server, because what is under test is how Node's own
 * `writeHead` validation interacts with the sink: a stub `ServerResponse` would
 * not reject the header values that hung the container shell.
 */
async function respondWith(
  head: ResponseHead,
): Promise<{ status?: number; body: string; thrown: unknown }> {
  let thrown: unknown;
  const server = createServer((_req, res) => {
    try {
      new NodeResponseSink(res).begin(head).end("the body");
    } catch (error) {
      thrown = error;
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise((resolve, reject) => {
      const req = httpRequest({ port, host: "127.0.0.1", path: "/" }, (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body, thrown }));
      });
      // What the ALB did: wait for an answer that never came.
      req.setTimeout(2_000, () => reject(new Error("the response hung")));
      req.on("error", reject);
      req.end();
    });
  } finally {
    server.close();
  }
}

describe("NodeResponseSink", () => {
  it("writes the head, cookies included, and hands back the response", async () => {
    const result = await respondWith({
      statusCode: 201,
      headers: { "content-type": "text/plain" },
      cookies: ["a=1", "b=2"],
    });
    expect(result).toMatchObject({ status: 201, body: "the body" });
    expect(result.thrown).toBeUndefined();
  });

  it.each([
    ["a non-latin1 value", 'attachment; filename="résumé—final.pdf"'],
    ["a CR/LF", "one\r\nx-injected: yes"],
  ])(
    "answers 500 rather than hanging when writeHead rejects %s",
    async (_name, value) => {
      const result = await respondWith({
        statusCode: 200,
        headers: { "content-disposition": value },
        cookies: [],
      });
      expect(result.status).toBe(500);
      expect(result.body).toBe("Internal Server Error");
      // Rethrown, so `pipeToSink` tears the render down. (Node's own error
      // class, from outside Jest's realm, hence not `toBeInstanceOf`.)
      expect(result.thrown).toMatchObject({ code: "ERR_INVALID_CHAR" });
    },
  );
});

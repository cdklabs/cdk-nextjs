import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { NextjsRuntime } from "../core";
import { createRuntimeServer, hasRequestBody } from "./node-server";

type Handle = NextjsRuntime["handle"];

/** A real server around a stub runtime, and one request to it. */
async function withServer<T>(
  handle: Handle,
  run: (
    get: () => Promise<{ status?: number; body: string }>,
    shutdown: () => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const { server, shutdown } = createRuntimeServer({ handle });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const get = () =>
    new Promise<{ status?: number; body: string }>((resolve, reject) => {
      // No keep-alive agent, so the connection closes with the response and
      // `server.close` is not left waiting on an idle socket.
      const req = httpRequest(
        { port, host: "127.0.0.1", path: "/", agent: false },
        (res) => {
          let body = "";
          res.setEncoding("utf-8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  try {
    return await run(get, shutdown);
  } finally {
    server.close();
  }
}

describe("hasRequestBody", () => {
  const message = (method: string, headers: Record<string, string> = {}) =>
    ({ method, headers }) as unknown as IncomingMessage;

  it("is false for GET and HEAD, whatever their framing says", () => {
    expect(hasRequestBody(message("GET", { "content-length": "3" }))).toBe(
      false,
    );
    expect(
      hasRequestBody(message("HEAD", { "transfer-encoding": "chunked" })),
    ).toBe(false);
  });

  it("is true only for a body that is actually framed", () => {
    expect(hasRequestBody(message("POST"))).toBe(false);
    expect(hasRequestBody(message("POST", { "content-length": "0" }))).toBe(
      true,
    );
    expect(
      hasRequestBody(message("DELETE", { "transfer-encoding": "chunked" })),
    ).toBe(true);
  });
});

describe("createRuntimeServer", () => {
  it("answers a plain 500 when the shell itself fails", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await withServer(
        async () => {
          throw new Error("translation failed");
        },
        (get) => get(),
      );
      expect(response).toEqual({ status: 500, body: "Internal Server Error" });
      expect(String(error.mock.calls[0][0])).toMatch(/container shell failed/);
    } finally {
      error.mockRestore();
    }
  });

  // What an ECS rolling deploy does: SIGTERM while an ISR regeneration is still
  // running in `waitUntil`, after its response has gone out.
  it("shuts down only once in-flight waitUntil work has settled", async () => {
    let release!: () => void;
    const waitUntilWork = new Promise<void>((resolve) => (release = resolve));
    const handle: Handle = async (_request, sink) => {
      sink.begin({ statusCode: 200, headers: {}, cookies: [] }).end("ok");
      await waitUntilWork;
    };
    await withServer(handle, async (get, shutdown) => {
      expect(await get()).toEqual({ status: 200, body: "ok" });

      let stopped = false;
      const stopping = shutdown().then(() => (stopped = true));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stopped).toBe(false);

      release();
      await stopping;
      expect(stopped).toBe(true);
    });
  });
});

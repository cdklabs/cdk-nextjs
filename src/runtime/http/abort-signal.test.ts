import { createServer, request, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { clientAbortSignal } from "./abort-signal";

/** A server whose handler hands each request's signal to `onSignal`. */
function listen(
  handler: (
    signal: AbortSignal,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) =>
    handler(clientAbortSignal(req, res), res),
  );
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    ),
  );
}

describe("clientAbortSignal", () => {
  let server: Server | undefined;
  afterEach(
    () =>
      new Promise<void>((resolve) =>
        server ? server.close(() => resolve()) : resolve(),
      ),
  );

  // A long-poll: the request is complete, so `aborted` never fires on it.
  it("fires when the client leaves after sending a complete request", async () => {
    let signal!: AbortSignal;
    const seen = new Promise<void>((resolve) => {
      void listen((s, res) => {
        signal = s;
        res.writeHead(200);
        res.write("waiting");
        s.addEventListener("abort", () => resolve());
      }).then((listening) => {
        server = listening.server;
        const req = request({ port: listening.port, path: "/" }, (res) => {
          res.once("data", () => req.destroy());
        });
        req.end();
      });
    });
    await seen;
    expect(signal.aborted).toBe(true);
  });

  it("stays quiet for a response that finished", async () => {
    let signal!: AbortSignal;
    const closed = new Promise<void>((resolve) => {
      void listen((s, res) => {
        signal = s;
        res.once("close", () => resolve());
        res.end("done");
      }).then((listening) => {
        server = listening.server;
        request({ port: listening.port, path: "/" }, (res) =>
          res.resume(),
        ).end();
      });
    });
    await closed;
    expect(signal.aborted).toBe(false);
  });
});

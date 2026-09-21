/**
 * The Containers shell: a `node:http` server around the runtime core.
 *
 * Replaces the `server.js` that `output: "standalone"` used to generate. Note
 * what it does *not* do: it does not hand Next.js the real `IncomingMessage` /
 * `ServerResponse` it was given. Those are translated into a
 * {@link RuntimeRequest} and a {@link ResponseSink}, exactly as the Lambda shell
 * does, so the container e2e suite exercises the code Lambda runs. Handing
 * Containers real `node:http` objects would make those tests prove nothing about
 * Functions — which is how the previous implementation's Lambda-only bugs got
 * past a green container suite.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { loadRuntime, NextjsRuntime } from "./core";
import { deploymentRootOf } from "./deployment-root";
import type { ResponseHead } from "./http/response";
import type { ResponseSink } from "./http/sink";

const PORT = Number(process.env.PORT ?? 3000);
/** ECS tasks must bind every interface to be reachable by the ALB. */
const HOSTNAME = process.env.HOSTNAME ?? "0.0.0.0";

/** Methods RFC 9110 allows a body on, and only when one is actually framed. */
function hasRequestBody(req: IncomingMessage): boolean {
  if (req.method === "GET" || req.method === "HEAD") {
    return false;
  }
  return (
    req.headers["content-length"] !== undefined ||
    req.headers["transfer-encoding"] !== undefined
  );
}

class NodeResponseSink implements ResponseSink {
  public constructor(private readonly res: ServerResponse) {}

  public begin(head: ResponseHead): Writable {
    this.res.writeHead(head.statusCode, head.statusMessage, {
      ...head.headers,
      // The one header Node models as an array, which is exactly why
      // `ResponseHead` carries cookies separately.
      ...(head.cookies.length > 0 ? { "set-cookie": head.cookies } : {}),
    });
    return this.res;
  }
}

async function serve(
  runtime: NextjsRuntime,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const aborted = new AbortController();
  req.once("aborted", () => aborted.abort());

  await runtime.handle(
    {
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers,
      body: hasRequestBody(req) ? req : undefined,
      remoteAddress: req.socket.remoteAddress,
      // TLS terminates at the ALB (Regional) or CloudFront (Global); the hop to
      // this container is plaintext HTTP/1.1.
      encrypted: false,
      signal: aborted.signal,
    },
    new NodeResponseSink(res),
  );
}

async function main(): Promise<void> {
  const runtime = await loadRuntime(
    deploymentRootOf(dirname(fileURLToPath(import.meta.url))),
  );

  const server = createServer((req, res) => {
    serve(runtime, req, res).catch((error) => {
      // `NextjsRuntime.handle` answers 500 itself, so reaching this means the
      // shell's own translation failed.
      console.error("The container shell failed to handle a request:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("Internal Server Error");
    });
  });

  // ECS sends SIGTERM and waits `stopTimeout` before SIGKILL. Without this the
  // process exits immediately and every in-flight response is truncated during
  // an ordinary deployment.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      console.log(`Received ${signal}, draining connections.`);
      server.close(() => process.exit(0));
    });
  }

  server.listen(PORT, HOSTNAME, () => {
    console.log(`cdk-nextjs runtime listening on ${HOSTNAME}:${PORT}`);
  });
}

void main();

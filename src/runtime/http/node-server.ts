/**
 * The container shell's `node:http` server, and its shutdown.
 *
 * Its own module rather than inline in `server.mts` so it can be tested without
 * starting the server that module starts on import.
 */
import { createServer } from "node:http";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";
import type { NextjsRuntime } from "../core";
import { clientAbortSignal } from "./abort-signal";
import { NodeResponseSink } from "./node-sink";

/**
 * Longer than the ALB's idle timeout (60 s by default). With Node's default of
 * 5 s, the server closes keep-alive connections the ALB still considers open;
 * the ALB answers the next request on one with a 502, and CloudFront caches
 * that 502 for its error caching TTL, failing every request for the path until
 * it expires. An ALB with a longer idle timeout needs this raised to match.
 * https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html#connection-idle-timeout
 */
const KEEP_ALIVE_TIMEOUT_MS = 65_000;

/** Methods RFC 9110 allows a body on, and only when one is actually framed. */
export function hasRequestBody(req: IncomingMessage): boolean {
  if (req.method === "GET" || req.method === "HEAD") {
    return false;
  }
  return (
    req.headers["content-length"] !== undefined ||
    req.headers["transfer-encoding"] !== undefined
  );
}

export interface RuntimeServer {
  readonly server: Server;
  /**
   * Stops accepting connections, then resolves once the open ones are gone and
   * every request's `waitUntil` work has settled.
   */
  shutdown(): Promise<void>;
}

export interface RuntimeServerOptions {
  /**
   * Whether every request comes through CloudFront, which sets
   * `cloudfront-forwarded-proto` itself. True only on Global Containers, whose
   * ALB is reachable through the distribution's VPC origin alone
   * (`CDK_NEXTJS_TRUST_CLOUDFRONT_PROTO`, set by the construct). See
   * {@link viewerHeaders}.
   */
  readonly trustCloudFrontProto?: boolean;
}

export function createRuntimeServer(
  runtime: Pick<NextjsRuntime, "handle">,
  options: RuntimeServerOptions = {},
): RuntimeServer {
  // `handle` resolves only once the `waitUntil` work a request registered — ISR
  // revalidation, notably — has settled, which is after its response and its
  // connection are done. Tracked so shutdown can wait for that too.
  const inFlight = new Set<Promise<void>>();

  const server = createServer((req, res) => {
    const handled = serve(runtime, req, res, options)
      .catch((error) => {
        // `NextjsRuntime.handle` answers 500 itself, so reaching this means the
        // shell's own translation failed.
        console.error("The container shell failed to handle a request:", error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        }
        res.end("Internal Server Error");
      })
      .finally(() => inFlight.delete(handled));
    inFlight.add(handled);
  });
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  // must exceed keepAliveTimeout, or Node can drop a connection that just
  // started sending a request's headers
  server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 1_000;

  // `server.close` alone is not enough: it calls back once the connections are
  // gone, and a revalidation still running in `waitUntil` would be killed
  // mid-write, losing the fresh entry.
  const shutdown = () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        void Promise.allSettled(inFlight).then(() => resolve());
      });
    });

  return { server, shutdown };
}

/**
 * The request's headers, with `x-forwarded-proto` naming the viewer's protocol
 * when that is known.
 *
 * Behind CloudFront without a certificate, CloudFront reaches the ALB over plain
 * HTTP, so the ALB's `x-forwarded-proto` is `http` for an app every viewer
 * reaches over HTTPS. The runtime builds absolute URLs from it - `request.url`,
 * `req.nextUrl.origin`, and the origin Next.js forwards a server action to,
 * where CloudFront then answered 307 and `test/e2e/app-dir/action-forward-loop`
 * failed. CloudFront's own `cloudfront-forwarded-proto` is the viewer's, but it
 * is trusted only when every request comes through CloudFront: anywhere else a
 * client could send it straight to the ALB and pick the scheme of URLs a cached
 * page then serves to everyone.
 */
export function viewerHeaders(
  headers: IncomingHttpHeaders,
  trustCloudFrontProto: boolean | undefined,
): IncomingHttpHeaders {
  const viewerProto = headers["cloudfront-forwarded-proto"];
  if (!trustCloudFrontProto || typeof viewerProto !== "string") {
    return headers;
  }
  return { ...headers, "x-forwarded-proto": viewerProto };
}

async function serve(
  runtime: Pick<NextjsRuntime, "handle">,
  req: IncomingMessage,
  res: ServerResponse,
  options: RuntimeServerOptions,
): Promise<void> {
  await runtime.handle(
    {
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: viewerHeaders(req.headers, options.trustCloudFrontProto),
      body: hasRequestBody(req) ? req : undefined,
      remoteAddress: req.socket.remoteAddress,
      // TLS terminates at the ALB (Regional) or CloudFront (Global); the hop to
      // this container is plaintext HTTP/1.1.
      encrypted: false,
      signal: clientAbortSignal(req, res),
    },
    new NodeResponseSink(res),
  );
}

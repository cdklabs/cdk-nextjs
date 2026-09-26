/**
 * The container shell's {@link ResponseSink}: the head goes to a real
 * `node:http` `ServerResponse`, which is then the stream the body is piped into.
 *
 * Its own module rather than inline in `server.mts` so it can be tested without
 * starting the server that module starts on import.
 */
import type { ServerResponse } from "node:http";
import type { Writable } from "node:stream";
import type { ResponseHead } from "./response";
import type { ResponseSink } from "./sink";

export class NodeResponseSink implements ResponseSink {
  public constructor(private readonly res: ServerResponse) {}

  public begin(head: ResponseHead): Writable {
    try {
      this.res.writeHead(head.statusCode, head.statusMessage, {
        ...head.headers,
        // The one header Node models as an array, which is exactly why
        // `ResponseHead` carries cookies separately.
        ...(head.cookies.length > 0 ? { "set-cookie": head.cookies } : {}),
      });
    } catch (error) {
      // `writeHead` rejects a header value Node will not put on the wire — a
      // non-latin1 `Content-Disposition` filename, a CR/LF. `pipeToSink` tears
      // down the render when this rethrows, but nothing ever answered the real
      // response: the connection sat open until the ALB's idle timeout and the
      // client got a 502/504. `sendError`'s 500 cannot help, since the head it
      // would send never gets this far either.
      failHead(this.res);
      throw error;
    }
    return this.res;
  }
}

/** Answer a plain 500 in place of a head `writeHead` refused. */
function failHead(res: ServerResponse): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  // The refused call may have set some of its headers before it threw.
  for (const name of res.getHeaderNames()) {
    res.removeHeader(name);
  }
  res.writeHead(500, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "private, no-cache, no-store, max-age=0, must-revalidate",
  });
  res.end("Internal Server Error");
}

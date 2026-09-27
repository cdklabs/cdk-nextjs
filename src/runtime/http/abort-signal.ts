/**
 * An `AbortSignal` that fires when the client of a `node:http` request goes
 * away, for the Containers shell to hand the runtime as `RuntimeRequest.signal`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export function clientAbortSignal(
  req: IncomingMessage,
  res: ServerResponse,
): AbortSignal {
  const aborted = new AbortController();
  req.once("aborted", () => aborted.abort());
  // `aborted` only fires while the request body is still arriving. A client that
  // sent a complete request and then left — a long-poll, an SSE stream — is only
  // seen as the response's socket closing before the response finished, which
  // is also how `next start` notices it (`res.on('close')` in
  // `signalFromNodeResponse`).
  res.once("close", () => {
    if (!res.writableFinished) {
      aborted.abort();
    }
  });
  return aborted.signal;
}

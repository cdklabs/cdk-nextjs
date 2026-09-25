import { createHash } from "node:crypto";
import { test, expect } from "@playwright/test";

/**
 * The shapes of response body that the four deployment types carry differently.
 *
 * All four put something between Next.js and the client that has an opinion about
 * bodies: CloudFront wants a `content-length`, API Gateway in STREAM mode drops
 * `content-encoding` and base64-encodes what it forwards, an ALB does neither, and
 * a Lambda response stream has a prelude that has to survive having nothing after
 * it. The runtime therefore compresses `text/*` itself and pads an empty body, and
 * both of those are invisible to a unit test - the bug they fix only exists once a
 * real integration is in the path.
 *
 * What silently breaks without these: a large binary download truncated at 6 MB, a
 * 204 that arrives as a 200 with no app headers at all, a streamed response that
 * gets buffered and so stops being a stream.
 */
test.describe("response bodies", () => {
  /**
   * `padEmptyBody` in `src/runtime/http/sink.ts` writes a single space when the
   * app produced no payload, because a genuinely zero-byte streamed response is
   * not recognised: API Gateway answers 502, and a Function URL discards the
   * prelude and answers a bare `200 application/octet-stream`. So "empty" on the
   * wire means one byte or fewer, by design - do not tighten this to 0.
   */
  const EMPTY_BODY_MAX_BYTES = 1;

  test("streams a large incompressible body through intact", async ({
    request,
  }) => {
    // 5 MiB of `application/octet-stream`. The size is chosen against Lambda's
    // 6 MB *buffered* response cap: base64 inflates 5 MiB to ~6.7 MB, so anything
    // that stops streaming and buffers fails here. A text body of any size would
    // not, because the runtime gzips `text/*` itself and megabytes of it collapse
    // to kilobytes.
    const bytes = 5 * 1024 * 1024;
    const response = await request.get(`./api/echo?bytes=${bytes}`);
    expect(response.status()).toBe(200);

    const headers = response.headers();
    expect(headers["content-type"]).toBe("application/octet-stream");
    // Not compressible, so nothing in the path should claim it compressed it.
    expect(headers["content-encoding"]).toBeUndefined();

    const body = await response.body();
    expect(body.byteLength).toBe(bytes);

    // Length alone is a weak assertion: a body re-encoded on the way through can
    // keep its length. The handler hashes what it sent, so this compares the
    // bytes themselves.
    const digest = createHash("sha256").update(body).digest("hex");
    expect(digest).toBe(headers["x-e2e-body-sha256"]);
  });

  test("keeps a small binary body's content type", async ({ request }) => {
    // The large case above could pass while `binaryMediaTypes` was misconfigured,
    // if the failure only showed up as a size limit. This one is small enough
    // that only the type handling is under test.
    const response = await request.get("./api/echo?bytes=1024");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("application/octet-stream");

    const body = await response.body();
    expect(body.byteLength).toBe(1024);
    expect(createHash("sha256").update(body).digest("hex")).toBe(
      response.headers()["x-e2e-body-sha256"],
    );
  });

  test("answers 204 with the app's own headers and no body", async ({
    request,
  }) => {
    const response = await request.get("./api/echo?empty=1");
    expect(response.status()).toBe(204);

    // This is the assertion that matters. When the prelude was lost the status
    // and the headers went with it - the response was a 200 with no `x-e2e-echo`
    // at all - so a status check alone would have caught it, but a body check
    // never would: there is no body either way.
    expect(response.headers()["x-e2e-echo"]).toBe("echo");

    const body = await response.body();
    expect(body.byteLength).toBeLessThanOrEqual(EMPTY_BODY_MAX_BYTES);
  });

  test("passes an unusual status code through unchanged", async ({
    request,
  }) => {
    // Nothing in the path should be normalising statuses it does not recognise.
    const response = await request.get("./api/echo?status=418");
    expect(response.status()).toBe(418);
    expect(response.headers()["x-e2e-echo"]).toBe("echo");
    expect(await response.text()).toContain("status 418");
  });

  test("delivers a chunked stream complete", async ({ request }) => {
    const response = await request.get("./api/echo?stream=1");
    expect(response.status()).toBe(200);

    // A `text/plain` stream, so this is also the only test of the runtime gzipping
    // a *streamed* text body itself - which it has to do, because neither
    // CloudFront nor API Gateway will compress a response whose length is unknown
    // up front. A broken round trip here is mangled bytes, not a status.
    expect(await response.text()).toBe("chunk-1\nchunk-2\nchunk-3\n");

    // A body assembled from three chunks written over ~600ms cannot have had a
    // length declared before the first one went out. If something in the path
    // buffered the whole response, it could - and would.
    expect(response.headers()["content-length"]).toBeUndefined();
  });
});

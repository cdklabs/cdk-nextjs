import { test, expect } from "@playwright/test";
import { isGlobalFunctions } from "./utils/deployment-type";

/**
 * HTTP methods other than GET, and request bodies.
 *
 * Nothing else in either test suite covers these - the Next.js compatibility
 * harness has no green file exercising route handler methods, and the two upstream
 * files that would have are permanently excluded for shipping edge middleware. So
 * this is sole coverage, and it is coverage of the place where the deployment types
 * differ most: a request body is hashed into a SigV4 signature behind CloudFront,
 * arrives base64-encoded through API Gateway, and is a plain stream on a container.
 *
 * What silently breaks: every form POST in the app returning 403, or a body
 * arriving truncated - which looks like an application bug for a long time.
 */
test.describe("request methods", () => {
  const BODY = "hello from the e2e suite";

  /** What `app/api/echo/route.ts` echoes back for a POST or PUT. */
  type EchoedBody = {
    method: string;
    contentType: string | null;
    bodyLength: number;
    bodySha256: string;
  };
  // Computed in the browser below with the same algorithm the handler uses, so a
  // truncated or re-encoded body fails on the hash rather than on the length.
  const EXPECTED_LENGTH = new TextEncoder().encode(BODY).byteLength;

  /**
   * Resolved against `baseURL`, not against the page: `page.goto("./")` on API
   * Gateway lands on `.../prod` after Next.js's `basePath` root redirect
   * (`/prod/` → `/prod`), and a page-relative `api/echo` from there is
   * `/api/echo` — outside the stage, a 403 from API Gateway.
   */
  const echoUrl = (baseURL: string | undefined) =>
    new URL("api/echo", baseURL).href;

  test("accepts a POST with a body sent by the page's own JavaScript", async ({
    page,
    baseURL,
  }) => {
    // This has to be a fetch from inside the page, not `request.post`.
    //
    // Behind CloudFront with Origin Access Control the Function URL verifies a
    // SigV4 signature that covers a hash of the body, and a browser cannot compute
    // one - so `src/nextjs-build/patch-fetch.js` is injected into the client
    // entrypoint chunks to add `x-amz-content-sha256: UNSIGNED-PAYLOAD`. That
    // patch only exists on `NextjsGlobalFunctions`, and only in the app's own
    // bundles. A Playwright `APIRequestContext` never loads them, so it would 403
    // here for a reason that has nothing to do with the product.
    await page.goto("./", { waitUntil: "domcontentloaded" });

    const result = await page.evaluate(
      async ({ url, body }) => {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body,
        });
        return {
          status: response.status,
          json: (await response.json()) as EchoedBody,
        };
      },
      { url: echoUrl(baseURL), body: BODY },
    );

    expect(result.status).toBe(200);
    expect(result.json.method).toBe("POST");
    expect(result.json.bodyLength).toBe(EXPECTED_LENGTH);

    const digest = await page.evaluate(async (body: string) => {
      const bytes = new TextEncoder().encode(body);
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }, BODY);
    expect(result.json.bodySha256).toBe(digest);
  });

  test("accepts a PUT with a body", async ({ page, baseURL }) => {
    // Same path as POST, different method - worth its own case because the edge
    // has to allow the method as well as carry the body. CloudFront's
    // `ALLOW_ALL` methods policy and API Gateway's `ANY` method are two separate
    // decisions, either of which can be narrowed by accident.
    await page.goto("./", { waitUntil: "domcontentloaded" });

    const result = await page.evaluate(
      async ({ url, body }) => {
        const response = await fetch(url, {
          method: "PUT",
          headers: { "content-type": "text/plain" },
          body,
        });
        return {
          status: response.status,
          json: (await response.json()) as EchoedBody,
        };
      },
      { url: echoUrl(baseURL), body: BODY },
    );

    expect(result.status).toBe(200);
    expect(result.json.method).toBe("PUT");
    expect(result.json.bodyLength).toBe(EXPECTED_LENGTH);
  });

  test("rejects an unsigned POST at the edge", async ({ request }) => {
    // The other half of the test above, and the reason it has to be a pair: on
    // its own, the browser POST passing tells you nothing about *why* it passed.
    // This asserts that a client without the `x-amz-content-sha256` header really
    // is refused - so if the fetch patch is ever dropped, the browser test fails
    // and this one keeps working, which localises the break immediately.
    //
    // Only `NextjsGlobalFunctions` signs requests to its origin. The other three
    // accept this POST, which is correct for them.
    test.skip(
      !isGlobalFunctions(),
      "only NextjsGlobalFunctions signs origin requests",
    );

    const response = await request.post("./api/echo", {
      headers: { "content-type": "text/plain" },
      data: BODY,
    });
    expect(response.status()).toBe(403);
  });

  test("answers HEAD on a dynamic route", async ({ request }) => {
    // Deliberately a route handler and not a static asset: API Gateway declares
    // only `GET` on the `_next/static` and `public/` resources, so a HEAD there is
    // a 403 `MissingAuthenticationToken`. That is a known limitation of that
    // deployment type, not a bug, and testing it here would just encode it.
    const response = await request.head("./api/echo");
    expect(response.status()).toBe(200);
    expect(response.headers()["x-e2e-echo"]).toBe("echo");

    // The handler declares the length its GET would have returned. A HEAD is the
    // other empty-body case: the runtime pads it, and the declared length has to
    // survive that padding rather than be replaced by it.
    expect(response.headers()["content-length"]).toBe("42");

    const body = await response.body();
    expect(body.byteLength).toBeLessThanOrEqual(1);
  });

  test("answers HEAD on a page", async ({ request }) => {
    // A HEAD whose GET is a real HTML render, which is where it first went wrong:
    // a HEAD against a 404 page answered `200`, because a zero-payload streamed
    // response lost its prelude and with it the status.
    const response = await request.head("./");
    expect(response.status()).toBe(200);

    const body = await response.body();
    expect(body.byteLength).toBeLessThanOrEqual(1);
  });

  test("answers OPTIONS and DELETE", async ({ request }) => {
    const options = await request.fetch("./api/echo", { method: "OPTIONS" });
    expect(options.status()).toBe(204);
    expect(options.headers()["allow"]).toContain("DELETE");

    const deleted = await request.delete("./api/echo");
    expect(deleted.status()).toBe(204);
    // Both are empty-body responses reached by method rather than by query, so
    // the header is again the only thing there is to assert on.
    expect(deleted.headers()["x-e2e-echo"]).toBe("echo");
  });
});

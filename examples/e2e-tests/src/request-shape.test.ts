import { createHash } from "node:crypto";
import { test, expect } from "@playwright/test";
import {
  isGlobalFunctions,
  isGlobalWebFunctions,
  isLocal,
} from "./utils/deployment-type";

/**
 * What a request looks like when it reaches the app, read back through
 * `app/api/echo/route.ts?request=1`.
 *
 * Two things the front door can get wrong without any status code showing it:
 *
 * - The host. Every absolute URL the app builds (redirects, password-reset
 *   links, `og:url`) starts from it. Behind CloudFront on the Lambda types the
 *   origin sees its own domain as `Host` and the viewer's in
 *   `x-forwarded-host`, which the runtime trusts only on a request Lambda
 *   verified the signature of. Get it wrong one way and links point at the raw
 *   function; the other way and a client picks the host.
 * - `Authorization`. On `NextjsGlobalFunctions` it carries CloudFront's SigV4
 *   signature to the Function URL, so the viewer's never arrives. Everywhere
 *   else it should arrive untouched.
 */
test.describe("request shape", () => {
  /** What `app/api/echo/route.ts` answers for `?request=1`. */
  type DescribedRequest = {
    method: string;
    url: string;
    origin: string;
    authorizationSha256: string | null;
    headerNames: string[];
  };

  const AUTHORIZATION = "Bearer e2e-request-shape";
  const AUTHORIZATION_SHA256 = createHash("sha256")
    .update(AUTHORIZATION)
    .digest("hex");

  /**
   * A fresh query string per call, so no response is ever served from a
   * CloudFront cache; the route also answers `no-store`.
   */
  const describeUrl = (baseURL: string | undefined) =>
    new URL(`api/echo?request=1&n=${Math.random()}`, baseURL).href;

  test("builds absolute URLs from the viewer's host", async ({
    request,
    baseURL,
  }) => {
    const response = await request.get(describeUrl(baseURL));
    expect(response.status()).toBe(200);
    const described = (await response.json()) as DescribedRequest;

    expect(described.origin).toBe(new URL(baseURL ?? "").origin);
  });

  test("ignores a client's x-forwarded-host", async ({ request, baseURL }) => {
    test.skip(isLocal(), "a dev server has no front door to overwrite it");

    const response = await request.get(describeUrl(baseURL), {
      headers: { "x-forwarded-host": "evil.example" },
    });
    expect(response.status()).toBe(200);
    const described = (await response.json()) as DescribedRequest;

    expect(described.origin).toBe(new URL(baseURL ?? "").origin);
  });

  test("passes the viewer's Authorization on a POST", async ({
    request,
    baseURL,
  }) => {
    test.skip(
      isGlobalFunctions(),
      "NextjsGlobalFunctions sends CloudFront's SigV4 signature in Authorization",
    );

    const response = await request.post(describeUrl(baseURL), {
      headers: { authorization: AUTHORIZATION, "content-type": "text/plain" },
      data: "x",
    });
    expect(response.status()).toBe(200);
    const described = (await response.json()) as DescribedRequest;

    expect(described.authorizationSha256).toBe(AUTHORIZATION_SHA256);
  });

  test("passes the viewer's Authorization on a GET", async ({
    request,
    baseURL,
  }) => {
    // CloudFront forwards `Authorization` on a GET to this origin although the
    // header isn't in the cache policy. Measured on a deploy, and pinned here
    // because the README tells users to mark per-user responses `private` on
    // the strength of it.
    test.skip(
      !isGlobalWebFunctions(),
      "measured only on NextjsGlobalWebFunctions",
    );

    const response = await request.get(describeUrl(baseURL), {
      headers: { authorization: AUTHORIZATION },
    });
    expect(response.status()).toBe(200);
    const described = (await response.json()) as DescribedRequest;

    expect(described.authorizationSha256).toBe(AUTHORIZATION_SHA256);
    // Lambda strips the signature Origin Access Control added, so nothing of
    // it reaches the app to be mistaken for the viewer's.
    expect(described.headerNames).not.toContain("x-amz-date");
    expect(described.headerNames).not.toContain("x-amz-security-token");
  });
});

import { test, expect } from "@playwright/test";
import { isGlobalFunctions, isLocal } from "./utils/deployment-type";

/**
 * A repeated slash in a path. Next.js answers one with a 308 to the collapsed
 * path, from `base-server.ts`, and so must every deployment of it.
 *
 * This is the one behaviour in the suite answered by four genuinely different
 * pieces of infrastructure:
 *
 *   NextjsGlobalFunctions    a CloudFront viewer-request function
 *   NextjsGlobalContainers   the origin, through CloudFront
 *   NextjsRegionalContainers the origin, through the ALB
 *   NextjsRegionalFunctions  the origin, through API Gateway
 *
 * The origin-side fix cannot reach the first one. Behind Origin Access Control
 * CloudFront signs the raw path while the Lambda Function URL canonicalizes it
 * before verifying the signature, so the two disagree and the origin answers `403
 * InvalidSignatureException` - measured, not assumed. The collapse therefore
 * happens in a CloudFront function for that type, and that function is otherwise
 * proven only by pulling it out of the synthesized template and running it in a
 * `node:vm`. This is the only thing that runs it on real CloudFront.
 *
 * Two things this cannot test:
 *
 * - The backslash half of the same rule. WHATWG URL parsing rewrites `\` to `/` in
 *   a special-scheme path, so neither a browser nor Playwright's request context
 *   can put one on the wire. It stays covered by `src/runtime/core.test.ts`.
 * - The 308's body. Next.js sends the destination as text; only cloudfront-js-2.0
 *   can return a body on a generated response, and no known client reads it.
 *
 * On `NextjsRegionalFunctions` three cases here were `test.fail`ed against
 * **defect #36** (see `docs/harness-coverage.md`): every redirect lost the stage
 * prefix, because API Gateway strips `/prod` before the Lambda sees the path and
 * only the app's `proxy.ts` put it back, after routing had started. The Lambda
 * shell now hands Next.js the unstripped path for an app whose `basePath` carries
 * the stage (`src/runtime/api-gateway-path.ts`), so the `Location`s come out as
 * `/prod/isr/1`, as they do under `next start` - and the gates are gone.
 */
test.describe("url normalization", () => {
  // Built by string concatenation rather than passed as a relative path: resolving
  // `.//foo` against the base URL would collapse the slashes before the request
  // was ever made, and the test would pass without proving anything.
  function rawUrl(baseURL: string | undefined, path: string) {
    return `${(baseURL ?? "").replace(/\/$/, "")}${path}`;
  }

  /**
   * The path prefix the app is served under - `/prod` on
   * `NextjsRegionalFunctions`, empty on the other three. A redirect that drops it
   * points outside the app.
   */
  function servedUnder(baseURL: string | undefined): string {
    try {
      return new URL(baseURL ?? "").pathname.replace(/\/$/, "");
    } catch {
      return "";
    }
  }

  test("redirects a repeated slash in a path to the collapsed path", async ({
    request,
    baseURL,
  }) => {
    const response = await request.get(rawUrl(baseURL, "/isr//1"), {
      // Observe the redirect instead of following it.
      maxRedirects: 0,
    });

    expect(response.status()).toBe(308);

    const location = response.headers()["location"];
    expect(location).toBeTruthy();
    // Asserted on the tail rather than the whole value because whether the redirect
    // target is absolute or relative is not what is under test.
    expect(location).toContain("/isr/1");
    // The collapse actually happened.
    expect(location).not.toContain("//isr");
    // ...and it landed somewhere still inside the app. This is the assertion that
    // catches defect #36 at the source rather than one request later: the two
    // above pass happily against `Location: /isr/1` on a deployment served at
    // `/prod`, which is a redirect out of the app.
    const prefix = servedUnder(baseURL);
    if (prefix) {
      expect(location).toContain(`${prefix}/isr/1`);
    }
  });

  test("the collapsed target it redirects to is real", async ({
    request,
    baseURL,
  }) => {
    // A 308 to a 404 would satisfy the test above. Following it is what proves the
    // rule is a normalization and not a way to lose a request.
    const response = await request.get(rawUrl(baseURL, "/isr//1"));
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain("<!DOCTYPE html>");
  });

  test("redirects a bare // to the root", async ({ request, baseURL }) => {
    // Worth its own case: `//` at the start of a request target is also the
    // authority form of a URL, so it was not obvious that CloudFront would route
    // it to a function rather than answering it itself. It does - and an earlier
    // probe had shown CloudFront answering a bare `//` with an empty 400, which
    // narrowed down *who* replied but said nothing about why.
    const response = await request.get(rawUrl(baseURL, "//"), {
      maxRedirects: 0,
    });

    expect(response.status()).toBe(308);
    expect(response.headers()["location"]).toBeTruthy();
    expect(response.headers()["location"]).not.toContain("//");
  });

  test("answers at the edge on the deployment type that has to", async ({
    request,
    baseURL,
  }) => {
    test.skip(isLocal(), "no CDN in front of a dev server");
    test.skip(
      !isGlobalFunctions(),
      "only NextjsGlobalFunctions collapses in a CloudFront function",
    );

    const response = await request.get(rawUrl(baseURL, "/isr//1"), {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(308);

    // `FunctionGeneratedResponse` is CloudFront saying the response never reached
    // an origin. This is the assertion that distinguishes "the redirect works" from
    // "the redirect works *and* is produced where it has to be" - the origin cannot
    // produce it at all on this type, so if this ever reads as a cache miss or hit
    // the request is reaching a Function URL that will reject its own signature.
    // A prefix, because CloudFront appends ` from cloudfront` to every `x-cache`.
    expect(response.headers()["x-cache"]).toMatch(
      /^FunctionGeneratedResponse\b/,
    );
  });

  test("keeps every query pair when it redirects", async ({
    request,
    baseURL,
  }) => {
    const response = await request.get(rawUrl(baseURL, "/isr//1?a=1&b=2"), {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(308);

    const location = response.headers()["location"] ?? "";
    // Order-insensitive, because on `NextjsGlobalFunctions` it has to be: a
    // CloudFront viewer-request event exposes `querystring` as an object and never
    // as the raw string, so the function rebuilds it and the order becomes
    // CloudFront's. Every pair surviving is what matters for a redirect target.
    expect(location).toContain("a=1");
    expect(location).toContain("b=2");

    // Everywhere else the origin does the collapse against the raw query string it
    // was given, so the order is the client's and can be asserted exactly. Keeping
    // this half strict is what would catch a rebuild being introduced on a type
    // that has no reason to need one.
    if (!isGlobalFunctions()) {
      expect(location).toContain("?a=1&b=2");
    }
  });
});

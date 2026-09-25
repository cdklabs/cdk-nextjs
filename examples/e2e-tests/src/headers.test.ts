import { test, expect } from "@playwright/test";
import { isCdn } from "./utils/deployment-type";

/**
 * Byte- and header-level assertions on responses, as opposed to status codes.
 *
 * This file exists because of a bug the rest of the suite could not see: a
 * broken `sharp` returned HTTP 200 with the unoptimized original bytes, through
 * four green e2e jobs. Anything asserting only "200 and the right content-type"
 * cannot distinguish "served correctly" from "served by the wrong code path".
 */
/**
 * An ETag produced by reading a file rather than by rendering: S3's MD5 hex
 * digest of a single-part upload, or `send`'s `<size>-<mtime>` pair (both hex).
 * Next.js's page ETag is a single base36-ish run with no dash, so it matches
 * neither alternative.
 */
const FILE_ETAG = /^(W\/)?"([0-9a-f]{32}|[0-9a-f]+-[0-9a-f]+)"$/;

test.describe("response headers", () => {
  /**
   * The ETag *shape* says which subsystem produced the body, so a page
   * accidentally served as a static file - or a static file accidentally
   * rendered - is visible here even though both return 200 with identical
   * content-types.
   *
   * Two shapes are legitimate for a static asset, because which one you get is a
   * property of the deployment type: with a CDN or API Gateway in front, the
   * asset comes from S3 and carries S3's MD5 digest; Regional Containers has
   * nothing in front, so its own server answers off disk and `send` produces a
   * weak `<size>-<mtime>` tag. Next.js's own page ETag is neither.
   */
  test("gives static assets a file ETag and rendered pages a Next.js one", async ({
    page,
    request,
  }) => {
    await page.goto("./", { waitUntil: "networkidle" });
    const chunk = await page.evaluate(() => {
      const script = Array.from(document.querySelectorAll("script[src]")).find(
        (el) => el.getAttribute("src")?.includes("/_next/static/"),
      );
      return script?.getAttribute("src") ?? null;
    });
    expect(chunk).toBeTruthy();

    const asset = await request.get(chunk!);
    expect(asset.status()).toBe(200);
    // The `W/` prefix is not itself meaningful: CloudFront adds it when it
    // compresses an object it got from S3, and `send` always emits weak tags.
    expect(asset.headers()["etag"]).toMatch(FILE_ETAG);

    const isrPage = await request.get("./isr/1");
    expect(isrPage.status()).toBe(200);
    const pageEtag = isrPage.headers()["etag"];
    expect(pageEtag).toBeTruthy();
    expect(pageEtag).not.toMatch(FILE_ETAG);
  });

  /**
   * cdk-nextjs compresses responses in its own server now, where AWS Lambda Web
   * Adapter used to. For the Global types CloudFront could also be the one
   * compressing, so this is end-to-end there and origin-level on the Regional
   * types, which have no CDN in front.
   */
  test("compresses HTML when the client asks for it", async ({ request }) => {
    const response = await request.get("./ssr/1", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-encoding"]).toBe("gzip");
    // Compression must not break the body.
    expect(await response.text()).toContain("<!DOCTYPE html>");
  });

  test("does not compress when the client does not ask", async ({
    request,
  }) => {
    const response = await request.get("./ssr/1", {
      headers: { "accept-encoding": "identity" },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-encoding"]).toBeUndefined();
  });

  /**
   * A 304 has no body, and the response stream has to be ended anyway. Getting
   * that wrong hangs the request until the Lambda or ALB times out rather than
   * failing outright, so the assertion that matters is that it *returns*.
   */
  test("answers a conditional GET with a 304 and does not hang", async ({
    page,
    request,
  }) => {
    await page.goto("./", { waitUntil: "networkidle" });
    const chunk = await page.evaluate(() => {
      const script = Array.from(document.querySelectorAll("script[src]")).find(
        (el) => el.getAttribute("src")?.includes("/_next/static/"),
      );
      return script?.getAttribute("src") ?? null;
    });
    const first = await request.get(chunk!);
    const etag = first.headers()["etag"];
    expect(etag).toBeTruthy();

    const notModified = await request.get(chunk!, {
      headers: { "if-none-match": etag },
      timeout: 15_000,
    });
    expect(notModified.status()).toBe(304);
    expect(await notModified.body()).toHaveLength(0);
  });
});

test.describe("edge caching", () => {
  /**
   * A dynamic response that sends no `Cache-Control` must not be cached at the
   * edge. Next.js sends none from a dynamic route handler, and treats "no header"
   * as "not cacheable" - but the dynamic cache policy used to inherit CDK's
   * one-day default TTL, so every such handler behind CloudFront answered its
   * first caller's response to everyone for 24 hours. Nothing failed: the second
   * caller just got the first caller's body.
   *
   * `?bytes=` is the one `/api/echo` branch whose body differs per request (random
   * bytes, with their hash in `x-e2e-body-sha256`) and that sets no
   * `Cache-Control`, so a cached copy is visible as a repeated hash even if
   * CloudFront ever stops saying so in `x-cache`. A size no other test asks for,
   * so this file owns the cache key. Only the two Global types have a CDN to
   * cache in; the regional ones have nothing between the client and the app.
   */
  test("does not cache a dynamic response that sends no Cache-Control", async ({
    request,
  }) => {
    test.skip(!isCdn(), "only the Global types put CloudFront in front");

    const url = "./api/echo?bytes=48";
    const first = await request.get(url);
    const second = await request.get(url);
    for (const response of [first, second]) {
      expect(response.status()).toBe(200);
      expect(response.headers()["x-e2e-echo"]).toBe("echo");
      // The precondition: if the route ever starts sending a `Cache-Control`,
      // this test is no longer about the policy's default TTL.
      expect(response.headers()["cache-control"]).toBeUndefined();
    }

    expect(second.headers()["x-e2e-body-sha256"]).not.toBe(
      first.headers()["x-e2e-body-sha256"],
    );
    // `Hit from cloudfront` and `RefreshHit from cloudfront` both mean an edge
    // copy answered.
    expect(second.headers()["x-cache"]).not.toMatch(/Hit from cloudfront/);
  });
});

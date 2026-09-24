import { test, expect, Page } from "@playwright/test";

/**
 * A `public/` asset whose filename contains a space.
 *
 * A space is the cheapest character that forces every layer to agree about
 * encoding, and they do not agree by default. It arrives on the wire as `%20`,
 * CloudFront and API Gateway each hand the path to the origin in their own form,
 * and the S3 key it has to become contains a literal space - so `fetchFromS3` has
 * to percent-decode before it builds the key. Serving one asset twice, once
 * directly and once through the image optimizer, exercises both readers of that
 * key: the static-file path and the optimizer's own upstream fetch.
 *
 * What silently breaks: a 404 on any uploaded file whose name has a space, which
 * is most files a non-developer adds to `public/`.
 *
 * Deliberately no HEAD request anywhere in this file. `nextjs-api.ts` declares
 * only `GET` on the `_next/static` and `public/` resources, so a HEAD against an
 * asset is a 403 `MissingAuthenticationToken` on `NextjsRegionalFunctions`. That is
 * a documented limitation of that deployment type; testing it here would only
 * freeze it in place. HEAD is covered against dynamic routes in
 * `request-methods.test.ts`.
 */
test.describe("static assets", () => {
  // Same helper as `image-optimization.test.ts`: read the `w`/`q` the app itself
  // generated rather than guessing a pair, since the optimizer rejects any width
  // outside the configured `deviceSizes`/`imageSizes`.
  async function getOptimizedImageUrl(page: Page, altText: string) {
    const img = page.getByAltText(altText);
    await expect(img).toBeVisible();
    const src = await img.evaluate((el: HTMLImageElement) => el.src);
    return new URL(src);
  }

  test("serves a public/ asset whose name contains a space", async ({
    request,
  }) => {
    const response = await request.get("./static/hello%20e2e.png");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");

    // A non-trivial body, because the failure this guards against is not only a
    // 404: an origin that mis-decodes the key can also answer with an S3 error
    // document, which is a 200 carrying XML.
    const body = await response.body();
    expect(body.byteLength).toBeGreaterThan(1_000);
    // PNG magic bytes. Cheaper than decoding the image and it fails on the XML
    // case above, which `content-type` alone would not.
    expect(body.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  test("optimizes a public/ asset whose name contains a space", async ({
    page,
  }) => {
    await page.goto("./image-optimization", { waitUntil: "networkidle" });
    const url = await getOptimizedImageUrl(page, "Public image");

    // Set the param by hand rather than through `searchParams.set`, which encodes
    // a space as `+`. Both forms work, but `+` would make this a test of two
    // things - whether `+` survives API Gateway's query handling *and* whether the
    // space is decoded into the S3 key. `%20` keeps it about the second.
    url.search = url.search.replace(
      /url=[^&]*/,
      "url=%2Fstatic%2Fhello%20e2e.png",
    );

    const response = await page.request.get(url.toString(), {
      headers: { accept: "image/avif,image/webp,image/apng,*/*" },
    });

    // The optimizer reports a failed upstream fetch as a 400, and reports a
    // *successful* fetch it could not process by returning the original bytes with
    // a 200 - so `image/webp` is the assertion that proves it both found the object
    // and re-encoded it. The source is a PNG and `images.formats` is left at its
    // default of `["image/webp"]`.
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/webp");
  });
});

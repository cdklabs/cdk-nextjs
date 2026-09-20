import { test, expect, Page } from "@playwright/test";

// Reads the browser-resolved `_next/image?url=...&w=...&q=...` request URL
// off a rendered <Image>, so mutations below don't need to hand-construct
// basePath/query-param handling themselves.
async function getOptimizedImageUrl(page: Page, altText: string) {
  const img = page.getByAltText(altText);
  await expect(img).toBeVisible();
  const src = await img.evaluate((el: HTMLImageElement) => el.src);
  return new URL(src);
}

test.describe("image-optimization", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("./image-optimization", { waitUntil: "networkidle" });
  });

  test("should optimize image referenced by public/ string path", async ({
    page,
  }) => {
    const img = page.getByAltText("Public image");
    await expect(img).toBeVisible();
    const naturalWidth = await img.evaluate(
      (el: HTMLImageElement) => el.naturalWidth,
    );
    expect(naturalWidth).toBeGreaterThan(0);
  });

  // regression test for https://github.com/cdklabs/cdk-nextjs/issues/260
  test("should optimize statically imported image", async ({ page }) => {
    const img = page.getByAltText("Imported image");
    await expect(img).toBeVisible();
    const naturalWidth = await img.evaluate(
      (el: HTMLImageElement) => el.naturalWidth,
    );
    expect(naturalWidth).toBeGreaterThan(0);
  });

  test("should optimize image referenced by absolute URL", async ({ page }) => {
    const img = page.getByAltText("Absolute URL image");
    await expect(img).toBeVisible();
    const naturalWidth = await img.evaluate(
      (el: HTMLImageElement) => el.naturalWidth,
    );
    expect(naturalWidth).toBeGreaterThan(0);
  });

  // regression test: the handler's catch block used to always return 500,
  // discarding the real statusCode ImageError attaches (see image-optimizer's
  // "The requested resource isn't a valid image" check).
  test("should return 400 when the referenced local asset isn't an image", async ({
    page,
  }) => {
    const url = await getOptimizedImageUrl(page, "Public image");
    url.searchParams.set("url", "/test.txt");
    const response = await page.request.get(url.toString());
    expect(response.status()).toBe(400);
  });

  // regression test: a missing S3 object used to also surface as a generic
  // 500 instead of the 400 Next.js's own local-image fetch path produces for
  // a missing file (it can't distinguish "missing" from "not a valid image").
  test("should return 400 for a missing local asset", async ({ page }) => {
    const url = await getOptimizedImageUrl(page, "Public image");
    url.searchParams.set("url", "/static/does-not-exist-e2e-test.png");
    const response = await page.request.get(url.toString());
    expect(response.status()).toBe(400);
  });

  test("should set Content-Disposition/CSP headers and a non-empty ETag on the optimized image response", async ({
    page,
  }) => {
    const url = await getOptimizedImageUrl(page, "Public image");
    const response = await page.request.get(url.toString());
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers["content-disposition"]).toContain("attachment");
    expect(headers["content-security-policy"]).toBeTruthy();
    expect(headers["etag"]).toBeTruthy();
  });

  // Note: this covers the general conditional-GET flow, not specifically the
  // fix for the empty upstream ETag on S3-backed BYPASS_TYPES/ANIMATABLE_TYPES
  // (SVG/ICO/animated) assets, since this PNG gets a freshly-computed output
  // ETag regardless of that fix. Exercising that path would need an SVG or
  // animated test asset.
  test("should return 304 when If-None-Match matches the current ETag", async ({
    page,
  }) => {
    const url = await getOptimizedImageUrl(page, "Public image");
    const first = await page.request.get(url.toString());
    expect(first.status()).toBe(200);
    const etag = first.headers()["etag"];
    expect(etag).toBeTruthy();

    const second = await page.request.get(url.toString(), {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(second.status()).toBe(304);
  });
});

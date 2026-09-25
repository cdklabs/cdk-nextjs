import { test, expect, Page } from "@playwright/test";

// Same trick as image-optimization.test.ts: read the browser-resolved
// `_next/image?url=...&w=...&q=...` URL off a rendered <Image> so this test does
// not have to hand-build basePath or the allowed width/quality params.
async function getOptimizedImageUrl(page: Page, altText: string) {
  const img = page.getByAltText(altText);
  await expect(img).toBeVisible();
  const src = await img.evaluate((el: HTMLImageElement) => el.src);
  return new URL(src);
}

test.describe("middleware", () => {
  /**
   * cdk-nextjs serves `_next/image` from its own S3-aware optimizer instead of
   * letting Next.js re-enter the app's request handler. That makes "middleware
   * still runs for image requests" a property of cdk-nextjs's dispatch order,
   * not of Next.js - and one whose failure is invisible, because images keep
   * working. `examples/app-playground/proxy.ts` returns 403 for exactly one
   * image path; nothing else can produce that status here.
   */
  test("runs middleware on _next/image requests", async ({ page }) => {
    await page.goto("./image-optimization", { waitUntil: "networkidle" });
    const url = await getOptimizedImageUrl(page, "Public image");

    // Control: the same behavior, same params, an image middleware ignores.
    const allowed = await page.request.get(url.toString());
    expect(allowed.status()).toBe(200);

    url.searchParams.set("url", "/static/e2e-middleware-image.png");
    const blocked = await page.request.get(url.toString());
    // 403 = middleware ran and short-circuited. 200 = it was bypassed. 400 =
    // it was bypassed and the optimizer could not find the asset.
    expect(blocked.status()).toBe(403);
    expect(await blocked.text()).toBe("blocked by proxy");
  });
});

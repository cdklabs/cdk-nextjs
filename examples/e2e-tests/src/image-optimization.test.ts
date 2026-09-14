import { test, expect } from "@playwright/test";

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
});

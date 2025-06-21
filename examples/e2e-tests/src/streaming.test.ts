import { test, expect } from "@playwright/test";

test.describe("streaming", () => {
  test("should render the page", async ({ page }) => {
    await page.goto("./streaming");
    await expect(
      page.getByRole("heading", { name: "Streaming with Suspense" }),
    ).toBeVisible();
  });

  test("should stream in personalized details", async ({ page }) => {
    await page.goto("./streaming/node/product/1");
    await expect(page.getByText("Recommended Products for You")).toBeVisible();
    // TODO: confirm random name is stable
    const img = page.getByAltText("Donec sit elit").first();
    await expect(img).toHaveJSProperty("complete", true);
    await expect(img).not.toHaveJSProperty("naturalWidth", 0);
  });
});

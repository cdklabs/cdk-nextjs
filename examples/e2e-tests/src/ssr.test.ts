import { test, expect } from "@playwright/test";
import { waitXSec } from "./utils/wait-5-sec";

test.describe("ssr", () => {
  test("should dynamically render at request time", async ({ page }) => {
    await page.goto("./ssr/1", { waitUntil: "networkidle" });
    // Check for very recent render (0-3s ago to account for network/render time)
    const pageText = await page.locator("body").innerText();
    const recentTimePattern = /[0-3]s ago/;
    expect(pageText).toMatch(recentTimePattern);

    await waitXSec(5);
    await page.reload({ waitUntil: "networkidle" });
    // dynamically rendered so should always be recent (0-3s)
    const pageText2 = await page.locator("body").innerText();
    expect(pageText2).toMatch(recentTimePattern);
  });
});

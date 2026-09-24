import { test, expect } from "@playwright/test";
import { waitXSec } from "./utils/wait-5-sec";

test.describe("ssr", () => {
  test("should dynamically render at request time", async ({ page }) => {
    await page.goto("./ssr/1", { waitUntil: "networkidle" });
    // Check for a very recent render. The window covers network + render time,
    // and is wide enough to survive the suite's 4 workers competing for the
    // runner's network - the claim is "rendered for this request", not "rendered
    // in under a second". A cached page would read minutes or hours ago.
    const pageText = await page.locator("body").innerText();
    const recentTimePattern = /[0-5]s ago/;
    expect(pageText).toMatch(recentTimePattern);

    await waitXSec(5);
    await page.reload({ waitUntil: "networkidle" });
    // dynamically rendered so should always be recent
    const pageText2 = await page.locator("body").innerText();
    expect(pageText2).toMatch(recentTimePattern);
  });
});

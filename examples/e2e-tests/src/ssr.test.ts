import { test, expect } from "@playwright/test";
import { getPageTimestamp, getTimestampAge } from "./utils/timestamp-helpers";
import { waitXSec } from "./utils/wait-5-sec";

/** Covers network + render time, with the suite's 4 workers competing. */
const MAX_RENDER_AGE_SEC = 6;

/**
 * Asserted on the render timestamp in the page's `title` attribute, as
 * ssg.test.ts does, not on the "Ns ago" text: `/[0-5]s ago/` also matched
 * "15s ago" through "55s ago", so a page cached for up to a minute passed about
 * a third of the time.
 */
test.describe("ssr", () => {
  test("should dynamically render at request time", async ({ page }) => {
    await page.goto("./ssr/1", { waitUntil: "networkidle" });
    // The claim is "rendered for this request", not "rendered in under a
    // second". A cached page would be minutes or hours old.
    const first = await getPageTimestamp(page);
    const firstAge = getTimestampAge(first);
    expect(firstAge).not.toBeNull();
    expect(firstAge!).toBeLessThan(MAX_RENDER_AGE_SEC);

    await waitXSec(5);
    await page.reload({ waitUntil: "networkidle" });
    // Dynamically rendered, so always recent, and never the first response again.
    const second = await getPageTimestamp(page);
    const secondAge = getTimestampAge(second);
    expect(secondAge).not.toBeNull();
    expect(secondAge!).toBeLessThan(MAX_RENDER_AGE_SEC);
    expect(second).not.toBe(first);
  });
});

import { test, expect } from "@playwright/test";
import { waitXSec } from "./utils/wait-5-sec";
import {
  waitForFreshTimestamp,
  waitForSettledTimestamp,
} from "./utils/wait-for-fresh-timestamp";
import { getPageTimestamp } from "./utils/timestamp-helpers";

test.describe("isr", () => {
  test("should revalidate after 10 seconds", async ({ page, baseURL }) => {
    // no cache in dev mode
    test.skip(baseURL?.includes("localhost") === true);

    // Force a fresh render by revalidating first
    await page.goto("./api/revalidate?collection=collection", {
      waitUntil: "networkidle",
    });

    // Establish a baseline, but only once the revalidation has finished landing:
    // it triggers both a re-render and a CloudFront invalidation, and while
    // either is in flight two identical requests can return different content
    // through no fault of ISR. Everything below compares against this, so it has
    // to be a settled value, not the first thing served.
    await page.goto("./isr/1", { waitUntil: "networkidle" });
    const initialTimestamp = await waitForSettledTimestamp(page);
    expect(initialTimestamp).toBeTruthy();
    console.log(`Initial render timestamp: ${initialTimestamp}`);

    // Immediate reload - should serve cached version (same timestamp)
    await page.reload({ waitUntil: "networkidle" });
    const cachedTimestamp = await getPageTimestamp(page);
    expect(cachedTimestamp).toBe(initialTimestamp);
    console.log(`After immediate reload: ${cachedTimestamp} (same - cached)`);

    // Wait 11 seconds to exceed 10-second revalidation period
    console.log("Waiting 11 seconds for revalidation period to expire...");
    await waitXSec(11);

    // The page should now regenerate. Poll until fresh: stale-while-revalidate
    // serves the old copy at least once, and CloudFront's own copy expires on
    // its own schedule. (Whether that first request is served stale rather than
    // blocking on a re-render is not observable behind a CDN; the unit tests
    // cover it.)
    await page.reload({ waitUntil: "networkidle" });
    const revalidatedTimestamp = await waitForFreshTimestamp(
      page,
      initialTimestamp,
    );

    // Should be a different (newer) timestamp. Not asserting recency here:
    // the timestamp reflects when the server regenerated the content, which
    // can precede this check by longer than any fixed window if CloudFront's
    // edge invalidation propagation was slow to reach this client - the
    // content changing at all is the meaningful signal.
    expect(revalidatedTimestamp).not.toBe(initialTimestamp);
    console.log(`Revalidated page has new timestamp: ${revalidatedTimestamp}`);
  });

  test("should show consistent timestamp during cache period", async ({
    page,
    baseURL,
  }) => {
    // no cache in dev mode
    test.skip(baseURL?.includes("localhost") === true);

    // First visit. Settle first for the same reason as the test above - a
    // revalidation left in flight by another test would otherwise change the
    // content under this one - with a short poll interval so the settled read
    // and the 3s wait below both stay inside one 10s revalidation window.
    await page.goto("./isr/1", { waitUntil: "networkidle" });
    const firstTimestamp = await waitForSettledTimestamp(page, {
      intervalMs: 1_000,
    });
    expect(firstTimestamp).toBeTruthy();
    console.log(`First visit timestamp: ${firstTimestamp}`);

    // Wait 3 seconds (within 10s cache period)
    await waitXSec(3);

    // Should still show same cached timestamp
    await page.reload({ waitUntil: "networkidle" });
    const secondTimestamp = await getPageTimestamp(page);
    expect(secondTimestamp).toBe(firstTimestamp);
    console.log(
      `After 3s reload: ${secondTimestamp} (same - within cache period)`,
    );
  });
});

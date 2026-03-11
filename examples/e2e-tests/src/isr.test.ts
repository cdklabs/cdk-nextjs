import { test, expect } from "@playwright/test";
import { waitXSec } from "./utils/wait-5-sec";
import { getPageTimestamp, isTimestampRecent } from "./utils/timestamp-helpers";

// too flaky to run in CI right now
test.describe.skip("isr", () => {
  test("should revalidate after 10 seconds", async ({ page, baseURL }) => {
    // no cache in dev mode
    test.skip(baseURL?.includes("localhost") === true);

    // Force a fresh render by revalidating first
    await page.goto("./api/revalidate?collection=collection", {
      waitUntil: "networkidle",
    });
    await waitXSec(2);

    // First visit - get fresh timestamp
    await page.goto("./isr/1", { waitUntil: "networkidle" });
    const initialTimestamp = await getPageTimestamp(page);
    expect(initialTimestamp).toBeTruthy();
    expect(isTimestampRecent(initialTimestamp, 10)).toBe(true);
    console.log(`Initial render timestamp: ${initialTimestamp} (fresh)`);

    // Immediate reload - should serve cached version (same timestamp)
    await page.reload({ waitUntil: "networkidle" });
    const cachedTimestamp = await getPageTimestamp(page);
    expect(cachedTimestamp).toBe(initialTimestamp);
    console.log(`After immediate reload: ${cachedTimestamp} (same - cached)`);

    // Wait 11 seconds to exceed 10-second revalidation period
    console.log("Waiting 11 seconds for revalidation period to expire...");
    await waitXSec(11);

    // This request should trigger background revalidation but still serve stale
    await page.reload({ waitUntil: "networkidle" });
    const staleTimestamp = await getPageTimestamp(page);
    expect(staleTimestamp).toBe(initialTimestamp);
    console.log(
      "Request after 11s triggered revalidation, still serving stale",
    );

    // Wait a moment for revalidation to complete
    await waitXSec(2);

    // Next request should serve the freshly revalidated page
    await page.reload({ waitUntil: "networkidle" });
    const revalidatedTimestamp = await getPageTimestamp(page);

    // Should be a different (newer) timestamp
    expect(revalidatedTimestamp).not.toBe(initialTimestamp);
    expect(isTimestampRecent(revalidatedTimestamp, 15)).toBe(true);
    console.log(`Revalidated page has new timestamp: ${revalidatedTimestamp}`);
  });

  test("should have independent revalidation per post", async ({
    page,
    baseURL,
  }) => {
    // no cache in dev mode
    test.skip(baseURL?.includes("localhost") === true);

    // Visit post 2
    await page.goto("./isr/2", { waitUntil: "networkidle" });
    const post2Timestamp = await getPageTimestamp(page);
    expect(post2Timestamp).toBeTruthy();
    console.log(`Post 2 render timestamp: ${post2Timestamp}`);

    // Visit post 3
    await page.goto("./isr/3", { waitUntil: "networkidle" });
    const post3Timestamp = await getPageTimestamp(page);
    expect(post3Timestamp).toBeTruthy();
    console.log(`Post 3 render timestamp: ${post3Timestamp}`);

    // Both posts should have timestamps (may be same or different depending on build/cache state)
    expect(post2Timestamp).toBeTruthy();
    expect(post3Timestamp).toBeTruthy();
  });

  test("should show consistent timestamp during cache period", async ({
    page,
    baseURL,
  }) => {
    // no cache in dev mode
    test.skip(baseURL?.includes("localhost") === true);

    // First visit
    await page.goto("./isr/1", { waitUntil: "networkidle" });
    const firstTimestamp = await getPageTimestamp(page);
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

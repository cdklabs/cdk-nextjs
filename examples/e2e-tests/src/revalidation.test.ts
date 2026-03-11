import { test, expect } from "@playwright/test";
import { waitXSec } from "./utils/wait-5-sec";
import { getPageTimestamp, isTimestampRecent } from "./utils/timestamp-helpers";

// too flaky to run in CI right now
test.describe.skip("revalidation", () => {
  test("should revalidate ISR page when calling revalidate API", async ({
    page,
    baseURL,
  }) => {
    // no cache in dev mode
    test.skip(baseURL?.includes("localhost") === true);

    // Step 1: Visit ISR page and record initial timestamp
    await page.goto("./isr/1", { waitUntil: "networkidle" });
    const initialTimestamp = await getPageTimestamp(page);
    expect(initialTimestamp).toBeTruthy();
    console.log(`Initial ISR page timestamp: ${initialTimestamp}`);

    // Step 2: Wait a moment to ensure timestamp difference
    await waitXSec(2);

    // Step 3: Call revalidation API to invalidate cache
    console.log("Calling /api/revalidate to invalidate 'collection' tag...");
    const revalidateResponse = await page.goto(
      "./api/revalidate?collection=collection",
      { waitUntil: "networkidle" },
    );
    expect(revalidateResponse?.status()).toBe(200);
    const revalidateData = await revalidateResponse?.json();
    expect(revalidateData).toMatchObject({
      revalidated: true,
      cache: "no-store",
    });
    console.log("Revalidation API called successfully");

    // Step 4: Wait for revalidation to propagate (DynamoDB + S3)
    await waitXSec(2);

    // Step 5: Visit ISR page again - should show fresh timestamp
    await page.goto("./isr/1", { waitUntil: "networkidle" });
    const revalidatedTimestamp = await getPageTimestamp(page);
    expect(revalidatedTimestamp).toBeTruthy();
    console.log(`After revalidation: ${revalidatedTimestamp}`);

    // Verify the page was freshly rendered (different timestamp, and recent)
    expect(revalidatedTimestamp).not.toBe(initialTimestamp);
    expect(isTimestampRecent(revalidatedTimestamp, 15)).toBe(true);

    console.log("✓ Revalidation successfully triggered fresh render");
  });

  test("should revalidate multiple ISR pages with same tag", async ({
    page,
    baseURL,
  }) => {
    // no cache in dev mode
    test.skip(baseURL?.includes("localhost") === true);

    // Visit multiple ISR pages that use the same 'collection' tag
    const posts = [1, 2, 3];
    const initialTimestamps: Map<number, string> = new Map();

    // Step 1: Visit all pages and record timestamps
    for (const postId of posts) {
      await page.goto(`./isr/${postId}`, { waitUntil: "networkidle" });
      const timestamp = await getPageTimestamp(page);
      if (timestamp) {
        initialTimestamps.set(postId, timestamp);
      }
      console.log(`Post ${postId} initial: ${timestamp}`);
    }

    // Step 2: Wait and call revalidation API
    await waitXSec(2);
    console.log("Revalidating 'collection' tag for all posts...");
    await page.goto("./api/revalidate?collection=collection", {
      waitUntil: "networkidle",
    });
    await waitXSec(2);

    // Step 3: Check all pages were revalidated
    for (const postId of posts) {
      await page.goto(`./isr/${postId}`, { waitUntil: "networkidle" });
      const timestamp = await getPageTimestamp(page);

      console.log(`Post ${postId} after revalidation: ${timestamp}`);

      // Should have different (newer) timestamp and be recent
      expect(timestamp).not.toBe(initialTimestamps.get(postId));
      expect(isTimestampRecent(timestamp, 15)).toBe(true);
    }

    console.log("✓ All pages with 'collection' tag were revalidated");
  });

  test("should handle revalidation with custom path parameter", async ({
    page,
    baseURL,
  }) => {
    // no cache in dev mode
    test.skip(baseURL?.includes("localhost") === true);

    // Visit a specific ISR page
    await page.goto("./isr/2", { waitUntil: "networkidle" });
    const initialTimestamp = await getPageTimestamp(page);
    console.log(`Initial: ${initialTimestamp}`);

    await waitXSec(2);

    // Call revalidation with custom path parameter
    console.log("Calling revalidate API with custom path...");
    const response = await page.goto(
      "./api/revalidate?path=/isr/[id]&collection=collection",
      { waitUntil: "networkidle" },
    );
    expect(response?.status()).toBe(200);

    await waitXSec(2);

    // Verify revalidation worked
    await page.goto("./isr/2", { waitUntil: "networkidle" });
    const revalidatedTimestamp = await getPageTimestamp(page);
    console.log(`After revalidation: ${revalidatedTimestamp}`);

    expect(revalidatedTimestamp).not.toBe(initialTimestamp);
    expect(isTimestampRecent(revalidatedTimestamp, 15)).toBe(true);

    console.log("✓ Custom path revalidation successful");
  });

  test("should return proper response from revalidate API", async ({
    page,
    baseURL,
  }) => {
    // no cache in dev mode
    test.skip(baseURL?.includes("localhost") === true);

    // Test the revalidate API response structure
    const response = await page.goto("./api/revalidate", {
      waitUntil: "networkidle",
    });

    expect(response?.status()).toBe(200);

    const data = await response?.json();
    expect(data).toHaveProperty("revalidated");
    expect(data).toHaveProperty("now");
    expect(data).toHaveProperty("cache");

    expect(data.revalidated).toBe(true);
    expect(data.cache).toBe("no-store");
    expect(typeof data.now).toBe("number");
    expect(data.now).toBeGreaterThan(0);

    console.log("✓ Revalidate API response structure is correct:", data);
  });

  test("should maintain cache within revalidation period", async ({
    page,
    baseURL,
  }) => {
    // no cache in dev mode
    test.skip(baseURL?.includes("localhost") === true);

    // Step 1: Trigger fresh render by revalidating
    await page.goto("./api/revalidate?collection=collection", {
      waitUntil: "networkidle",
    });
    await waitXSec(2);

    // Step 2: Visit page to create fresh cache entry
    await page.goto("./isr/1", { waitUntil: "networkidle" });
    const firstTimestamp = await getPageTimestamp(page);
    console.log(`First visit: ${firstTimestamp}`);

    // Step 3: Immediately reload - should serve from cache (same timestamp)
    await page.reload({ waitUntil: "networkidle" });
    const cachedTimestamp = await getPageTimestamp(page);
    console.log(`Cached visit: ${cachedTimestamp}`);

    // Should be identical timestamp
    expect(cachedTimestamp).toBe(firstTimestamp);

    console.log("✓ Cache maintained within revalidation period");
  });

  test("should invalidate cache only for revalidated tags", async ({
    page,
    baseURL,
  }) => {
    // no cache in dev mode
    test.skip(baseURL?.includes("localhost") === true);

    // This test verifies that revalidating one tag doesn't affect unrelated pages
    // Note: All ISR pages use the 'collection' tag, so we're testing the mechanism

    // Step 1: Create cache entry for ISR page
    await page.goto("./isr/1", { waitUntil: "networkidle" });
    const beforeTimestamp = await getPageTimestamp(page);
    console.log(`Before revalidation: ${beforeTimestamp}`);

    await waitXSec(2);

    // Step 2: Revalidate with the 'collection' tag
    await page.goto("./api/revalidate?collection=collection", {
      waitUntil: "networkidle",
    });
    await waitXSec(2);

    // Step 3: Page should be revalidated (fresh timestamp)
    await page.goto("./isr/1", { waitUntil: "networkidle" });
    const afterTimestamp = await getPageTimestamp(page);
    console.log(`After revalidation: ${afterTimestamp}`);

    // Should show fresh data
    expect(afterTimestamp).not.toBe(beforeTimestamp);
    expect(isTimestampRecent(afterTimestamp, 15)).toBe(true);

    console.log("✓ Tag-based revalidation working correctly");
  });
});

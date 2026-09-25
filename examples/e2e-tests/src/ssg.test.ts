import { test, expect } from "@playwright/test";
import { getPageTimestamp, getTimestampAge } from "./utils/timestamp-helpers";
import { waitXSec } from "./utils/wait-5-sec";

/**
 * Asserted on the render timestamp the page carries in its `title` attribute,
 * not on the "Ns ago" text. The text is relative, ticks client-side, and
 * `/[0-2]s ago/` also matched "12s ago" and "20s ago", which is what made the
 * on-demand case flake.
 */
test.describe("ssg", () => {
  test("should statically render post 1 at build time", async ({
    page,
    baseURL,
  }) => {
    // no cache in dev mode
    test.skip(baseURL?.includes("localhost") === true);
    await waitXSec(5);
    await page.goto("./ssg/1", { waitUntil: "networkidle" });
    // Rendered by `next build`, so at least the 5 seconds just waited old.
    const age = getTimestampAge(await getPageTimestamp(page));
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(5);
  });

  test("should statically render post 3 on demand", async ({
    page,
    baseURL,
  }) => {
    // no cache in dev mode
    test.skip(baseURL?.includes("localhost") === true);

    // A random post between 3 and 99 (on-demand posts; 100 is `notFound()`),
    // retried until one comes back freshly rendered: an earlier run against the
    // same deployment may already have rendered the one picked.
    let firstTimestamp: string | null = null;
    for (let attempt = 1; attempt <= 10; attempt++) {
      const post = Math.floor(Math.random() * (99 - 3 + 1)) + 3;
      await page.goto(`./ssg/${post}`, { waitUntil: "networkidle" });
      const timestamp = await getPageTimestamp(page);
      // Generous, since it includes the render, the network, and clock skew
      // between the runner and the compute.
      if ((getTimestampAge(timestamp) ?? Infinity) < 10) {
        firstTimestamp = timestamp;
        break;
      }
      console.log(
        `Post ${post} was not freshly rendered (${timestamp}). Attempt: ${attempt}`,
      );
    }
    expect(firstTimestamp).not.toBeNull();

    // The cached render is served again, not re-rendered: the page's cache
    // entry persisted between requests.
    await waitXSec(5);
    await page.reload({ waitUntil: "networkidle" });
    expect(await getPageTimestamp(page)).toBe(firstTimestamp);
  });
});

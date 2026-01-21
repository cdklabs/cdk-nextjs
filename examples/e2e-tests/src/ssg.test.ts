import { test, expect } from "@playwright/test";
import { waitXSec } from "./utils/wait-5-sec";

test.describe("ssg", () => {
  test("should statically render post 1 at build time", async ({
    page,
    baseURL,
  }) => {
    // no cache in dev mode
    test.skip(baseURL?.includes("localhost") === true);
    await waitXSec(5);
    await page.goto("./ssg/1", { waitUntil: "networkidle" });
    // should be at least "5s ago". will be more if built longer ago.
    // Use regex to match any time that's NOT 0-2 seconds (allowing for slight timing variance)
    const recentTimePattern = /[0-2]s ago/;
    const pageContent = await page.content();
    const hasRecentTime = recentTimePattern.test(pageContent);
    expect(hasRecentTime).toBe(false);
  });

  test("should statically render post 3 on demand", async ({
    page,
    baseURL,
  }) => {
    // no cache in dev mode
    test.skip(baseURL?.includes("localhost") === true);
    await waitXSec(5);
    let count = 1;
    let dateChip0sCount = 0;
    let randomPost = 0;

    do {
      // random post between 3 - 100 (on demand posts)
      randomPost = Math.floor(Math.random() * (100 - 3 + 1)) + 3;
      await page.goto(`./ssg/${randomPost}`, { waitUntil: "networkidle" });
      // Check for very recent render (0-2s ago to account for network latency)
      const pageContent = await page.content();
      const recentTimePattern = /[0-2]s ago/;
      dateChip0sCount = recentTimePattern.test(pageContent) ? 1 : 0;

      if (dateChip0sCount === 0) {
        console.log(
          `Recent time (0-2s ago) not found for post ${randomPost}. Trying again. Attempt: ${count}`,
        );
      }
      count++;
    } while (dateChip0sCount === 0 && count <= 10);

    // tests that static on-demand rendered post was just rendered
    expect(dateChip0sCount).toBeGreaterThan(0);

    await waitXSec(5);
    await page.reload({ waitUntil: "networkidle" });

    // tests that .html,.rsc,.meta files are successfully cached in EFS and persist between renders
    // After reload, the cached version should show a timestamp that's NOT recent (at least 5s+)
    const pageContent2 = await page.content();
    const recentTimePattern = /[0-2]s ago/;
    const hasRecentTime = recentTimePattern.test(pageContent2);
    expect(hasRecentTime).toBe(false);
  });
});

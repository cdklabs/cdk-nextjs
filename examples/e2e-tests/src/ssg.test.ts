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
    await page.goto("./ssg/1");
    // should be at least "5s ago". will be more if built longer ago.
    const dateChip0sCount = await page.getByText("0s ago").count();
    expect(dateChip0sCount).toBe(0);
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
      await page.goto(`./ssg/${randomPost}`);
      dateChip0sCount = await page.getByText("0s ago").count();

      if (dateChip0sCount === 0) {
        console.log(
          `'0s ago' date chip not found for post ${randomPost}. Trying again. Attempt: ${count}`,
        );
      }
      count++;
    } while (dateChip0sCount === 0 && count <= 10);

    // tests that static on-demand rendered post was just rendered
    expect(dateChip0sCount).toBeGreaterThan(0);

    await waitXSec(5);
    await page.reload();

    // tests that .html,.rsc,.meta files are successfully cached in EFS and persist between renders
    const dateChip0sCount2 = await page.getByText("0s ago").count();
    expect(dateChip0sCount2).toBe(0);
  });
});

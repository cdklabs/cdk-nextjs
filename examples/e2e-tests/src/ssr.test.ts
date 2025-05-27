import { test, expect } from "@playwright/test";
import { waitXSec } from "./utils/wait-5-sec";

test.describe("ssr", () => {
  test("should dynamically render at request time", async ({ page }) => {
    await page.goto("/ssr/1");
    expect(page.getByText("0s ago")).toBeVisible();
    await waitXSec(5);
    await page.reload();
    // dynamically rendered so should always be "0 sec"
    const dateChip0sCount2 = await page.getByText("0s ago").count();
    expect(dateChip0sCount2).toBe(1);
  });
});

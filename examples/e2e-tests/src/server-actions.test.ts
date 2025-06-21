import { test, expect } from "@playwright/test";

test.describe("server-actions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("./server-actions");
  });

  test("form should successfully submit", async ({ page }) => {
    await page.getByLabel("Name for Action Input").fill("John Doe");
    await page.getByRole("button", { name: "Submit for Action Form" }).click();
    await page.waitForLoadState("networkidle");
    const successMessageCount = await page
      .getByText("Action Form Success")
      .count();
    expect(successMessageCount).toBe(1);
  });

  test("form with event handler should successfully submit", async ({
    page,
  }) => {
    await page.getByLabel("Name for Event Handler Input").fill("John Doe");
    await page
      .getByRole("button", { name: "Submit for Event Handler Form" })
      .click();
    await page.waitForLoadState("networkidle");
    const successMessageCount = await page
      .getByText("Event Handler Form Success")
      .count();
    expect(successMessageCount).toBe(1);
  });
});

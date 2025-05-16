import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./src",
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env["CI"],
  /* Retry on CI only */
  retries: process.env["CI"] ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env["CI"] ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: "html",
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: process.env["E2E_BASE_URL"],

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "on-first-retry",
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: "App Playground",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium", // https://playwright.dev/docs/browsers#chromium-new-headless-mode
      },
    },
  ],
});

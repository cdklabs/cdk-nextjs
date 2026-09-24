import { defineConfig, devices } from "@playwright/test";

/**
 * The two specs that mutate shared cache state, and so cannot run alongside each
 * other or alongside a second copy of themselves.
 *
 * `cacheTag('collection')` exists in exactly one route - `app/isr/[id]/page.tsx` -
 * and `/api/revalidate` only ever touches that tag plus
 * `revalidatePath('/isr/[id]')`. `app/ssg/[id]`'s `'use cache'` carries no tag, so
 * nothing else in the app is reachable from a revalidation these two trigger. That
 * is why the serial lane is these two files and not the whole suite.
 */
const SERIAL_SPECS = /(isr|revalidation)\.test\.ts/;

const browser = {
  ...devices["Desktop Chrome"],
  channel: "chromium" as const, // https://playwright.dev/docs/browsers#chromium-new-headless-mode
};

export default defineConfig({
  testDir: "./src",
  /* Some isr/revalidation assertions poll for CDN invalidation / cross-instance
   * cache eviction, which are eventually consistent with no fixed completion
   * time - give them headroom beyond the default 30s. */
  timeout: 120_000,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env["CI"],
  /* Retry on CI only */
  retries: process.env["CI"] ? 2 : 0,
  /* Every runner in e2e-tests.yml is a 4-vCPU ubuntu-latest and these tests are
   * network-bound, not CPU-bound. This used to be 1 to keep the cache-mutating
   * specs from evicting each other's entries mid-assertion; the `serial` project
   * below now does that on its own, for those two files only. */
  workers: process.env["CI"] ? 4 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: "html",
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: process.env["E2E_BASE_URL"],

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "on-first-retry",

    /* Set cookies for all requests */
    extraHTTPHeaders: {
      // only required for rgnl-containers example to comply with security
      Cookie: "cdk-nextjs=1",
    },
  },

  projects: [
    {
      name: "parallel",
      testIgnore: SERIAL_SPECS,
      fullyParallel: true,
      use: browser,
    },
    {
      name: "serial",
      testMatch: SERIAL_SPECS,
      /* Orders the tests *within* each file. */
      fullyParallel: false,
      /* And this orders the files against each other: `workers` is honoured
       * per-project (Playwright >= 1.52), so these two share one worker while the
       * `parallel` project uses the rest of the pool. Without it, `fullyParallel:
       * false` alone would still let the two files run concurrently. */
      workers: 1,
      use: browser,
    },
  ],
});

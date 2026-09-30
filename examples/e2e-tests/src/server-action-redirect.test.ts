import { test, expect } from "@playwright/test";

/**
 * A server action whose entire result is a redirect.
 *
 * One test, because it is one very specific shape: an action that returns nothing
 * answers with a zero-payload RSC response whose only meaningful content is the
 * `x-action-redirect` header the router navigates on. A Lambda Function URL
 * discarded the prelude of a zero-payload stream, so the header vanished, the
 * client got a bare 200, and the form simply did nothing - no error in the browser,
 * nothing in a log, and the page still sitting there. `padEmptyBody` in the
 * runtime's sink exists for exactly this.
 *
 * `server-actions.test.ts` already covers actions that return data, which is the
 * case that cannot lose its prelude because it has a body. This is the other one.
 *
 * Upstream's densest server-action coverage
 * (`app-dir/actions/app-action.test.ts`) is permanently excluded from the Next.js
 * compatibility harness because its fixture ships legacy edge middleware, so
 * nothing else reaches this.
 *
 * The hydration wait below is load-bearing, and finding out why cost a measurement
 * worth recording. An action reached through the *router* answers `200` +
 * `x-action-redirect: /server-actions/redirect/done;push`, and the router adds the
 * app's `basePath` client-side. A `<form>` submitted *before hydration* is a native
 * browser POST instead, which Next.js answers with a `303` whose `Location` carries
 * no `basePath` - so the browser resolves it against the origin, and on
 * `NextjsRegionalFunctions` (served under `/prod`) it lands outside the app and gets
 * a `403` from API Gateway. That made this test intermittent there, 2 of 3 runs
 * passing, which looked exactly like a deployment defect.
 *
 * It is not one: plain `next start` with the same `basePath` answers that same
 * pre-hydration POST with the same prefix-less `303`, and the follow-up is a `404`.
 * Upstream behaviour, identical on every type, so it is not asserted here - only
 * the hydrated path is, and clicking after hydration is what makes it the path
 * under test rather than a race.
 */
test.describe("server action redirect", () => {
  test("navigates to the action's redirect target", async ({ page }) => {
    await page.goto("./server-actions/redirect", {
      waitUntil: "domcontentloaded",
    });

    // Not `domcontentloaded`: that fires with the form present and unhydrated, and
    // a click then submits it natively (see above). Waiting for the client router
    // is what guarantees the action goes through it.
    await page.waitForFunction(
      () =>
        !!(window as unknown as { next?: { router?: unknown } }).next?.router,
    );

    await page.getByRole("button", { name: "Redirect via action" }).click();

    // The target page's own marker, not the URL: the router updates the URL before
    // the destination has rendered, so a URL assertion can pass against a
    // navigation that then fails. Reaching this element means the redirect header
    // survived *and* the payload for the target arrived.
    await expect(page.getByTestId("redirect-done")).toHaveText("redirect:done");
  });
});

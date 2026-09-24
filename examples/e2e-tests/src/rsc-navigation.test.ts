import { test, expect } from "@playwright/test";

/**
 * The React Server Component payload - the wire format every client-side
 * navigation in an App Router app rides on.
 *
 * Three separate defects lived here, and they share a property that makes them
 * expensive: a broken RSC response never breaks a *fresh page load*, so the app
 * looks completely healthy until someone clicks a link. Then the router receives
 * something it cannot parse and either hard-navigates (slow but invisible) or
 * throws in the console.
 *
 * - The payload for `/` is built to `/index.rsc`, not `/.rsc`, so a naive
 *   `pathname + '.rsc'` 404s on the home page and nowhere else.
 * - A payload served as `text/html` instead of `text/x-component` is fetched
 *   successfully and then parsed as a document.
 * - A duplicated `vary` makes a CDN key the response on the wrong axis, so a
 *   cached RSC payload gets served to a request that wanted HTML.
 *
 * Next.js 16 requires the bare `?_rsc` query marker alongside the `RSC` header and
 * answers a request with only the header with a 307 that adds it - which is why the
 * marker is spelled out below rather than left off. That the value is empty is also
 * deliberate: `?_rsc=anything` is redirected too.
 */
test.describe("rsc navigation", () => {
  // `./?_rsc` and `./isr/1?_rsc`. The home page is the case that carries the
  // `/index.rsc` bug; `isr/1` is a dynamic route reaching entirely different code
  // in the cache handler, so both are worth asking.
  for (const { label, path } of [
    { label: "the home page", path: "./?_rsc" },
    { label: "a dynamic route", path: "./isr/1?_rsc" },
  ]) {
    test(`serves the RSC payload for ${label}`, async ({ request }) => {
      const response = await request.get(path, {
        headers: { RSC: "1" },
        // A 307 here would mean the marker convention changed; following it would
        // hide that behind a passing test.
        maxRedirects: 0,
      });

      expect(response.status()).toBe(200);

      // `text/x-component`, not `text/html`. This is the assertion the router
      // itself effectively makes, and the one that used to fail.
      expect(response.headers()["content-type"]).toContain("text/x-component");

      const body = await response.text();
      // A flight payload is a sequence of `<id>:<data>` rows. Asserting the shape
      // rather than a length catches the case where an HTML error page arrives
      // with the right content type - which a byte count would pass.
      //
      // Row ids are hex, not decimal, and the first row of a *prerendered* payload
      // carries a `#` prefix: `.next/server/app/index.rsc` literally begins
      // `#1:"$Sreact.fragment"`. Both halves of that are Next.js's format rather
      // than anything a deployment does - a stricter `/^\d+:/` failed identically
      // against plain `next start` on the same build.
      expect(body).toMatch(/^#?[0-9a-f]+:/);
      expect(body).not.toContain("<!DOCTYPE");

      // Exactly one `vary`, read off the raw header list because `headers()`
      // would fold two into one comma-joined string and the assertion would pass
      // against the bug. Two `vary` headers is not a syntax error - it is a
      // correctness problem only at a CDN, which is the one place it is never
      // observed in development.
      const varyHeaders = response
        .headersArray()
        .filter((h) => h.name.toLowerCase() === "vary");
      expect(varyHeaders).toHaveLength(1);
      expect(varyHeaders[0]?.value.toLowerCase()).toContain("rsc");
    });
  }

  test("navigates client-side without a full page load", async ({ page }) => {
    // The end-to-end version of the two tests above, and the only one that proves
    // the payload is *usable* rather than merely well-formed. A sentinel on
    // `window` survives a client-side navigation and is destroyed by a document
    // load, so it distinguishes the router consuming the RSC response from the
    // router giving up and hard-navigating - which is otherwise invisible.
    await page.goto("./isr/1", { waitUntil: "networkidle" });

    // Wait for the client router to exist before clicking. Without this the test is
    // flaky under worker contention for a reason that has nothing to do with the
    // product: a click on a not-yet-hydrated `<Link>` is handled by the browser as
    // a plain anchor, which is a full page load, which fails the assertion below.
    await page.waitForFunction(
      () =>
        !!(window as unknown as { next?: { router?: unknown } }).next?.router,
    );

    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>)["__e2eSentinel"] = "kept";
    });

    // Back to the home page specifically, because `/` is the route whose payload
    // lives at `/index.rsc`. The nav link carries `prefetch={false}`, so the RSC
    // request really happens on the click rather than having been warmed already.
    await page.getByRole("link", { name: "App Router" }).click();

    // Waited on the home page's own heading rather than on the URL: the URL is
    // `/prod` on `NextjsRegionalFunctions` and `/` everywhere else, and the router
    // updates it before the payload has been applied either way.
    await expect(
      page.getByRole("heading", { name: "Examples", level: 1 }),
    ).toBeVisible();

    const sentinel = await page.evaluate(
      () => (window as unknown as Record<string, unknown>)["__e2eSentinel"],
    );
    expect(sentinel).toBe("kept");
  });
});

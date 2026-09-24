import { test, expect } from "@playwright/test";

/**
 * Partial Prerendering. The app sets `cacheComponents: true` (what Next.js 16.3
 * merged `experimental.ppr` into), so routes with a `<Suspense>` boundary around
 * their request-dependent parts are built as a static shell plus a streamed
 * remainder.
 *
 * What makes this worth testing through cdk-nextjs rather than trusting Next.js:
 * the shell is a build artifact the adapter has to seed into the cache, and the
 * streamed remainder is a second render the server has to resume and flush
 * through CloudFront, API Gateway, or an ALB without any of them buffering the
 * whole response first. A deployment can serve a route "correctly" and still have
 * lost PPR, by blocking on the dynamic part before sending a byte.
 */
test.describe("ppr", () => {
  test("streams the shell before the request-dependent part", async ({
    page,
    request,
    baseURL,
  }) => {
    // Dev mode renders everything per request - there is no prerendered shell to
    // arrive first.
    test.skip(baseURL?.includes("localhost") === true);

    const response = await request.get("./patterns/search-params?sort=desc");
    expect(response.status()).toBe(200);

    const html = await response.text();

    // The static shell: this copy is in the page body, outside every boundary.
    const shellIndex = html.indexOf("The <code>useSearchParams</code> hook");
    expect(shellIndex).toBeGreaterThan(-1);

    // The dynamic part: the server-rendered links only exist once `searchParams`
    // has been read, which cannot happen until there is a request. `ServerLinks`
    // builds each link's query string from the request's own params, so this
    // marker carries the `sort=desc` above - something a shell prerendered
    // without a request cannot contain, and something `ServerLinksFallback`
    // could not produce anyway because it renders plain `<div>`s with no hrefs.
    //
    // Not an `options` label like "Items Per Page": those are rendered by
    // `ServerLinks` *and* `ServerLinksFallback`, so `indexOf` resolved against
    // the fallback copy sitting in the shell and the ordering assertion below
    // held no matter what - passing even if the resume never ran, which is the
    // one regression this test exists to catch.
    //
    // Written without an `&`, which React escapes to `&amp;` in an attribute.
    const dynamicIndex = html.indexOf("?sort=desc");
    expect(dynamicIndex).toBeGreaterThan(-1);

    // Order in the byte stream is the assertion. Both halves being present only
    // proves the page rendered; the shell being *first* is what proves it was
    // prerendered and the rest resumed onto it.
    expect(shellIndex).toBeLessThan(dynamicIndex);

    // And the streamed half really is per-request.
    await page.goto("./patterns/search-params?sort=desc", {
      waitUntil: "networkidle",
    });
    await expect(
      page.getByRole("link", { name: "desc", exact: true }),
    ).toHaveClass(/bg-vercel-blue/);
  });

  test("serves the same shell for a param the build never saw", async ({
    request,
    baseURL,
  }) => {
    test.skip(baseURL?.includes("localhost") === true);

    // `/layouts/[categorySlug]` has no `generateStaticParams`, so nothing about
    // these two URLs was rendered at build time except the one shell they share.
    // Both still have to resolve their category, which is what the cached
    // `getCategory()` behind the boundary does.
    const electronics = await request.get("./layouts/electronics");
    const clothing = await request.get("./layouts/clothing");

    expect(electronics.status()).toBe(200);
    expect(clothing.status()).toBe(200);

    // `x-nextjs-postponed: 1` says the response started from a prerendered shell
    // with a hole in it. On its own that proves nothing about whether the hole was
    // filled - Next.js sets the header before resuming - so the assertions below
    // are the ones that matter: the shell knows nothing about the slug, so the
    // category name can only be in the bytes if the resume ran and completed.
    expect(electronics.headers()["x-nextjs-postponed"]).toBe("1");

    const electronicsHtml = await electronics.text();
    const clothingHtml = await clothing.text();

    expect(electronicsHtml).toContain("All Electronics");
    expect(clothingHtml).toContain("All Clothing");

    // The shell is the part before the first streamed boundary lands. Comparing a
    // marker that only the shell contains keeps this from asserting on Next.js
    // internals: the nav is outside every boundary, so it is in both.
    expect(electronicsHtml).toContain("App Router");
    expect(clothingHtml).toContain("App Router");
  });

  test("keeps the cached part cached across requests", async ({
    request,
    baseURL,
  }) => {
    test.skip(baseURL?.includes("localhost") === true);

    // The subcategory tabs come from `getCategories()` behind a `'use cache'`, so
    // the second request must not go back to the upstream API for them. There is
    // no header that proves that from outside, so this asserts the observable
    // consequence: identical content, and a response fast enough that a cold
    // upstream fetch is implausible.
    const first = await request.get("./layouts/electronics");
    expect(first.status()).toBe(200);
    const firstHtml = await first.text();

    const startedAt = Date.now();
    const second = await request.get("./layouts/electronics");
    const elapsedMs = Date.now() - startedAt;

    expect(second.status()).toBe(200);
    const secondHtml = await second.text();

    for (const subcategory of ["Phones", "Tablets", "Laptops"]) {
      expect(firstHtml).toContain(subcategory);
      expect(secondHtml).toContain(subcategory);
    }

    console.log(`Second request for a warm PPR route took ${elapsedMs}ms`);
    // Generous on purpose: the suite runs 4 workers, so this request competes for
    // the runner's network and for the same warm Lambda/task as three others. The
    // claim being made is "not a cold upstream fetch", which a 10s ceiling still
    // supports - tightening it measures contention instead.
    expect(elapsedMs).toBeLessThan(10_000);
  });
});

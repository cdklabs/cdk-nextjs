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
  test("puts the shell before the request-dependent part", async ({
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
    // prerendered and the rest resumed onto it. It does not prove the shell was
    // *sent* first - this body is fully buffered, and a path that held the whole
    // response back would produce the same bytes. The next test covers that.
    expect(shellIndex).toBeLessThan(dynamicIndex);

    // And the streamed half really is per-request.
    await page.goto("./patterns/search-params?sort=desc", {
      waitUntil: "networkidle",
    });
    await expect(
      page.getByRole("link", { name: "desc", exact: true }),
    ).toHaveClass(/bg-vercel-blue/);
  });

  test("flushes the shell before the request-dependent part has rendered", async ({
    baseURL,
  }) => {
    test.skip(baseURL?.includes("localhost") === true);

    // `fetch`, not Playwright's `request`: that buffers the body, and when each
    // byte arrived is the whole assertion. The ALB gate's cookie has to be set by
    // hand for the same reason - `storageState` only reaches Playwright's own
    // clients - and there is no redirect here for a hand-set header to be lost on.
    const url = new URL("./patterns/ppr-streaming?id=e2e", baseURL);
    const startedAt = Date.now();
    const response = await fetch(url, { headers: { cookie: "cdk-nextjs=1" } });
    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();

    // `app/patterns/ppr-streaming/page.tsx` holds its request-dependent part back
    // for 2 s. Record when each marker first appears in the bytes received so far.
    const decoder = new TextDecoder();
    const reader = response.body!.getReader();
    let received = "";
    let shellAt: number | undefined;
    let dynamicAt: number | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
      const now = Date.now() - startedAt;
      if (shellAt === undefined && received.includes("ppr-shell-marker")) {
        shellAt = now;
      }
      if (dynamicAt === undefined && received.includes("ppr-dynamic-e2e")) {
        dynamicAt = now;
      }
    }
    console.log(`ppr: shell at ${shellAt}ms, dynamic part at ${dynamicAt}ms`);

    expect(shellAt).toBeDefined();
    expect(dynamicAt).toBeDefined();
    // Well under the 2 s the page waits, so network jitter cannot fake it, and
    // far above what a buffered response could show: anything that waited for
    // the end of the body would hand over both markers at the same instant.
    expect(dynamicAt! - shellAt!).toBeGreaterThanOrEqual(1_000);
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

  // `app/patterns/ppr-cached/page.tsx` renders two timestamps on resume: one
  // inside `'use cache: remote'` keyed by `key`, one not. Timestamps, not
  // timing: a hit and a miss differ in value, so contention can't fake a pass.
  test("keeps the cached part cached and re-renders the dynamic one", async ({
    request,
  }) => {
    const key = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();

    async function load() {
      const response = await request.get(
        `./patterns/ppr-cached?key=${encodeURIComponent(key)}`,
      );
      expect(response.status()).toBe(200);
      const html = await response.text();
      const read = (testId: string) => {
        const match = html.match(
          new RegExp(`data-testid="${testId}"[^>]*>([^<]+)<`),
        );
        expect(match, `${testId} in the response`).not.toBeNull();
        return match?.[1] ?? "";
      };
      return { cached: read("ppr-cached-at"), dynamic: read("ppr-dynamic-at") };
    }

    const first = await load();
    // Rendered at request time for this run's key, not at build time.
    const [cachedKey, cachedAt] = first.cached.split(":");
    expect(cachedKey).toBe(key);
    expect(Number(cachedAt)).toBeGreaterThanOrEqual(startedAt - 60_000);

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const second = await load();

    expect(second.cached).toBe(first.cached);
    expect(second.dynamic).not.toBe(first.dynamic);
  });
});

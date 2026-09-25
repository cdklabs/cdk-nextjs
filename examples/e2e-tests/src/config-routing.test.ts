import { test, expect } from "@playwright/test";

/**
 * `redirects()`, `headers()` and `rewrites()` from `next.config.ts`.
 *
 * None of these reach a route handler as code: `next build` compiles them into
 * `ctx.routing` and the runtime's Dispatcher applies them through
 * `@next/routing` before any entrypoint runs. Next.js prefixes each `source`
 * with `basePath`, so on NextjsRegionalFunctions every case here is also a test
 * of the `/prod` stage surviving both directions - the request path matched
 * against the rule, and the `location` built from its destination.
 */
test.describe("config routing", () => {
  test("redirects with the matched param and the basePath", async ({
    request,
    baseURL,
  }) => {
    const response = await request.get("./e2e/redirect-from/hello", {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(307);

    // Resolved against the URL that was asked for, so a relative `location` and
    // an absolute one compare the same. The prefix is whatever path `baseURL`
    // carries - `/prod/` on API Gateway, `/` everywhere else.
    const location = new URL(
      response.headers()["location"]!,
      new URL("./e2e/redirect-from/hello", baseURL),
    );
    expect(location.pathname).toBe(
      new URL("./params/encoded/hello", baseURL).pathname,
    );
  });

  test("lands on the redirect's destination page", async ({ page }) => {
    await page.goto("./e2e/redirect-from/hello");

    const params = JSON.parse(
      (await page.getByTestId("params").textContent()) ?? "{}",
    );
    expect(params).toEqual({ slug: "hello" });
  });

  test("adds a configured header only to the matching route", async ({
    request,
  }) => {
    const matched = await request.get("./api/echo");
    expect(matched.status()).toBe(200);
    expect(matched.headers()["x-e2e-config-header"]).toBe("from-next-config");

    const unmatched = await request.get("./api/health");
    expect(unmatched.status()).toBe(200);
    expect(unmatched.headers()["x-e2e-config-header"]).toBeUndefined();
  });

  test("applies a beforeFiles rewrite that matches its own output once", async ({
    page,
  }) => {
    // The rewritten URL, `/e2e/rewrite/echo?json=true&from=/some/route`, still
    // satisfies the rule. Next.js re-runs `beforeFiles` inside the entrypoint
    // against that URL, and unless the runtime hands it the resolved query as
    // request meta, the second pass wins and `from` comes back as `/echo`.
    const response = await page.goto("./e2e/rewrite/some/route?json=true");
    expect(response?.status()).toBe(200);

    // Only `from` and `json`: the rule's `:path` capture also lands in the
    // query, and whether it does is Next.js's business, not the runtime's.
    const searchParams = JSON.parse(
      (await page.getByTestId("search-params").textContent()) ?? "{}",
    );
    expect(searchParams).toMatchObject({ from: "/some/route", json: "true" });
  });

  test("leaves the rewrite alone when its has condition does not hold", async ({
    request,
  }) => {
    // Without `?json=true` nothing rewrites and nothing else serves this path,
    // so a 404 is what proves the `has` gate is being evaluated at all.
    const response = await request.get("./e2e/rewrite/some/route");
    expect(response.status()).toBe(404);
  });
});

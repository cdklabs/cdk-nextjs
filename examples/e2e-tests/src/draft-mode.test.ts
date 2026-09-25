import { test, expect } from "@playwright/test";

/**
 * Next.js draft mode, which is the best cookie round-trip test available because
 * the cookie's value cannot be faked: `__prerender_bypass` has to match the
 * `previewModeId` generated at build time, so a page reporting draft mode as *on*
 * proves the exact bytes the server set came back to it.
 *
 * That makes it the end-to-end proof of something only unit-tested today. The API
 * Gateway shell rebuilds a single `Cookie` header from values that arrived
 * separately, joining them with `"; "`; the runtime's own comment records that a
 * `","` join - correct for most repeated headers - "lost every cookie after the
 * first, including `__prerender_bypass` and `__next_preview_data`, so draft mode
 * silently stopped working". Nothing in either e2e suite has ever exercised that,
 * and there is no green file in the Next.js compatibility harness matching `draft`.
 *
 * Only `__prerender_bypass` is asserted. `__next_preview_data` carries the preview
 * payload and is Pages Router only - verified against a dev server rather than
 * taken from the runtime comment above, which names both because the code it
 * describes serves both routers.
 *
 * The browser is used rather than `request` because this is a browser feature:
 * the cookie has to survive the browser's own cookie rules, not only the wire.
 *
 * Which is also why it is skipped on a plain-`http:` deployment - today, the
 * regional-containers example's bare ALB. A production Next.js server (what all
 * four types run) sets `__prerender_bypass` with `Secure; SameSite=None`, and a
 * browser refuses a `Secure` cookie from an insecure origin, so draft mode cannot
 * work there for any app on any platform. Keyed on the scheme rather than the
 * deployment type, so the same example behind an HTTPS listener runs it.
 *
 * Only a non-loopback `http:` origin is skipped. `localhost`, `127.0.0.1` and
 * `[::1]` are potentially-trustworthy origins, so Chromium keeps a `Secure`
 * cookie from them over plain HTTP - `next start` locally works - and `next dev`
 * leaves `Secure` and `SameSite=None` off the cookie altogether.
 *
 * What silently breaks: every preview/draft integration in an app, with no error
 * on any side - the page just renders published content.
 */

/** `URL.hostname` keeps the brackets on an IPv6 literal, hence `[::1]`. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Plain HTTP to anything but loopback: where a `Secure` cookie is dropped. */
function isInsecureRemoteOrigin(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  const url = new URL(baseURL);
  return url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname);
}

test.describe("draft mode", () => {
  test.skip(
    ({ baseURL }) => isInsecureRemoteOrigin(baseURL),
    "a browser drops Next.js's `Secure` draft-mode cookie over plain HTTP",
  );

  test("enabling sets the bypass cookie", async ({ page, context }) => {
    await page.goto("./api/draft?enable=1");

    const cookies = await context.cookies();
    const bypass = cookies.find((c) => c.name === "__prerender_bypass");

    expect(bypass).toBeTruthy();
    // A non-empty value, because the whole point is that the server's own
    // `previewModeId` came back. An empty or truncated value reads as "off".
    expect(bypass?.value.length).toBeGreaterThan(0);
    // `HttpOnly` and site-wide: draft mode is useless if it only applies to the
    // path that set it, and the cookie must not be readable from JS.
    expect(bypass?.httpOnly).toBe(true);
    expect(bypass?.path).toBe("/");
  });

  test("a page reads draft mode as enabled once the cookie is set", async ({
    page,
  }) => {
    // Published first, so the assertion below is a *change* and not the route's
    // default. Without this, a page hard-coded to `draft:on` would pass.
    await page.goto("./draft");
    await expect(page.getByTestId("draft-enabled")).toHaveText("draft:off");

    await page.goto("./api/draft?enable=1");

    await page.goto("./draft");
    // This is the assertion the whole file exists for: the cookie survived
    // CloudFront, API Gateway or the ALB and was still readable server-side, with
    // its value intact.
    await expect(page.getByTestId("draft-enabled")).toHaveText("draft:on");
  });

  test("disabling restores published content", async ({ page, context }) => {
    await page.goto("./api/draft?enable=1");
    await page.goto("./draft");
    await expect(page.getByTestId("draft-enabled")).toHaveText("draft:on");

    await page.goto("./api/draft");

    await page.goto("./draft");
    await expect(page.getByTestId("draft-enabled")).toHaveText("draft:off");

    // And the cookie is actually gone, not merely ignored. A draft response that
    // is cached under a still-present bypass cookie is how a draft render leaks to
    // everyone, so clearing it matters beyond what the page renders.
    const bypass = (await context.cookies()).find(
      (c) => c.name === "__prerender_bypass",
    );
    expect(bypass?.value ?? "").toBe("");
  });
});

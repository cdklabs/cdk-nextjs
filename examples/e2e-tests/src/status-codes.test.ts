import { test, expect } from "@playwright/test";
import { isLocal } from "./utils/deployment-type";

/**
 * The status codes an app produces other than 200, and the bodies that go with
 * them.
 *
 * These are worth asserting per deployment type because a status and a body travel
 * separately. A streamed response carries its status in a prelude the integration
 * has to forward; a cached response carries it as a field the handler has to read.
 * Both have been lost independently - a HEAD on a 404 page answered 200, and a
 * build-time 404 was seeded and then served as a 200 carrying the 404 page's HTML.
 *
 * What silently breaks: every one of these looks right in a browser, which renders
 * the body it was given and says nothing about the status. It is wrong to every
 * crawler, CDN and monitor in front of the app.
 */
test.describe("status codes", () => {
  test("answers an unknown path with the app's not-found page", async ({
    request,
  }) => {
    const response = await request.get("./this-route-does-not-exist-e2e");
    expect(response.status()).toBe(404);
    // The app's own `app/not-found.tsx`, not a framework default or a CDN error
    // page - which is what a misrouted 404 would produce.
    expect(await response.text()).toContain(
      "Could not find requested resource",
    );
  });

  test("answers notFound() from a route handler with a 404", async ({
    request,
  }) => {
    // A 404 out of an `APP_ROUTE` reaches different code than a page's does: there
    // is no HTML to render, so the runtime has to produce the 404 itself.
    const response = await request.get("./api/echo?notfound=1");
    expect(response.status()).toBe(404);
  });

  test("serves a page prerendered as notFound() with a 404", async ({
    request,
  }) => {
    // `app/not-found-prerendered/page.tsx` calls `notFound()` with nothing
    // request-dependent, so `next build` prerenders it and hands the adapter an
    // entry whose status is 404. Seeding that is where the status can go missing:
    // the Pages Router version of this shipped as a 200 carrying the 404 page's
    // HTML, because the entry was a normal cache hit and the handler never read
    // its status.
    const first = await request.get("./not-found-prerendered");
    expect(first.status()).toBe(404);
    expect(await first.text()).toContain("Could not find requested resource");

    // Again, because the bug was specifically on the *hit* path - the first
    // response can be correct while every cached one after it is a 200.
    const second = await request.get("./not-found-prerendered");
    expect(second.status()).toBe(404);
    expect(await second.text()).toContain("Could not find requested resource");
  });

  test("answers a server render throw with an uncacheable error shell", async ({
    request,
  }) => {
    // Dev mode answers a throw with its own error overlay and the real message, so
    // neither the body nor the caching assertion below describes it.
    test.skip(isLocal(), "dev mode renders its own error overlay");

    const response = await request.get("./error-handling/server-throw?boom=1");

    // A 200, and that is Next.js rather than the deployment: `next start` on this
    // same build answers this request with a byte-identical 200. `instant = false`
    // on the page is not enough to make it a 500, because the *layout* above it is
    // cached, so a shell has already been postponed and flushed by the time the
    // page throws - the `x-nextjs-postponed` header is that shell. Getting a 500
    // would mean leaving the whole subtree uncached, which is a different test.
    expect(response.status()).toBe(200);
    expect(response.headers()["x-nextjs-postponed"]).toBe("1");

    const body = await response.text();
    // React's marker for a shell that resolved to an error instead of content. The
    // app's `error.tsx` is deliberately *not* asserted: the boundary renders on the
    // client out of this payload, so this marker is the server-side byte that
    // proves the throw was handled rather than swallowed or truncated.
    expect(body).toContain('id="__next_error__"');
    // Whatever arrives must not be the error itself. A deployment that leaks the
    // message leaks bundle paths with it.
    expect(body).not.toContain("deliberate server render throw");
    expect(body).not.toContain("/var/task");

    // The assertion that was always the point: an error response must not be
    // cached - on the CDN types especially, where one would be served to everyone
    // until it expired.
    expect(response.headers()["cache-control"]).toContain("no-store");
  });

  test("answers a route handler throw with a 500 and no stack trace", async ({
    request,
  }) => {
    const response = await request.get("./api/echo?throw=1");
    expect(response.status()).toBe(500);

    // Dev mode deliberately returns the real message; a deployment must not.
    test.skip(isLocal(), "dev mode returns the real error");

    const body = await response.text();
    // Whatever the body is, it must not be the error. A deployment that leaks a
    // stack trace leaks absolute paths inside the bundle with it.
    expect(body).not.toContain("deliberate route handler throw");
    expect(body).not.toContain("/var/task");
  });
});

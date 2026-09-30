import { test, expect } from "@playwright/test";

/**
 * `robots.txt`, `sitemap.xml` and `manifest.webmanifest`.
 *
 * These are the three files a defect was filed against by name. They are not
 * ordinary routes: `next build` prerenders each one to a `<route>.body` file, and
 * the runtime has to work out the content type from the *route name* rather than
 * from a file extension it can trust - `sitemap.xml` is staged as `sitemap.xml.body`,
 * so anything keying off the last extension types it as whatever `.body` maps to.
 * `setBodyFileContentType` in `src/runtime/static-files.ts` is the function that
 * has to get this right, and it has to get it right identically on a Lambda reading
 * from its own bundle and on a container reading from its image.
 *
 * What silently breaks: a body served as `application/octet-stream` or
 * `text/html`. Every one of these is consumed only by crawlers and by the browser's
 * install prompt, so a browser visit looks completely fine and nothing in the app
 * changes. The symptom is that search engines stop indexing and the PWA stops
 * installing, weeks later, with no error anywhere.
 */
test.describe("metadata routes", () => {
  const ROUTES = [
    {
      path: "./robots.txt",
      contentType: "text/plain",
      // From `app/robots.ts`. Asserted on content rather than length so a body
      // that is the *wrong* file - an HTML error page is also non-empty - fails.
      contains: "User-Agent: *",
    },
    {
      path: "./sitemap.xml",
      contentType: "application/xml",
      contains: "<urlset",
    },
    {
      path: "./manifest.webmanifest",
      contentType: "application/manifest+json",
      contains: '"short_name":"app-playground"',
    },
  ];

  for (const route of ROUTES) {
    test(`serves ${route.path} with the right content type and body`, async ({
      request,
    }) => {
      const response = await request.get(route.path);
      expect(response.status()).toBe(200);

      // `toContain`, not equality: the runtime is free to append a charset, and
      // whether it does is not what this is about.
      expect(response.headers()["content-type"]).toContain(route.contentType);
      expect(await response.text()).toContain(route.contains);
    });
  }
});

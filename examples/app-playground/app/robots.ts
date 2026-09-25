import type { MetadataRoute } from 'next';

/**
 * One of the three metadata routes that went out as `application/octet-stream`.
 *
 * `next build` writes each of these as a file whose extension says nothing about
 * its type (`robots.txt.body`), so the content type has to be reconstructed from
 * the *route* when the file is served. Getting it wrong is invisible in a browser
 * - which sniffs - and fatal to the consumers these routes exist for: a crawler
 * skips a `robots.txt` it is not served as `text/plain`.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: '/api/',
    },
  };
}

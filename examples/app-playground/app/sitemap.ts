import type { MetadataRoute } from 'next';

/**
 * Served as `application/xml`, not `application/octet-stream` - see `app/robots.ts`
 * for why that is a real bug rather than a cosmetic one.
 *
 * The URLs are relative to a fixed base rather than to the deployment's own
 * hostname, because a sitemap has to be absolute and this app is deployed behind
 * four different ones. Nothing asserts the host; the type and a non-empty body are
 * the point.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: 'https://example.com/',
      lastModified: new Date('2026-01-01'),
      changeFrequency: 'daily',
      priority: 1,
    },
    {
      url: 'https://example.com/isr/1',
      lastModified: new Date('2026-01-01'),
      changeFrequency: 'hourly',
      priority: 0.8,
    },
  ];
}

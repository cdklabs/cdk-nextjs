import { notFound } from 'next/navigation';
import type { Review } from './review';

// `server-only` guarantees any modules that import code in file
// will never run on the client. Even though this particular api
// doesn't currently use sensitive environment variables, it's
// good practise to add `server-only` preemptively.
import 'server-only';

/**
 * Cached for the same reason as `getCategories`: with `cacheComponents` an
 * uncached `fetch` awaited during a render stops the route from being
 * prerendered. The control flow below is deliberately outside the cache - see
 * the comment in `app/api/categories/getCategories.ts`.
 */
async function fetchReviews(): Promise<{ ok: boolean; data: Review[] }> {
  'use cache';

  const res = await fetch(`https://app-playground-api.vercel.app/api/reviews`);

  if (!res.ok) {
    return { ok: false, data: [] };
  }

  return { ok: true, data: (await res.json()) as Review[] };
}

export async function getReviews() {
  const { ok, data: reviews } = await fetchReviews();

  if (!ok) {
    // Render the closest `error.js` Error Boundary
    throw new Error('Something went wrong!');
  }

  if (reviews.length === 0) {
    // Render the closest `not-found.js` Error Boundary
    notFound();
  }

  return reviews;
}

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
 * prerendered. An upstream failure throws from inside the cache so that it is
 * not persisted, and `notFound()` stays outside it - see the comment in
 * `app/api/categories/getCategories.ts`.
 */
async function fetchReviews(): Promise<Review[]> {
  'use cache';

  const res = await fetch(`https://app-playground-api.vercel.app/api/reviews`);

  if (!res.ok) {
    throw new Error(`The reviews API responded ${res.status}`);
  }

  return (await res.json()) as Review[];
}

export async function getReviews() {
  // An upstream failure throws out of `fetchReviews` and renders the closest
  // `error.js` Error Boundary, uncached.
  const reviews = await fetchReviews();

  if (reviews.length === 0) {
    // Render the closest `not-found.js` Error Boundary
    notFound();
  }

  return reviews;
}

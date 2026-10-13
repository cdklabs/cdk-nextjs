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
 * prerendered.
 *
 * An upstream failure throws from *inside* the cache rather than being returned
 * as an `{ ok: false }` sentinel. A rejected promise is not persisted, so the
 * next request retries the API; a resolved sentinel is persisted like any other
 * value, which would serve `error.js` for every subsequent request for the life
 * of the entry. `notFound()` stays outside it: an empty response is a valid,
 * cacheable answer, and the 404 is a decision about one request.
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

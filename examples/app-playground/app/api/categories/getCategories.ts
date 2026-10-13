import { notFound } from 'next/navigation';
import { queryCategories } from './categories';
import type { Category } from './category';

// `server-only` guarantees any modules that import code in file
// will never run on the client. Even though this particular API
// doesn't currently use sensitive environment variables, it's
// good practice to add `server-only` preemptively.
import 'server-only';

/**
 * The `fetch`, cached. Layouts all over this app await these functions at the
 * top level, and with `cacheComponents` an uncached `fetch` there makes the
 * whole route unprerenderable.
 *
 * The answer comes from a `data:` URL built from the local copy in
 * `categories.ts`, not the playground API it was copied from: the call runs
 * during `next build`, where one dropped connection failed the build (#269).
 * It stays a `fetch` for the `FETCH`-kind cache entries it writes, as
 * `fetchPost` in `#/lib/posts` explains.
 *
 * `notFound()` belongs to the wrappers below: an empty response is a valid,
 * cacheable answer, and the 404 is a decision about one request rather than
 * something to store.
 */
async function fetchCategories(query: {
  parent?: string;
  slug?: string;
}): Promise<Category[]> {
  'use cache';

  const res = await fetch(
    `data:application/json,${encodeURIComponent(JSON.stringify(queryCategories(query)))}`,
  );

  // An array for `parent`/no query and a single object for `slug`, as the API
  // answered; normalizing here keeps one cached function for both.
  const json = (await res.json()) as Category[] | Category | null;

  return json ? [json].flat() : [];
}

export async function getCategories({ parent }: { parent?: string } = {}) {
  const categories = await fetchCategories({ parent });

  if (categories.length === 0) {
    // Render the closest `not-found.js` Error Boundary
    notFound();
  }

  return categories;
}

export async function getCategory({ slug }: { slug: string }) {
  const data = await fetchCategories({ slug });

  const category = data[0];

  if (!category) {
    // Render the closest `not-found.js` Error Boundary
    notFound();
  }

  return category;
}

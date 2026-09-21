import { notFound } from 'next/navigation';
import type { Category } from './category';

// `server-only` guarantees any modules that import code in file
// will never run on the client. Even though this particular API
// doesn't currently use sensitive environment variables, it's
// good practice to add `server-only` preemptively.
import 'server-only';

/**
 * The network round trip, cached. Layouts all over this app await these
 * functions at the top level, and with `cacheComponents` an uncached `fetch`
 * there makes the whole route unprerenderable.
 *
 * Only the fetch is cached. `notFound()` and the throw to the closest
 * `error.js` stay in the exported wrappers below, because they are decisions
 * about one request: thrown out of a `'use cache'` function they would be what
 * gets stored, so a single blip would keep serving a 404 or an error page for
 * the life of the cache entry.
 */
async function fetchCategories(
  query: string,
): Promise<{ ok: boolean; data: Category[] }> {
  'use cache';

  const res = await fetch(
    `https://app-playground-api.vercel.app/api/categories${query}`,
  );

  if (!res.ok) {
    return { ok: false, data: [] };
  }

  // The API returns an array for `?parent=`/no query and a single object for
  // `?slug=`; normalizing here keeps one cached function for both.
  const json = (await res.json()) as Category[] | Category | null;

  return { ok: true, data: json ? [json].flat() : [] };
}

export async function getCategories({ parent }: { parent?: string } = {}) {
  const { ok, data: categories } = await fetchCategories(
    parent ? `?parent=${parent}` : '',
  );

  if (!ok) {
    // Render the closest `error.js` Error Boundary
    throw new Error('Something went wrong!');
  }

  if (categories.length === 0) {
    // Render the closest `not-found.js` Error Boundary
    notFound();
  }

  return categories;
}

export async function getCategory({ slug }: { slug: string }) {
  const { ok, data } = await fetchCategories(slug ? `?slug=${slug}` : '');

  if (!ok) {
    // Render the closest `error.js` Error Boundary
    throw new Error('Something went wrong!');
  }

  const category = data[0];

  if (!category) {
    // Render the closest `not-found.js` Error Boundary
    notFound();
  }

  return category;
}

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
 * An upstream failure throws from *inside* the cache rather than being returned
 * as an `{ ok: false }` sentinel. A rejected promise is not persisted, so the
 * next request retries the API; a resolved sentinel is persisted like any other
 * value, which meant one 503 here served `error.js` for every subsequent
 * request for the life of the entry - the exact failure the sentinel was
 * introduced to avoid.
 *
 * `notFound()` still belongs to the wrappers below, and for the original
 * reason: an empty response is a valid, cacheable answer, and the 404 is a
 * decision about one request rather than something to store.
 */
async function fetchCategories(query: string): Promise<Category[]> {
  'use cache';

  const res = await fetch(
    `https://app-playground-api.vercel.app/api/categories${query}`,
  );

  if (!res.ok) {
    throw new Error(`The categories API responded ${res.status}`);
  }

  // The API returns an array for `?parent=`/no query and a single object for
  // `?slug=`; normalizing here keeps one cached function for both.
  const json = (await res.json()) as Category[] | Category | null;

  return json ? [json].flat() : [];
}

export async function getCategories({ parent }: { parent?: string } = {}) {
  // An upstream failure throws out of `fetchCategories` and renders the closest
  // `error.js` Error Boundary, uncached.
  const categories = await fetchCategories(parent ? `?parent=${parent}` : '');

  if (categories.length === 0) {
    // Render the closest `not-found.js` Error Boundary
    notFound();
  }

  return categories;
}

export async function getCategory({ slug }: { slug: string }) {
  const data = await fetchCategories(slug ? `?slug=${slug}` : '');

  const category = data[0];

  if (!category) {
    // Render the closest `not-found.js` Error Boundary
    notFound();
  }

  return category;
}

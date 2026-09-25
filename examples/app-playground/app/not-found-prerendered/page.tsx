import { notFound } from 'next/navigation';

/**
 * A page that resolves to a 404 *at build time*, so `next build` hands the
 * adapter a prerender whose `initialStatus` is 404 and whose body is the app's
 * not-found page.
 *
 * Seeding that is where a status can get lost. The Pages Router version of this
 * shipped as a `200` carrying the 404 page's HTML: the entry was seeded as an
 * ordinary cache hit, and the pages handler never reads `value.status` on the hit
 * path. The App Router path is different code - the adapter seeds an `APP_PAGE`
 * with `status: initialStatus` and the app handler *does* read it - and nothing
 * asserted that on any deployment type. The failure mode to catch is the same one:
 * a 200 whose body says 404, which looks correct in a browser and is wrong to
 * every crawler and cache in front of it.
 *
 * No params and no request reads, so this really is prerendered rather than
 * evaluated per request - which is the whole point.
 */
export default function Page() {
  notFound();
}

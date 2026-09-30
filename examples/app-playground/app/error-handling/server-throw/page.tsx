import { Boundary } from '#/ui/boundary';

/**
 * A throw on the *server*, which the app otherwise has no example of - every
 * existing `error-handling` demo throws in the browser via `ui/buggy-button.tsx`.
 * The difference matters to a deployment: a client-side throw never leaves the
 * browser, while this one has to reach the wire as an error the router can render
 * and as a response nothing caches. It has been plain text with no error page at
 * all, and it has been a truncated body.
 *
 * Placed under `app/error-handling/` to inherit that boundary rather than ship a
 * second copy of one.
 *
 * What this route actually answers, measured on a deployment and on plain `next
 * start` against the same build - byte-identical: **200** with
 * `x-nextjs-postponed: 1`, `cache-control: ...no-store...`, and an
 * `id="__next_error__"` shell. Not a 500. `instant = false` here makes the *page*
 * block on the request, but `app/error-handling/layout.tsx` above it awaits only
 * `getCategories()` - a `'use cache'` function - so its shell is postponed and
 * flushed first, and the status is committed before the throw happens. A 500 would
 * need nothing cached anywhere in the subtree, which would cost that layout its
 * `'use cache'` and is a different test than this one.
 * `status-codes.test.ts` asserts the behaviour above.
 *
 * Only throws with `?boom=1`, so `next build` can still prerender the route and
 * the build stays green.
 */
export const instant = false;

export default async function Page(props: {
  searchParams: Promise<{ boom?: string }>;
}) {
  const { boom } = await props.searchParams;

  if (boom) {
    throw new Error('e2e: deliberate server render throw');
  }

  return (
    <Boundary labels={['server-throw']} color="default">
      <p className="text-sm text-gray-400">
        Add <code>?boom=1</code> to throw during the server render.
      </p>
    </Boundary>
  );
}

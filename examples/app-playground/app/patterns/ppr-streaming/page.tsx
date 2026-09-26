import { Suspense } from 'react';

/**
 * A Partial Prerendering route for the ppr e2e's streaming check, and nothing
 * else. `/patterns/search-params` proves the shell and the resumed part arrive in
 * the right *order*, but its request-dependent part resolves at once, so the two
 * can reach the client in one flush and a path that buffered the whole response
 * would pass too. Here the request-dependent part deliberately takes
 * `STREAM_DELAY_MS`, so the shell arriving that much earlier is only possible if
 * nothing between the server and the client waited for the end of the response.
 */
const STREAM_DELAY_MS = 2_000;

export default function Page(props: { searchParams: Promise<{ id?: string }> }) {
  return (
    <div className="prose prose-sm prose-invert max-w-none">
      <h1 className="text-lg font-bold">PPR streaming</h1>
      {/* In the prerendered shell: outside every boundary. */}
      <p>ppr-shell-marker</p>
      <Suspense fallback={<p>Loading…</p>}>
        <Delayed searchParams={props.searchParams} />
      </Suspense>
    </div>
  );
}

async function Delayed({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  // Reading `searchParams` is what makes this part request-dependent, so it is
  // left out of the shell and rendered on resume.
  const { id = 'none' } = await searchParams;
  await new Promise((resolve) => setTimeout(resolve, STREAM_DELAY_MS));
  // One template string, so React emits the marker as a single text node.
  return <p>{`ppr-dynamic-${id}`}</p>;
}

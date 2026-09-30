import { cacheLife } from 'next/cache';
import { Suspense } from 'react';

/**
 * A Partial Prerendering route for the ppr e2e's "the cached part stays cached"
 * check, and nothing else. Both timestamps are rendered at request time, inside
 * the resumed boundary, so neither is baked into the build's shell: one is
 * cached per `key`, the other is not. Two loads with the same `key` must agree
 * on the first and differ on the second, which a deployment that re-rendered the
 * cached part on every request, or served the whole response from a cache,
 * cannot fake.
 */
export default function Page(props: {
  searchParams: Promise<{ key?: string }>;
}) {
  return (
    <div className="prose prose-sm prose-invert max-w-none">
      <h1 className="text-lg font-bold">PPR cached segment</h1>
      <Suspense fallback={<p>Loading…</p>}>
        <Parts searchParams={props.searchParams} />
      </Suspense>
    </div>
  );
}

async function Parts({
  searchParams,
}: {
  searchParams: Promise<{ key?: string }>;
}) {
  // Reading `searchParams` makes this boundary request-dependent, so it is left
  // out of the shell and rendered on resume.
  const { key = 'none' } = await searchParams;
  return (
    <>
      <p data-testid="ppr-cached-at">{await cachedAt(key)}</p>
      <p data-testid="ppr-dynamic-at">{String(Date.now())}</p>
    </>
  );
}

/**
 * `'use cache: remote'`, not plain `'use cache'`: plain lives in each
 * instance's memory, and a second load can land on another Lambda instance or
 * Fargate task. The remote handler stores the entry in S3, where every instance
 * finds it. Keyed by `key`, so each test run starts with a genuine miss.
 */
async function cachedAt(key: string): Promise<string> {
  'use cache: remote';
  cacheLife('hours');
  return `${key}:${Date.now()}`;
}

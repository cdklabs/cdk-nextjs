import { cacheTag } from 'next/cache';
import { connection } from 'next/server';

/**
 * One `'use cache'` entry per `n`, tagged `item-<n>`: the load tests' `use-cache`
 * script requests `n` across a range, so every instance ends up tracking that
 * many tags. The page itself is dynamic, so every request reaches the
 * `'use cache'` handler and its tag manifest.
 */
async function getItem(n: string) {
  'use cache';
  cacheTag(`item-${n}`);
  return { n, generatedAt: Date.now() };
}

export default async function Page({
  params,
}: {
  params: Promise<{ n: string }>;
}) {
  await connection();
  const { n } = await params;
  const item = await getItem(n);
  return (
    <>
      <h1 data-bench="use-cache">use cache</h1>
      <p>
        Item {item.n} generated at {new Date(item.generatedAt).toISOString()}
      </p>
    </>
  );
}

import { connection } from 'next/server';
import { setTimeout } from 'node:timers/promises';
import { Suspense } from 'react';
import { Counter } from '#/lib/counter';
import { getRows } from '#/lib/rows';
import { RowsTable } from '#/lib/rows-table';

/** In-process stand-in for a slow data source, so TTFB and total time differ. */
const DELAY_MS = 200;

async function SlowRows() {
  await connection();
  await setTimeout(DELAY_MS);
  return <RowsTable rows={getRows(Date.now())} />;
}

export default function Page() {
  return (
    <>
      <h1 data-bench="stream">Stream</h1>
      <Counter />
      <Suspense fallback={<p data-bench-fallback>Loading…</p>}>
        <SlowRows />
      </Suspense>
    </>
  );
}

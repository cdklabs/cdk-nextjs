import { Counter } from '#/lib/counter';
import { getRows } from '#/lib/rows';
import { RowsTable } from '#/lib/rows-table';

// Short enough that a load test run sees many background revalidations, which
// is what exercises the cache handler's writes as well as its reads.
export const revalidate = 10;

export default function Page() {
  const now = Date.now();
  return (
    <>
      <h1 data-bench="isr">ISR</h1>
      <p>Rendered at {new Date(now).toISOString()}</p>
      <Counter />
      <RowsTable rows={getRows(now)} />
    </>
  );
}

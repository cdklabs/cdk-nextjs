import { connection } from 'next/server';
import { Counter } from '#/lib/counter';
import { getRows } from '#/lib/rows';
import { RowsTable } from '#/lib/rows-table';

export default async function Page() {
  await connection();
  const now = Date.now();
  return (
    <>
      <h1 data-bench="ssr">SSR</h1>
      <p>Rendered at {new Date(now).toISOString()}</p>
      <Counter />
      <RowsTable rows={getRows(now)} />
    </>
  );
}

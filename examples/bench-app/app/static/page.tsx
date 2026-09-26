import { Counter } from '#/lib/counter';
import { getRows } from '#/lib/rows';
import { RowsTable } from '#/lib/rows-table';

export default function Page() {
  return (
    <>
      <h1 data-bench="static">Static</h1>
      <Counter />
      <RowsTable rows={getRows(1)} />
    </>
  );
}

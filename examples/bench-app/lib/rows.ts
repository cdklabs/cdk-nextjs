export interface Row {
  id: number;
  name: string;
  price: string;
  stock: number;
}

/**
 * Deterministic render work standing in for a data fetch. Routes must not call
 * anything outside the stack under test: that would load test a third party and
 * put its latency into ours.
 */
export function getRows(seed: number, count = 100): Row[] {
  const rows: Row[] = [];
  let x = seed || 1;
  for (let id = 1; id <= count; id++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    rows.push({
      id,
      name: `Product ${id.toString(36).toUpperCase()}-${x % 997}`,
      price: `$${((x % 100000) / 100).toFixed(2)}`,
      stock: x % 250,
    });
  }
  return rows;
}

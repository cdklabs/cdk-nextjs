export interface Stats {
  count: number;
  avg: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

export function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
  return {
    count: sorted.length,
    avg: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

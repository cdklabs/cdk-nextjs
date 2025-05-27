export async function waitXSec(x: number) {
  return new Promise((resolve) => setTimeout(() => resolve(null), 1000 * x));
}

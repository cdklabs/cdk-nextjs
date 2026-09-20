import { Page } from "@playwright/test";
import { getPageTimestamp } from "./timestamp-helpers";

/**
 * Reloads a page repeatedly until its rendered timestamp satisfies
 * `isFresh`, or `timeoutMs` elapses. CloudFront invalidation and
 * cross-instance memory cache eviction are both eventually consistent with
 * no fixed completion time, so polling tolerates that instead of assuming a
 * fixed wait is always long enough.
 *
 * @returns the last observed timestamp (matching `isFresh` if it did in time)
 */
export async function waitForTimestamp(
  page: Page,
  isFresh: (timestamp: string | null) => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string | null> {
  const { timeoutMs = 90_000, intervalMs = 3_000 } = options;
  const deadline = Date.now() + timeoutMs;

  // Check the page's current state (as navigated to by the caller) before
  // reloading, so callers don't pay for a redundant reload.
  let timestamp = await getPageTimestamp(page);

  while (!isFresh(timestamp) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    await page.reload({ waitUntil: "networkidle" });
    timestamp = await getPageTimestamp(page);
  }

  return timestamp;
}

/** Polls until the page's timestamp differs from `staleTimestamp`. */
export async function waitForFreshTimestamp(
  page: Page,
  staleTimestamp: string | null,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string | null> {
  return waitForTimestamp(
    page,
    (timestamp) => Boolean(timestamp) && timestamp !== staleTimestamp,
    options,
  );
}

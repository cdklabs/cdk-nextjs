import { Page } from "@playwright/test";

/**
 * Gets the stable server-side render timestamp from the page's title attribute.
 * This timestamp doesn't change via JavaScript, making it reliable for testing cache behavior.
 *
 * @returns ISO timestamp string (e.g., "2026-01-20T03:37:37.907Z") or null if not found
 */
export async function getPageTimestamp(page: Page): Promise<string | null> {
  try {
    // The timestamp is in the title attribute of the time display element
    const timestamp = await page
      .locator("div[title]")
      .first()
      .getAttribute("title");
    return timestamp;
  } catch (error) {
    console.warn("Failed to get page timestamp:", error);
    return null;
  }
}

/**
 * Checks if a timestamp is recent (within the specified seconds).
 * Useful for verifying fresh renders vs cached content.
 */
export function isTimestampRecent(
  timestamp: string | null,
  withinSeconds: number = 10,
): boolean {
  if (!timestamp) return false;

  const timestampDate = new Date(timestamp);
  const now = new Date();
  const ageInSeconds = (now.getTime() - timestampDate.getTime()) / 1000;

  return ageInSeconds <= withinSeconds;
}

/**
 * Gets the age of a timestamp in seconds
 */
export function getTimestampAge(timestamp: string | null): number | null {
  if (!timestamp) return null;

  const timestampDate = new Date(timestamp);
  const now = new Date();
  return (now.getTime() - timestampDate.getTime()) / 1000;
}

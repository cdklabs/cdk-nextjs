/**
 * Comparing the Next.js version an app was built with. Pure, so the adapter and
 * runtime bundles can import it as well as the constructs.
 */

/**
 * Whether `nextVersion` - `ctx.nextVersion`, as `16.3.8` or `16.4.0-canary.2` -
 * is at least `min`, compared on major, minor and patch (a prerelease counts as
 * its release). `undefined` when it does not parse.
 */
export function isNextVersionAtLeast(
  nextVersion: string | undefined,
  min: readonly [number, number, number],
): boolean | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(nextVersion ?? "");
  if (!match) {
    return undefined;
  }
  const version = match.slice(1).map(Number);
  const differs = version.findIndex((part, i) => part !== min[i]);
  return differs === -1 || version[differs] > min[differs];
}

/** The first Next.js to scope response-cache keys by source route. */
export const ROUTE_CACHE_KEYS_VERSION = [16, 3, 8] as const;

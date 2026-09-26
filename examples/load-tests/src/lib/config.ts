/**
 * Everything the k6 scripts read from the environment. `scripts/k6.sh` loads
 * `.env` first, so these can live there or on the command line.
 */

function required(name: string): string {
  const value = __ENV[name];
  if (!value) throw new Error(`${name} is not set. See examples/load-tests/README.md`);
  return value;
}

function optional(name: string, fallback: string): string {
  return __ENV[name] || fallback;
}

/** Deployed app URL, including any base path (e.g. `/prod` on NextjsRegionalFunctions). */
export const BASE_URL = required("BASE_URL").replace(/\/+$/, "");
/** Scheme and host of BASE_URL, for the root-relative asset URLs found in the HTML. */
export const ORIGIN = /^https?:\/\/[^/]+/.exec(BASE_URL)![0];
/** The construct under test, e.g. `global-functions`. Names the results directory. */
export const LABEL = required("LABEL");

/**
 * Sent on every request, for deployments that gate access on a cookie (the
 * NextjsRegionalContainers example requires `cdk-nextjs=1`).
 */
export const COOKIE = __ENV["COOKIE"] || "";

export function numbers(name: string, fallback: number[]): number[] {
  return optional(name, fallback.join(","))
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => value > 0);
}

export function number(name: string, fallback: number): number {
  return Number(optional(name, String(fallback)));
}

export function strings(name: string, fallback: string[]): string[] {
  return optional(name, fallback.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

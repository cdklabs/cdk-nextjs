import { check } from "k6";
import http from "k6/http";
import { Counter } from "k6/metrics";
import { COOKIE } from "./config.ts";
import { Kind, Target } from "./routes.ts";

/**
 * Counts responses by who answered them, so a latency number can be read
 * knowing whether it measured CloudFront's cache or the construct's compute.
 */
export const cacheResult = new Counter("cache_result");

export const CF_RESULTS = ["hit", "refresh", "miss", "error", "none"] as const;
export const NEXT_RESULTS = ["HIT", "STALE", "MISS", "none", "other"] as const;

export function request(kind: Kind, target: Target): void {
  const res = http.get(target.url, {
    headers: { ...target.headers, ...(COOKIE ? { Cookie: COOKIE } : {}) },
    tags: { name: kind },
  });
  check(res, { "status is 200": (r) => r.status === 200 });
  cacheResult.add(1, {
    cf: cloudFrontResult(res.headers["X-Cache"]),
    next: nextResult(res.headers["X-Nextjs-Cache"]),
  });
}

function cloudFrontResult(header: string | undefined): (typeof CF_RESULTS)[number] {
  if (!header) return "none";
  const value = header.toLowerCase();
  if (value.startsWith("hit")) return "hit";
  if (value.startsWith("refreshhit")) return "refresh";
  if (value.startsWith("miss")) return "miss";
  return "error";
}

function nextResult(header: string | undefined): (typeof NEXT_RESULTS)[number] {
  if (!header) return "none";
  const value = header.toUpperCase();
  return (NEXT_RESULTS as readonly string[]).includes(value)
    ? (value as (typeof NEXT_RESULTS)[number])
    : "other";
}

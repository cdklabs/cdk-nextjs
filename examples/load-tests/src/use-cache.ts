import { check } from "k6";
import http from "k6/http";
import { Options, Scenario } from "k6/options";
import { BASE_URL, COOKIE, number } from "./lib/config.ts";
import { ScenarioMeta, scenarioThresholds, summarize, SUMMARY_TREND_STATS } from "./lib/summary.ts";

/**
 * `'use cache'` with many tags per instance: RATE req/s spread over
 * `/use-cache/0` to `/use-cache/<TAGS - 1>` (one tag each, so every instance
 * ends up tracking about TAGS of them), while REVALIDATE_RATE req/s of
 * `revalidateTag` go to random ones. What it's for is the revalidation table's
 * reads per instance, which k6 can't see: read `ConsumedReadCapacityUnits` and
 * `ReadThrottleEvents` from CloudWatch for the run (see README). The latencies
 * are here to show the tag checks don't cost the request anything.
 */
const TAGS = number("TAGS", 1000);
const RATE = number("RATE", 200);
const REVALIDATE_RATE = number("REVALIDATE_RATE", 1);
const DURATION_SECONDS = number("DURATION_SECONDS", 600);

const steps: ScenarioMeta[] = [
  { name: "use_cache", kind: "use-cache", rate: RATE, durationSeconds: DURATION_SECONDS },
  { name: "revalidate", kind: "revalidate", rate: REVALIDATE_RATE, durationSeconds: DURATION_SECONDS },
];

const scenarios: Record<string, Scenario> = {};
for (const { name, rate } of steps) {
  scenarios[name] = {
    executor: "constant-arrival-rate",
    rate,
    timeUnit: "1s",
    duration: `${DURATION_SECONDS}s`,
    preAllocatedVUs: Math.ceil(rate / 10) + 5,
    maxVUs: Math.max(20, rate),
    exec: name,
  };
}

export const options: Options = {
  discardResponseBodies: true,
  summaryTrendStats: SUMMARY_TREND_STATS,
  scenarios,
  thresholds: scenarioThresholds(steps),
};

const headers: Record<string, string> = COOKIE ? { Cookie: COOKIE } : {};
const item = () => Math.floor(Math.random() * TAGS);

export function setup(): void {
  const res = http.get(`${BASE_URL}/use-cache/0`, { headers, responseType: "text", tags: { name: "setup" } });
  if (res.status !== 200 || typeof res.body !== "string" || !res.body.includes('data-bench="use-cache"')) {
    throw new Error(`${BASE_URL}/use-cache/0 answered ${res.status}; is the bench app deployed with /use-cache?`);
  }
}

export function use_cache(): void {
  const res = http.get(`${BASE_URL}/use-cache/${item()}`, { headers, tags: { name: "use-cache" } });
  check(res, { "status is 200": (r) => r.status === 200 });
}

export function revalidate(): void {
  const res = http.post(`${BASE_URL}/api/revalidate-item?n=${item()}`, null, {
    headers,
    tags: { name: "revalidate" },
  });
  check(res, { "status is 200": (r) => r.status === 200 });
}

export function handleSummary(data: Parameters<typeof summarize>[3]) {
  return summarize("use-cache", { TAGS, RATE, REVALIDATE_RATE, DURATION_SECONDS }, steps, data);
}

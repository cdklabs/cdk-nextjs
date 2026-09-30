import { Options } from "k6/options";
import { browserFlow, browserThresholds, BROWSER_OPTIONS } from "./lib/browser-flow.ts";
import { number } from "./lib/config.ts";
import { summarize, SUMMARY_TREND_STATS } from "./lib/summary.ts";

/**
 * Web Vitals from real Chromium visitors. For vitals under load, run this from
 * a second machine while `pnpm latency` runs on the first, and set UNDER_LOAD to
 * describe that load (e.g. "50 req/s per route") for the report. Running both
 * on one machine skews the HTTP numbers, since each browser is a Chromium.
 */
const VUS = number("VUS", 2);
const DURATION_SECONDS = number("DURATION_SECONDS", 120);
const UNDER_LOAD = __ENV["UNDER_LOAD"] || "";

export const options: Options = {
  summaryTrendStats: SUMMARY_TREND_STATS,
  scenarios: {
    browser: {
      executor: "constant-vus",
      vus: VUS,
      duration: `${DURATION_SECONDS}s`,
      options: BROWSER_OPTIONS,
    },
  },
  thresholds: browserThresholds(),
};

export default async function (): Promise<void> {
  await browserFlow();
}

export function handleSummary(data: Parameters<typeof summarize>[3]) {
  return summarize("browser", { VUS, DURATION_SECONDS, UNDER_LOAD }, [], data);
}

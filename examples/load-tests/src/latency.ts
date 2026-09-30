import exec from "k6/execution";
import { Options, Scenario } from "k6/options";
import { browserFlow, browserThresholds, BROWSER_OPTIONS } from "./lib/browser-flow.ts";
import { number, numbers, strings } from "./lib/config.ts";
import { request } from "./lib/request.ts";
import { discoverTargets, Kind, KINDS, parseKinds, Targets } from "./lib/routes.ts";
import { ScenarioMeta, scenarioThresholds, summarize, SUMMARY_TREND_STATS } from "./lib/summary.ts";

/**
 * Latency at fixed request rates. For each rate in RATES, every kind in KINDS
 * runs at that rate for STEP_SECONDS, all kinds at once (so the total offered
 * load is rate x kinds). A WARMUP_SECONDS lead-in, not reported, absorbs cold
 * starts; `pnpm cold-start` measures those on their own.
 *
 * BROWSER_VUS > 0 adds that many k6 browser visitors for the whole run, which
 * reports Web Vitals as seen under the load. Each is a Chromium, and at high
 * rates they take enough of the load generator's CPU to skew the HTTP numbers:
 * prefer a separate `pnpm browser` run.
 */
// Rates every construct serves, so all four compare directly. The Functions
// constructs are also worth running at 250 and 1000; two 1 vCPU container tasks
// are not.
const RATES = numbers("RATES", [10, 50]);
const RUN_KINDS = parseKinds(strings("KINDS", [...KINDS]));
const STEP_SECONDS = number("STEP_SECONDS", 180);
const WARMUP_SECONDS = number("WARMUP_SECONDS", 30);
const BROWSER_VUS = number("BROWSER_VUS", 0);

const measured: ScenarioMeta[] = RATES.flatMap((rate) =>
  RUN_KINDS.map((kind) => ({ name: `${kind}_r${rate}`, kind, rate, durationSeconds: STEP_SECONDS })),
);

const scenarios: Record<string, Scenario> = {};
for (const kind of RUN_KINDS) {
  scenarios[`${kind}_warmup`] = arrival(10, WARMUP_SECONDS, 0);
}
measured.forEach((meta) => {
  const step = RATES.indexOf(meta.rate);
  scenarios[meta.name] = arrival(meta.rate, STEP_SECONDS, WARMUP_SECONDS + step * STEP_SECONDS);
});
if (BROWSER_VUS > 0) {
  scenarios["browser"] = {
    executor: "constant-vus",
    vus: BROWSER_VUS,
    duration: `${WARMUP_SECONDS + RATES.length * STEP_SECONDS}s`,
    exec: "browser",
    options: BROWSER_OPTIONS,
  };
}

export const options: Options = {
  discardResponseBodies: true,
  summaryTrendStats: SUMMARY_TREND_STATS,
  scenarios,
  thresholds: {
    ...scenarioThresholds(measured),
    ...(BROWSER_VUS > 0 ? browserThresholds() : {}),
  },
};

function arrival(rate: number, seconds: number, startSeconds: number): Scenario {
  return {
    executor: "constant-arrival-rate",
    rate,
    timeUnit: "1s",
    duration: `${seconds}s`,
    startTime: `${startSeconds}s`,
    // Ready for a 100 ms mean latency. Allocating many more than needed makes
    // k6 itself slow: at 8,000 req/s, 4,000 VUs add ~100 ms to p99 that 400
    // don't.
    preAllocatedVUs: Math.ceil(rate / 10) + 5,
    // Enough for a 1 s mean latency. Past that k6 drops iterations instead, and
    // `dropped_iterations` in the results says the target could not keep up.
    maxVUs: Math.max(20, rate),
    exec: "run",
  };
}

export function setup(): Targets {
  return discoverTargets();
}

export function run(targets: Targets): void {
  const name = exec.scenario.name;
  const kind = name.slice(0, name.lastIndexOf("_")) as Kind;
  request(kind, targets[kind]);
}

export async function browser(): Promise<void> {
  await browserFlow();
}

export function handleSummary(data: Parameters<typeof summarize>[3]) {
  return summarize(
    "latency",
    { RATES, KINDS: RUN_KINDS, STEP_SECONDS, WARMUP_SECONDS, BROWSER_VUS },
    measured,
    data,
  );
}

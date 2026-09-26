import exec from "k6/execution";
import { Options, Scenario } from "k6/options";
import { number, strings } from "./lib/config.ts";
import { request } from "./lib/request.ts";
import { discoverTargets, Kind, parseKinds, Targets } from "./lib/routes.ts";
import { ScenarioMeta, scenarioThresholds, summarize, SUMMARY_TREND_STATS, Thresholds } from "./lib/summary.ts";

/**
 * The highest request rate a construct sustains for one kind. Steps up from
 * START_RATE by FACTOR every STEP_SECONDS until MAX_RATE, and aborts once a
 * step is clearly broken (ABORT_ERROR_RATE errors, or p99 over ABORT_P99_MS) so
 * the target is not hammered past the point of learning anything. The report
 * applies the real SLO (`scripts/report.ts`) to each completed step.
 */
const KIND = parseKinds(strings("KIND", ["ssr"]))[0]!;
const START_RATE = number("START_RATE", 50);
const FACTOR = number("FACTOR", 1.5);
const MAX_RATE = number("MAX_RATE", 8000);
const STEP_SECONDS = number("STEP_SECONDS", 60);
const ABORT_ERROR_RATE = number("ABORT_ERROR_RATE", 0.1);
const ABORT_P99_MS = number("ABORT_P99_MS", 5000);

const steps: ScenarioMeta[] = [];
for (let rate = START_RATE; rate <= MAX_RATE; rate = Math.round(rate * FACTOR)) {
  steps.push({ name: `${KIND}_r${rate}`, kind: KIND, rate, durationSeconds: STEP_SECONDS });
}

const scenarios: Record<string, Scenario> = {};
const abort: Thresholds = {};
steps.forEach(({ name, rate }, step) => {
  scenarios[name] = {
    executor: "constant-arrival-rate",
    rate,
    timeUnit: "1s",
    duration: `${STEP_SECONDS}s`,
    startTime: `${step * STEP_SECONDS}s`,
    // Ready for a 100 ms mean latency. Allocating many more than needed makes
    // k6 itself slow: at 8,000 req/s, 4,000 VUs add ~100 ms to p99 that 400
    // don't.
    preAllocatedVUs: Math.ceil(rate / 10) + 5,
    // enough for a 1 s mean latency, past the SLO: slower than that is a failed step
    maxVUs: Math.max(20, rate),
    exec: "run",
  };
  const delayAbortEval = `${Math.round(STEP_SECONDS / 3)}s`;
  abort[`http_req_failed{scenario:${name}}`] = [
    { threshold: `rate<${ABORT_ERROR_RATE}`, abortOnFail: true, delayAbortEval },
  ];
  abort[`http_req_duration{scenario:${name}}`] = [
    { threshold: `p(99)<${ABORT_P99_MS}`, abortOnFail: true, delayAbortEval },
  ];
});

export const options: Options = {
  discardResponseBodies: true,
  summaryTrendStats: SUMMARY_TREND_STATS,
  scenarios,
  thresholds: scenarioThresholds(steps, abort),
};

export function setup(): Targets {
  return discoverTargets();
}

export function run(targets: Targets): void {
  const name = exec.scenario.name;
  const kind = name.slice(0, name.lastIndexOf("_")) as Kind;
  request(kind, targets[kind]);
}

export function handleSummary(data: Parameters<typeof summarize>[3]) {
  return summarize(
    `capacity-${KIND}`,
    { KIND, START_RATE, FACTOR, MAX_RATE, STEP_SECONDS, ABORT_ERROR_RATE, ABORT_P99_MS },
    steps,
    data,
  );
}

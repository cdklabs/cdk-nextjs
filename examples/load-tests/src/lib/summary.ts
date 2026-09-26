import { BASE_URL, LABEL } from "./config.ts";
import { cacheResult, CF_RESULTS, NEXT_RESULTS } from "./request.ts";
import { Kind } from "./routes.ts";

export const SUMMARY_TREND_STATS = [
  "avg",
  "min",
  "med",
  "p(75)",
  "p(90)",
  "p(95)",
  "p(99)",
  "p(99.9)",
  "max",
  "count",
];

export interface ScenarioMeta {
  name: string;
  /** A route kind, or one of the `use-cache` script's own requests. */
  kind: Kind | "use-cache" | "revalidate";
  rate: number;
  durationSeconds: number;
}

type Threshold = string | { threshold: string; abortOnFail?: boolean; delayAbortEval?: string };
export type Thresholds = Record<string, Threshold[]>;

/**
 * k6 only reports a per-scenario breakdown for submetrics that some threshold
 * names, so every measured scenario gets always-passing thresholds on the
 * metrics the report reads. Real thresholds (e.g. capacity's abort conditions)
 * are merged in on top.
 */
export function scenarioThresholds(scenarios: ScenarioMeta[], extra: Thresholds = {}): Thresholds {
  const thresholds: Thresholds = {};
  const add = (key: string, value: Threshold) => (thresholds[key] ??= []).push(value);
  for (const { name } of scenarios) {
    add(`http_req_duration{scenario:${name}}`, "max>=0");
    add(`http_req_waiting{scenario:${name}}`, "max>=0");
    add(`http_req_failed{scenario:${name}}`, "rate>=0");
    add(`http_reqs{scenario:${name}}`, "count>=0");
    add(`dropped_iterations{scenario:${name}}`, "count>=0");
    for (const cf of CF_RESULTS) add(`${cacheResult.name}{scenario:${name},cf:${cf}}`, "count>=0");
    for (const next of NEXT_RESULTS) add(`${cacheResult.name}{scenario:${name},next:${next}}`, "count>=0");
  }
  for (const [key, values] of Object.entries(extra)) for (const value of values) add(key, value);
  return thresholds;
}

type Values = Record<string, number>;
interface SummaryData {
  metrics: Record<string, { values: Values; thresholds?: Record<string, { ok: boolean }> }>;
  state: { testRunDurationMs: number };
}

export interface ScenarioResult extends ScenarioMeta {
  requests: number;
  failedRate: number;
  dropped: number;
  duration: Values;
  ttfb: Values;
  cloudFront: Record<string, number>;
  next: Record<string, number>;
}

export interface Results {
  label: string;
  script: string;
  baseUrl: string;
  finishedAt: string;
  testRunDurationMs: number;
  config: Record<string, unknown>;
  scenarios: ScenarioResult[];
  /** Metric name -> tag value -> trend values, for the browser metrics. */
  browser: Record<string, Record<string, Values>>;
}

export function summarize(
  script: string,
  config: Record<string, unknown>,
  scenarios: ScenarioMeta[],
  data: SummaryData,
): Record<string, string> {
  const metric = (key: string): Values => data.metrics[key]?.values ?? {};
  const results: Results = {
    label: LABEL,
    script,
    baseUrl: BASE_URL,
    finishedAt: new Date().toISOString(),
    testRunDurationMs: data.state.testRunDurationMs,
    config,
    scenarios: scenarios
      .map((meta) => {
        const tag = `scenario:${meta.name}`;
        return {
          ...meta,
          requests: metric(`http_reqs{${tag}}`)["count"] ?? 0,
          failedRate: metric(`http_req_failed{${tag}}`)["rate"] ?? 0,
          dropped: metric(`dropped_iterations{${tag}}`)["count"] ?? 0,
          duration: metric(`http_req_duration{${tag}}`),
          ttfb: metric(`http_req_waiting{${tag}}`),
          cloudFront: Object.fromEntries(
            CF_RESULTS.map((cf) => [cf, metric(`${cacheResult.name}{${tag},cf:${cf}}`)["count"] ?? 0]),
          ),
          next: Object.fromEntries(
            NEXT_RESULTS.map((next) => [next, metric(`${cacheResult.name}{${tag},next:${next}}`)["count"] ?? 0]),
          ),
        };
      })
      // a capacity run aborts partway, leaving later steps that never started
      .filter((result) => result.requests > 0),
    browser: browserMetrics(data),
  };
  const stamp = results.finishedAt.replace(/[:.]/g, "-");
  if (!results.scenarios.length && !Object.keys(results.browser).length) {
    // setup() failed, or the run was stopped before anything was measured
    return { stdout: table(results) };
  }
  return {
    [`results/${LABEL}/${script}-${stamp}.json`]: JSON.stringify(results, null, 2),
    stdout: table(results),
  };
}

function browserMetrics(data: SummaryData): Results["browser"] {
  const browser: Results["browser"] = {};
  for (const [key, { values }] of Object.entries(data.metrics)) {
    const match = /^(browser_[a-z_]+)\{(?:name|route):([^}]+)\}$/.exec(key);
    if (!match || !values["count"]) continue;
    (browser[match[1]!] ??= {})[match[2]!] = values;
  }
  return browser;
}

function table(results: Results): string {
  const ms = (value: number | undefined) => (value === undefined ? "-" : value.toFixed(1)).padStart(8);
  const lines = [
    `\n${results.script} ${results.label} ${results.baseUrl}`,
    `${"scenario".padEnd(22)}${"reqs".padStart(9)}${"p50".padStart(8)}${"p95".padStart(8)}${"p99".padStart(8)}${"ttfb50".padStart(8)}${"err%".padStart(7)}${"drop".padStart(7)}  cf hit%`,
  ];
  for (const s of results.scenarios) {
    const cfTotal = Object.values(s.cloudFront).reduce((a, b) => a + b, 0);
    const cfHit = cfTotal ? ((s.cloudFront["hit"]! + s.cloudFront["refresh"]!) / cfTotal) * 100 : 0;
    lines.push(
      `${s.name.padEnd(22)}${String(s.requests).padStart(9)}${ms(s.duration["med"])}${ms(s.duration["p(95)"])}${ms(s.duration["p(99)"])}${ms(s.ttfb["med"])}${(s.failedRate * 100).toFixed(2).padStart(7)}${String(s.dropped).padStart(7)}  ${cfHit.toFixed(0)}`,
    );
  }
  for (const [name, byTag] of Object.entries(results.browser)) {
    for (const [tag, values] of Object.entries(byTag)) {
      lines.push(`${`${name}{${tag}}`.padEnd(40)} p75=${ms(values["p(75)"])} p95=${ms(values["p(95)"])} n=${values["count"] ?? 0}`);
    }
  }
  return lines.join("\n") + "\n";
}

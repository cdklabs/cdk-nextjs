/**
 * Turns results/<construct>/*.json into the markdown tables in the README's
 * Performance section: a summary comparing the four constructs, then each
 * construct's detail. The newest file of each script per construct wins;
 * result directories not named after a construct are skipped.
 *
 * Writes results/report.md and prints it.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ColdStartResults } from "./cold-start.ts";

const RESULTS_DIR = join(import.meta.dirname, "..", "results");
/** A capacity step passes if it met both of these for its whole duration. */
const SLO_P99_MS = Number(process.env["SLO_P99_MS"] ?? 1000);
const SLO_ERROR_RATE = Number(process.env["SLO_ERROR_RATE"] ?? 0.01);

const CONSTRUCTS: Record<string, string> = {
  "global-functions": "NextjsGlobalFunctions",
  "global-containers": "NextjsGlobalContainers",
  "regional-containers": "NextjsRegionalContainers",
  "regional-functions": "NextjsRegionalFunctions",
};
const KIND_ORDER = ["static-asset", "static", "isr", "ssr", "stream", "rsc", "api", "image"];
const BROWSER_ROUTES = ["static", "ssr", "isr", "stream", "image"];

type Values = Record<string, number>;
interface ScenarioResult {
  kind: string;
  rate: number;
  requests: number;
  failedRate: number;
  dropped: number;
  duration: Values;
  ttfb: Values;
  cloudFront: Record<string, number>;
}
interface K6Results {
  script: string;
  config: Record<string, unknown>;
  scenarios: ScenarioResult[];
  browser: Record<string, Record<string, Values>>;
}
type Results = Map<string, K6Results | ColdStartResults>;

const constructs = new Map<string, Results>();
for (const dir of readdirSync(RESULTS_DIR, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  if (!CONSTRUCTS[dir.name]) {
    console.error(`skipping results/${dir.name}: not a construct name`);
    continue;
  }
  const results: Results = new Map();
  for (const file of readdirSync(join(RESULTS_DIR, dir.name)).sort()) {
    if (!file.endsWith(".json")) continue;
    const parsed = JSON.parse(readFileSync(join(RESULTS_DIR, dir.name, file), "utf8")) as K6Results;
    results.set(parsed.script, parsed); // sorted by timestamp, so the newest wins
  }
  constructs.set(dir.name, results);
}
const names = Object.keys(CONSTRUCTS).filter((name) => constructs.has(name));
if (!names.length) {
  console.error(`No results under ${RESULTS_DIR}`);
  process.exit(1);
}

const out: string[] = [];
summaryTable();
for (const name of names) constructSection(name, constructs.get(name)!);
const markdown = out.join("\n") + "\n";
writeFileSync(join(RESULTS_DIR, "report.md"), markdown);
console.log(markdown);

function ms(value: number | undefined): string {
  return value === undefined ? "–" : value < 10 ? value.toFixed(1) : value.toFixed(0);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(value && value < 0.01 ? 2 : 0)}%`;
}

function latency(results: Results): K6Results | undefined {
  return results.get("latency") as K6Results | undefined;
}

function scenario(results: Results, kind: string, rate: number): ScenarioResult | undefined {
  return latency(results)?.scenarios.find((s) => s.kind === kind && s.rate === rate);
}

function clean(s: ScenarioResult): boolean {
  return s.failedRate < SLO_ERROR_RATE && s.dropped <= s.requests * SLO_ERROR_RATE;
}

function cell(s: ScenarioResult | undefined): string {
  if (!s) return "–";
  const flag = clean(s) ? "" : ` ⚠️ ${pct(s.failedRate)} errors, ${pct(s.dropped / (s.requests + s.dropped))} dropped`;
  return `${ms(s.duration["med"])} / ${ms(s.duration["p(99)"])}${flag}`;
}

/** Highest capacity step that met the SLO, as text. */
function capacity(results: Results, kind: string): string {
  const run = results.get(`capacity-${kind}`) as K6Results | undefined;
  if (!run) return "–";
  const passed = run.scenarios.filter((s) => clean(s) && (s.duration["p(99)"] ?? Infinity) < SLO_P99_MS);
  const best = passed.at(-1)?.rate;
  if (best === undefined) return `< ${run.scenarios[0]?.rate ?? "?"} req/s`;
  // The top step passed: the load generator ran out, not the construct.
  const topped = run.scenarios.at(-1)!.rate * Number(run.config["FACTOR"]) > Number(run.config["MAX_RATE"]);
  return passed.at(-1) === run.scenarios.at(-1) && topped ? `≥ ${best} req/s` : `${best} req/s`;
}

function coldStart(results: Results): ColdStartResults | undefined {
  return results.get("cold-start") as ColdStartResults | undefined;
}

function summaryTable(): void {
  const rates = [...new Set(names.flatMap((name) => latency(constructs.get(name)!)?.scenarios.map((s) => s.rate) ?? []))]
    .filter((rate) => names.every((name) => latency(constructs.get(name)!)?.scenarios.some((s) => s.rate === rate)))
    .sort((a, b) => a - b);
  out.push(
    `| Construct | ${rates.map((rate) => `\`ssr\` at ${rate} req/s`).join(" | ")} | \`ssr\` capacity | \`isr\` capacity | Cold start p50 |`,
    `| --- | ${rates.map(() => "---").join(" | ")} | --- | --- | --- |`,
  );
  for (const name of names) {
    const results = constructs.get(name)!;
    const cold = coldStart(results)?.cold.ttfb.p50;
    out.push(
      `| \`${CONSTRUCTS[name]}\` | ${rates.map((rate) => cell(scenario(results, "ssr", rate))).join(" | ")} | ${capacity(results, "ssr")} | ${capacity(results, "isr")} | ${cold === undefined ? "–" : `${ms(cold)} ms`} |`,
    );
  }
  out.push(
    "",
    `_Latency is p50 / p99 in ms, with every route loaded at that rate at once. Capacity is the highest rate sustained with p99 under ${SLO_P99_MS} ms and under ${pct(SLO_ERROR_RATE)} errors._`,
    "",
  );
}

function constructSection(name: string, results: Results): void {
  out.push(`### ${CONSTRUCTS[name]}`, "");
  const run = latency(results);
  const rates = [...new Set(run?.scenarios.map((s) => s.rate) ?? [])].sort((a, b) => a - b);
  if (run && rates.length) {
    out.push(
      "Latency per route, p50 / p99 in ms, with every route at the same rate at once:",
      "",
      `| Route | ${rates.map((rate) => `${rate} req/s`).join(" | ")} | CDN hits |`,
      `| --- | ${rates.map(() => "---").join(" | ")} | --- |`,
    );
    for (const kind of KIND_ORDER) {
      const cells = rates.map((rate) => scenario(results, kind, rate));
      if (!cells.some(Boolean)) continue;
      out.push(`| ${kind} | ${cells.map(cell).join(" | ")} | ${cdnHits(cells.find(Boolean)!)} |`);
      if (kind === "stream") {
        out.push(
          `| stream (TTFB) | ${cells.map((s) => (s ? `${ms(s.ttfb["med"])} / ${ms(s.ttfb["p(99)"])}` : "–")).join(" | ")} | |`,
        );
      }
    }
    out.push("");
  }

  const kinds = [...results.keys()].filter((key) => key.startsWith("capacity-")).map((key) => key.slice("capacity-".length));
  if (kinds.length) {
    out.push(
      `Capacity: ${kinds.sort().map((kind) => `\`${kind}\` ${capacity(results, kind)}`).join(", ")}.`,
      "",
    );
  }

  const cold = coldStart(results);
  if (cold) {
    out.push(
      `Cold start, time to first byte of \`/ssr\` on a new execution environment: p50 ${ms(cold.cold.ttfb.p50)} ms, p90 ${ms(cold.cold.ttfb.p90)} ms (warm: ${ms(cold.warm.ttfb.p50)} ms).`,
      "",
    );
  }

  const browser = browserOf(results);
  if (browser) {
    out.push(
      `Browser, p75 in ms${browser.load ? `, under ${browser.load}` : ""}:`,
      "",
      "| Route | LCP | TTFB | Client-side navigation |",
      "| --- | --- | --- | --- |",
    );
    for (const route of BROWSER_ROUTES) {
      const p75 = (metric: string) => ms(browser.data[metric]?.[route]?.["p(75)"]);
      out.push(
        `| ${route} | ${p75("browser_web_vital_lcp")} | ${p75("browser_web_vital_ttfb")} | ${p75("browser_nav_duration")} |`,
      );
    }
    out.push("");
  }
}

function cdnHits(s: ScenarioResult): string {
  const total = Object.values(s.cloudFront).reduce((a, b) => a + b, 0);
  if (!total || s.cloudFront["none"] === total) return "no CDN";
  return pct(((s.cloudFront["hit"] ?? 0) + (s.cloudFront["refresh"] ?? 0)) / total);
}

/** Vitals measured during the latency run if there are any, else a browser run's. */
function browserOf(results: Results): { data: K6Results["browser"]; load: string } | undefined {
  const loaded = latency(results)?.browser;
  if (loaded && Object.keys(loaded).length) return { data: loaded, load: "the latency run's load" };
  const run = results.get("browser") as K6Results | undefined;
  if (!run || !Object.keys(run.browser).length) return undefined;
  return { data: run.browser, load: String(run.config["UNDER_LOAD"] ?? "") };
}

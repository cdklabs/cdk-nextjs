/**
 * Cold start latency, as a client sees it, for the Functions constructs.
 *
 * Each round forces every Lambda function in STACK onto fresh execution
 * environments (by changing an environment variable, which retires the old
 * ones), then sends CONCURRENCY requests at once to ROUTE: each needs a new
 * environment, so each pays a cold start. Straight after, it sends CONCURRENCY
 * more, which land on those now-warm environments, for comparison. The
 * function's environment variables are put back when it finishes.
 *
 * This changes live function configuration: point it only at test stacks.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { stats, type Stats } from "./stats.ts";

const STACK = required("STACK");
const BASE_URL = required("BASE_URL").replace(/\/+$/, "");
const LABEL = required("LABEL");
const ROUNDS = Number(process.env["ROUNDS"] ?? 5);
const CONCURRENCY = Number(process.env["CONCURRENCY"] ?? 10);
const ROUTE = process.env["ROUTE"] ?? "/ssr";
const MARKER = "CDK_NEXTJS_BENCH_COLD_START";

interface Sample {
  status: number;
  ttfbMs: number;
  totalMs: number;
}

export interface ColdStartResults {
  label: string;
  script: "cold-start";
  baseUrl: string;
  finishedAt: string;
  config: Record<string, unknown>;
  functions: string[];
  cold: { ttfb: Stats; total: Stats; errors: number };
  warm: { ttfb: Stats; total: Stats; errors: number };
}

const functions = listFunctions();
console.log(`Functions in ${STACK}:\n  ${functions.join("\n  ")}`);
// Without the marker, in case an interrupted earlier run left it behind
const originals = new Map(
  functions.map((name) => {
    const { [MARKER]: _, ...variables } = getVariables(name);
    return [name, variables];
  }),
);

const cold: Sample[] = [];
const warm: Sample[] = [];
try {
  for (let round = 1; round <= ROUNDS; round++) {
    for (const name of functions) {
      setVariables(name, { ...originals.get(name), [MARKER]: `${Date.now()}` });
    }
    const coldRound = await burst();
    const warmRound = await burst();
    cold.push(...coldRound);
    warm.push(...warmRound);
    console.log(
      `round ${round}/${ROUNDS}: cold ttfb p50 ${stats(coldRound.map((s) => s.ttfbMs)).p50.toFixed(0)} ms, ` +
        `warm ttfb p50 ${stats(warmRound.map((s) => s.ttfbMs)).p50.toFixed(0)} ms`,
    );
  }
} finally {
  for (const name of functions) setVariables(name, originals.get(name)!);
}

const summary = (samples: Sample[]) => {
  const ok = samples.filter((s) => s.status === 200);
  return {
    ttfb: stats(ok.map((s) => s.ttfbMs)),
    total: stats(ok.map((s) => s.totalMs)),
    errors: samples.length - ok.length,
  };
};
const results: ColdStartResults = {
  label: LABEL,
  script: "cold-start",
  baseUrl: BASE_URL,
  finishedAt: new Date().toISOString(),
  config: { STACK, ROUNDS, CONCURRENCY, ROUTE },
  functions,
  cold: summary(cold),
  warm: summary(warm),
};
const dir = join(import.meta.dirname, "..", "results", LABEL);
mkdirSync(dir, { recursive: true });
const file = join(dir, `cold-start-${results.finishedAt.replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(results, null, 2));
console.log(JSON.stringify({ cold: results.cold, warm: results.warm }, null, 2));
console.log(`Wrote ${file}`);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. See examples/load-tests/README.md`);
  return value;
}

function aws(...args: string[]): string {
  // stderr straight through, so a failed call says why
  return execFileSync("aws", [...args, "--output", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/** The app's functions, not the stack's custom resource and deployment helpers. */
function listFunctions(): string[] {
  const resources = JSON.parse(
    aws("cloudformation", "list-stack-resources", "--stack-name", STACK),
  ) as { StackResourceSummaries: { LogicalResourceId: string; PhysicalResourceId: string; ResourceType: string }[] };
  const names = resources.StackResourceSummaries.filter(
    (r) => r.ResourceType === "AWS::Lambda::Function" && r.LogicalResourceId.includes("NextjsFunctions"),
  ).map((r) => r.PhysicalResourceId);
  if (!names.length) throw new Error(`No NextjsFunctions Lambda functions in ${STACK}`);
  return names;
}

function getVariables(name: string): Record<string, string> {
  const config = JSON.parse(aws("lambda", "get-function-configuration", "--function-name", name)) as {
    Environment?: { Variables?: Record<string, string> };
  };
  return config.Environment?.Variables ?? {};
}

function setVariables(name: string, variables: Record<string, string>): void {
  aws(
    "lambda",
    "update-function-configuration",
    "--function-name",
    name,
    "--environment",
    JSON.stringify({ Variables: variables }),
  );
  execFileSync("aws", ["lambda", "wait", "function-updated-v2", "--function-name", name], {
    stdio: ["ignore", "ignore", "inherit"],
  });
}

function burst(): Promise<Sample[]> {
  return Promise.all(Array.from({ length: CONCURRENCY }, () => get(`${BASE_URL}${ROUTE}`)));
}

/** One request on its own connection, so no sample reuses another's TLS handshake. */
function get(url: string): Promise<Sample> {
  const send = url.startsWith("https:") ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    const start = performance.now();
    let ttfbMs = 0;
    const cookie = process.env["COOKIE"] ? { cookie: process.env["COOKIE"] } : {};
    const req = send(url, { agent: false, headers: { "accept-encoding": "gzip", ...cookie } }, (res) => {
      ttfbMs = performance.now() - start;
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, ttfbMs, totalMs: performance.now() - start }));
    });
    req.setTimeout(60_000, () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve({ status: 0, ttfbMs, totalMs: performance.now() - start }));
    req.end();
  });
}

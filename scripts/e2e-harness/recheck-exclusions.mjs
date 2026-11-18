#!/usr/bin/env node
/**
 * Lists the harness exclusions whose next.js test changed between two refs.
 *
 *   node scripts/e2e-harness/recheck-exclusions.mjs <manifest> <old-ref> <new-ref>
 *
 * Every exclusion in `test/deploy-tests-manifest.json` is a verdict on one
 * version of an upstream test: the cases in `suites`, the files and cases in
 * `rules.excludeByType`, and the path-keyed `excluded-notes`. When the
 * `@next/routing` pin moves, an entry whose test was rewritten may pass now (or
 * skip a case that no longer exists), and nothing else would say so. This
 * compares, at both refs, the test file's blob and its directory's tree, which
 * holds the fixtures, and prints a Markdown report of the entries to re-check.
 * The `harness-exclusions` workflow posts it on the PR that bumps the pin.
 *
 * A directory change can come from a sibling test in the same directory, so
 * "fixtures changed" is a prompt to look, not a verdict. Reads the GitHub API,
 * with `GITHUB_TOKEN` or `GH_TOKEN` when set. Always exits 0 once it has
 * reported; a missing ref or a truncated tree exits 1.
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

const [manifestPath, oldRef, newRef] = process.argv.slice(2);
if (!manifestPath || !oldRef || !newRef) {
  console.error("usage: recheck-exclusions.mjs <manifest> <old-ref> <new-ref>");
  process.exit(2);
}

const REPO = "vercel/next.js";
const ROOT = "test/e2e";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

async function github(path) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Every blob and tree under `test/e2e` at `ref`, as path → object sha. */
async function e2eTree(ref) {
  const test = await github(`contents/test?ref=${encodeURIComponent(ref)}`);
  const e2e = test.find((entry) => entry.name === "e2e");
  if (!e2e) throw new Error(`${ROOT} not found at ${ref}`);
  const tree = await github(`git/trees/${e2e.sha}?recursive=1`);
  if (tree.truncated) {
    throw new Error(`the ${ROOT} tree at ${ref} is truncated by the API`);
  }
  const shas = new Map([[ROOT, e2e.sha]]);
  for (const { path, sha } of tree.tree) shas.set(`${ROOT}/${path}`, sha);
  return shas;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Excluded path → where in the manifest it is excluded. */
function exclusions(manifest) {
  const where = new Map();
  const add = (path, label) =>
    where.set(path, [...(where.get(path) ?? []), label]);
  for (const [file, entry] of Object.entries(manifest.suites ?? {})) {
    const cases = [...(entry.failed ?? []), ...(entry.flakey ?? [])].length;
    if (cases > 0) add(file, `suites (${plural(cases, "case")})`);
  }
  for (const [type, entries] of Object.entries(
    manifest.rules?.excludeByType ?? {},
  )) {
    if (type === "comment") continue;
    for (const [file, entry] of Object.entries(entries)) {
      if (file === "comment") continue;
      add(
        file,
        entry.failed?.length
          ? `excludeByType.${type} (${plural(entry.failed.length, "case")})`
          : `excludeByType.${type} (whole file)`,
      );
    }
  }
  // Prose keys ("edge runtime, generally") name no one test to compare.
  for (const key of Object.keys(manifest["excluded-notes"] ?? {})) {
    if (key.startsWith(`${ROOT}/`)) add(key, "excluded-notes");
  }
  return where;
}

/** How `path` differs between the two trees, or undefined if it does not. */
function change(path, before, after) {
  if (path.endsWith("/**")) {
    const dir = path.slice(0, -3);
    if (!after.has(dir)) return "removed";
    return before.get(dir) === after.get(dir) ? undefined : "directory changed";
  }
  if (!after.has(path)) return "removed";
  if (before.get(path) !== after.get(path)) return "test changed";
  const dir = dirname(path);
  return before.get(dir) === after.get(dir) ? undefined : "fixtures changed";
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const [before, after] = await Promise.all([e2eTree(oldRef), e2eTree(newRef)]);

const changed = [];
for (const [path, labels] of exclusions(manifest)) {
  const kind = change(path, before, after);
  if (kind) changed.push({ path, labels, kind });
}

const compare = `https://github.com/${REPO}/compare/${oldRef}...${newRef}`;
const lines = [
  `### Harness exclusions to re-check: [${oldRef}...${newRef}](${compare})`,
  "",
];
if (changed.length === 0) {
  lines.push(
    "No excluded test, or its directory, changed. Every exclusion in",
    "`test/deploy-tests-manifest.json` still applies to the same upstream code.",
  );
} else {
  lines.push(
    `${plural(changed.length, "excluded test")} changed upstream. Each may pass now: run it`,
    "with `test_filters` on the harness, then drop or update the entry and its",
    "verdict in `docs/harness-coverage.md`.",
    "",
    "| Test | Change | Excluded in |",
    "| ---- | ------ | ----------- |",
  );
  for (const { path, labels, kind } of changed) {
    const history = `https://github.com/${REPO}/commits/${newRef}/${path.replace(/\/\*\*$/, "")}`;
    lines.push(
      `| [\`${path}\`](${history}) | ${kind} | ${labels.join(", ")} |`,
    );
  }
}
console.log(lines.join("\n"));

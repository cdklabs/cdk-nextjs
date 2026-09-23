#!/usr/bin/env node
/**
 * Screen vercel/next.js's e2e suite for harness candidates, and keep the
 * `screening` block in `test/deploy-tests-manifest.json` honest.
 *
 *   node scripts/e2e-harness/screen.mjs --next ../next.js            # print the funnel
 *   node scripts/e2e-harness/screen.mjs --next ../next.js --check    # fail if stale
 *   node scripts/e2e-harness/screen.mjs --next ../next.js --write    # update the manifest
 *   node scripts/e2e-harness/screen.mjs --next ../next.js --list cache
 *
 * Why this exists rather than a number typed into a doc: the funnel moves every
 * time next.js is upgraded, and a stale count is indistinguishable from a
 * measured one. `--check` is what makes the recorded overview trustworthy.
 *
 * The disqualifying screens are the ones in this directory's README, in the
 * order that costs least to apply:
 *
 * - **edge / middleware** — cdk-nextjs throws during `next build` for any
 *   non-`nodejs` runtime (`assertNodeRuntimes`), so the fixture is unbuildable
 *   and no per-case `failed` entry can rescue it.
 * - **skipped-upstream** — `describe.skip`, so the file reports "passing" in
 *   seconds without deploying anything. Adding it claims coverage that does not
 *   exist. This one over-reports, because the match is textual and some skips are
 *   conditional: `incremental-cache-path-traversal` writes
 *   `(process.env.__NEXT_CACHE_COMPONENTS ? describe.skip : describe)`, which the
 *   harness does not set, so the file does run and did find a real defect. A file
 *   disqualified only by this screen is worth re-reading before it is dismissed.
 * - **skipDeployment** — the same trap, spelled in the `nextTestSetup` call:
 *   next.js replaces the whole file with `it.only('should skip next deploy')`.
 *   The costliest screen to have been missing — it covers 236 of what were
 *   otherwise counted as candidates, and two files had already been added to
 *   `rules.include` on the strength of a 4s "pass".
 * - **mode-gated** — the third spelling of the same trap, and the one that cost a
 *   deploy slot to find: the file's real cases sit inside `if (isNextStart)` or
 *   `if (isNextDev)`, and every other mode gets an empty
 *   `it('should skip …', () => {})`. `app-fetch-deduping` reported a pass in 5.9s
 *   having deployed nothing. A stub whose title names *dev* is the opposite case
 *   — the file runs everywhere but dev, `app-prefetch-static` being one — so
 *   those are left in.
 * - **isNextDeploy-gate** — usually next.js itself gating out what cannot work
 *   behind a CDN. Not always disqualifying; read the gate before dismissing it.
 * - **output-export** — a static export is not what any `NextjsType` deploys.
 * - **scaffold** — `test-template/{{ toFileName name }}`, a `pnpm new-test`
 *   template rather than a test.
 *
 * "Clean" means only that none of those apply. It is a candidate list, not a
 * prediction: a clean file still has to be deployed and watched before it goes
 * into `rules.include`.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = join(repoRoot, "test", "deploy-tests-manifest.json");
const TEST_ROOT = "test/e2e";
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_RE = /\.test\.[tj]sx?$/;
/**
 * Both spellings that pin a route to the edge runtime: app router's
 * `export const runtime = 'edge'` and pages router's
 * `export const config = { runtime: 'experimental-edge' }`. Matching only the
 * first undercounts by ~17 files.
 */
const EDGE_RUNTIME_RE = /runtime\s*[:=]\s*['"](experimental-)?edge['"]/;
/**
 * An empty `it('should skip …', () => {})` — next.js's stub for the modes a
 * mode-gated file does not cover. `dev` in the title means dev is the excluded
 * mode and deploy is not, so those are deliberately not matched.
 */
const MODE_GATED_STUB_RE =
  /it\(\s*(['"`])should skip (?!.*\bdev\b)[^'"`]*\1\s*,\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const nextDir = resolve(value("next") ?? join(repoRoot, "..", "next.js"));

/** Every file under `dir`, skipping build output. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

/**
 * The test file's text, plus the text of every sibling module it pulls in with a
 * relative `import`/`require`, two levels deep. `nextTestSetup` is not always
 * called in the test file: `app-dir/cache-components-errors` has thirteen files
 * that call it through a `shared.util.ts`, or that are a two-line
 * `require('./client.test')` wrapper, and every one of them reported a 4s "pass"
 * having deployed nothing. Two levels is what those two shapes need.
 */
function testSourceText(testFile, depth = 2, seen = new Set()) {
  if (seen.has(testFile)) return "";
  seen.add(testFile);
  const text = read(testFile);
  if (depth === 0) return text;
  const dir = dirname(testFile);
  const specifiers = [...text.matchAll(/(?:from\s*|require\(\s*)['"](\.[^'"]*)['"]/g)];
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
  return [
    text,
    ...specifiers.flatMap(([, specifier]) => {
      for (const extension of extensions) {
        const candidate = join(dir, specifier + extension);
        if (existsSync(candidate) && !statSync(candidate).isDirectory()) {
          return testSourceText(candidate, depth - 1, seen);
        }
      }
      return [];
    }),
  ].join("\n");
}

/**
 * The fixture for a test file. For `test/e2e/<name>/test/index.test.ts` it lives
 * a directory *above* the test file, and screening only the test file's own
 * directory quietly misses its `middleware.js`.
 */
function fixtureRoot(testFile) {
  const dir = dirname(testFile);
  return basename(dir) === "test" ? dirname(dir) : dir;
}

/** Which of the screens disqualify this file, if any. */
function screen(testFile) {
  const reasons = [];
  const test = read(testFile);
  const fixture = walk(fixtureRoot(testFile));
  const sources = fixture.filter((p) => SOURCE_RE.test(p));

  if (fixture.some((p) => /\/middleware\.[tj]sx?$/.test(p))) {
    reasons.push("middleware");
  }
  if (sources.some((p) => EDGE_RUNTIME_RE.test(read(p)))) reasons.push("edge");
  if (/describe\.skip/.test(test)) reasons.push("skipped-upstream");
  // An empty `it('should skip …', () => {})` is what next.js writes for the modes
  // a mode-gated file does not cover. Deploy mode is one of them unless the stub
  // is the *dev*-only one, in which case the file runs here.
  if (MODE_GATED_STUB_RE.test(test)) reasons.push("mode-gated");
  if (/isNextDeploy/.test(test)) reasons.push("isNextDeploy-gate");
  // `nextTestSetup({ skipDeployment: true })` returns `skipped`, the file
  // early-returns, and jest reports it as passing in ~4s having deployed
  // nothing. next.js declaring a file out of scope for deploy mode is the same
  // signal as `isNextDeploy`, just spelled in the setup call.
  // Read through relative imports for this one screen only. `skipDeployment: true`
  // in a shared helper replaces every file that calls it, so following the import
  // cannot over-report; the mode gates above can, since a helper's `isNextDev`
  // branch may cover only some of a file's cases.
  if (/skipDeployment:\s*true/.test(testSourceText(testFile))) {
    reasons.push("skipDeployment");
  }
  // `test/e2e/**/test-template/{{ toFileName name }}/…` is a scaffold for
  // `pnpm new-test`, not a test.
  if (testFile.includes("{{")) reasons.push("scaffold");
  if (sources.some((p) => /output:\s*['"]export['"]/.test(read(p)))) {
    reasons.push("output-export");
  }
  return reasons;
}

process.chdir(nextDir);
const testFiles = walk(TEST_ROOT).filter((p) => TEST_RE.test(p));
if (testFiles.length === 0) {
  console.error(`No e2e tests under ${join(nextDir, TEST_ROOT)}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const included = new Set(manifest.rules.include);
/**
 * A file in `suites` runs too - minus its named cases - so it is neither a
 * candidate nor an unscreened file.
 */
const inPart = new Set(Object.keys(manifest.suites ?? {}));

const rows = testFiles.map((file) => ({
  file,
  included: included.has(file) || inPart.has(file),
  reasons: screen(file),
  cases: (read(file).match(/^\s*it(\.each)?\(/gm) ?? []).length,
}));

const candidates = rows.filter((r) => !r.included && r.reasons.length === 0);
const tally = {};
for (const row of rows) {
  if (row.included) continue;
  for (const reason of row.reasons) tally[reason] = (tally[reason] ?? 0) + 1;
}
/** The ceiling on what could ever run here, edge being the hard limitation. */
const edgeFree = rows.filter(
  (r) => !r.reasons.includes("edge") && !r.reasons.includes("middleware"),
).length;

const screening = {
  comment: [
    "Regenerate with `node scripts/e2e-harness/screen.mjs --next ../next.js --write`,",
    "and `--check` to verify these numbers still hold. Not read by next.js's",
    "test/get-test-filter.js, which only looks at `version`, `suites` and `rules`.",
    "",
    "`candidates` is what is left after the screens below, all of which are",
    "explained in scripts/e2e-harness/README.md. A candidate is a file worth",
    "spending a deploy on - not a file expected to pass. Nothing enters",
    "`rules.include` until it has been watched to pass against a real deployment,",
    "and anything that fails gets a verdict in docs/harness-coverage.md.",
    "",
    "`included-in-part` counts files in `suites`: run, minus the cases named in",
    "their `failed` arrays. They are excluded from `candidates` too.",
    "",
    "`disqualified-by` counts overlap - a fixture can ship edge middleware *and*",
    "be skipped upstream - so the values sum to more than `e2e-files` minus",
    "`candidates` minus `included`.",
  ],
  "next-version": JSON.parse(
    readFileSync(join(nextDir, "packages", "next", "package.json"), "utf8"),
  ).version,
  "e2e-files": rows.length,
  included: included.size,
  "included-in-part": inPart.size,
  "edge-free": edgeFree,
  candidates: candidates.length,
  "disqualified-by": Object.fromEntries(
    Object.entries(tally).sort((a, b) => b[1] - a[1]),
  ),
};

if (flag("list")) {
  const pattern = value("list");
  for (const row of candidates) {
    if (!pattern || row.file.includes(pattern)) {
      console.log(`${String(row.cases).padStart(3)}  ${row.file}`);
    }
  }
  process.exit(0);
}

console.log(JSON.stringify(screening, null, 2));

if (flag("write")) {
  writeFileSync(
    MANIFEST,
    `${JSON.stringify({ ...manifest, screening }, null, 2)}\n`,
  );
  console.log(`\nWrote ${MANIFEST}`);
} else if (flag("check")) {
  const recorded = JSON.stringify(manifest.screening);
  if (recorded !== JSON.stringify(screening)) {
    console.error(
      "\nThe manifest's `screening` block is stale. Re-run with --write.",
    );
    process.exit(1);
  }
  console.log("\n`screening` is up to date.");
}

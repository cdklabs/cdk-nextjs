#!/usr/bin/env node
/**
 * Writes the manifest overlay that applies one NextjsType's exclusions.
 *
 *   node scripts/e2e-harness/type-filters.mjs <manifest> <nextjs-type> <out>
 *
 * `rules.excludeByType` in `test/deploy-tests-manifest.json` maps a type to the
 * files, or cases within a file, that the harness cannot pass on that type for
 * a reason docs/harness-coverage.md records - never a cdk-nextjs defect, which
 * is a bug to fix. next.js's `test/get-test-filter.js` reads only
 * `rules.include`/`rules.exclude` and `suites`, but it merges every manifest in
 * the comma-separated NEXT_EXTERNAL_TESTS_FILTERS, and an exclusion by filename
 * beats an inclusion. So this writes one more manifest for that list:
 *
 * - an entry with no `failed` excludes the whole file (`rules.exclude`);
 * - an entry with `failed` skips those cases and runs the rest (`suites`), the
 *   same mechanism as a `suites` entry in the manifest itself.
 *
 * A manifest without `rules.excludeByType`, or a type without an entry, gets an
 * overlay that changes nothing, so a custom `test_filters` still works.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [manifestPath, nextjsType, outPath] = process.argv.slice(2);
if (!manifestPath || !nextjsType || !outPath) {
  console.error("usage: type-filters.mjs <manifest> <nextjs-type> <out>");
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const entries = manifest.rules?.excludeByType?.[nextjsType] ?? {};

const overlay = { version: 2, suites: {}, rules: { include: [], exclude: [] } };
for (const [file, entry] of Object.entries(entries)) {
  if (file === "comment") continue;
  if (entry.failed?.length) {
    overlay.suites[file] = { failed: entry.failed, flakey: [] };
  } else {
    overlay.rules.exclude.push(file);
  }
}

writeFileSync(outPath, `${JSON.stringify(overlay, null, 2)}\n`);
console.log(
  `harness: ${nextjsType} excludes ${overlay.rules.exclude.length} files and ` +
    `cases in ${Object.keys(overlay.suites).length} more`,
);

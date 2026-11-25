// The deterministic parts of self-review's publish step (references/publish.md): the verdict, and
// the note's history of earlier runs. (status.sh sets the commit status.)
//
//   node publish.mts verdict <ledger>
//   node publish.mts note <note file> <earlier note file, or -> <out file>
//
// Run from the repo's root.
//
// verdict: prints the verdict, then why, on two lines. It's `success` only when the ledger's
//   `Outcome:` line is `converged at <sha>`, that sha is HEAD's, and no blocking Findings row (a
//   `bug`, `rule`, `spec` or `design` row at medium or high) is still `escalated` or `fix`
//   (decided, not yet made); otherwise `failure`. The second line is `converged at <sha>`,
//   `outcome: <the Outcome line>`, `converged at <sha>, but HEAD is <sha>`, or `open findings:
//   <IDs>`.
// note: the note, with `Earlier runs: <sha> <outcome> · …` at its end: the earlier note's SHA and
//   outcome, then that note's own earlier runs, newest first, ten at most, a run at the note's own
//   SHA included; the same note published again keeps the history it had. With `-`, the note is
//   written as it is. An earlier note that doesn't start `**/self-review** at <sha>` (edited by
//   hand) has no history to give: the note is written without one, and it prints `history
//   dropped`.
//
// Exit 3, with a message: the ledger breaks its contract (references/ledger.md), or has no
// `Outcome:` line. Exit 1: a file or git couldn't be read. Exit 2: bad arguments, or a note file
// that doesn't start `**/self-review** at <sha>`.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { ContractError, isBlockingKind, parseLedger } from "./design-check.mts";

const USAGE = `usage: node publish.mts verdict <ledger>
       node publish.mts note <note file> <earlier note file, or -> <out file>`;

/** Bad arguments, or input of the wrong shape: exit 2. */
export class UsageError extends Error {}

const NOTE_HEAD = /^\*\*\/self-review\*\* at ([0-9a-f]{7,40})\b/;
const EARLIER = /^Earlier runs: (.*)$/m;
const MAX_EARLIER = 10;

/** The verdict and why, from the ledger's text and HEAD's full SHA. */
export function verdict(ledger: string, head: string): [string, string] {
  const outcome = ledger.match(/^Outcome:[ \t]*(.*?)[ \t]*$/m);
  if (!outcome) throw new ContractError("the ledger has no Outcome: line");
  const { rows } = parseLedger(ledger);
  const open = rows.filter((r) => isBlockingKind(r) && /^(?:escalated|fix)\b/.test(r.status)).map((r) => r.id);
  const converged = outcome[1].match(/^converged at ([0-9a-f]{7,40})\b/);
  if (!converged) return ["failure", `outcome: ${outcome[1]}`];
  if (!head.startsWith(converged[1])) return ["failure", `converged at ${converged[1]}, but HEAD is ${head.slice(0, converged[1].length)}`];
  if (open.length) return ["failure", `open findings: ${open.join(", ")}`];
  return ["success", `converged at ${converged[1]}`];
}

/** An earlier note's run, `<sha> <outcome>`, then the runs its own history lists; null if it
 * doesn't start as this skill's notes do. */
function runsOf(earlier: string): string[] | null {
  const head = earlier.trimStart().match(NOTE_HEAD);
  if (!head) return null;
  // The Outcome line as the note gives it, bold or not; its first words name the outcome.
  const line = earlier.match(/^[ \t*_>-]*Outcome(?::[*_]*|[*_]+:)[ \t]*(.+)$/m)?.[1] ?? "";
  const named = line.replace(/^[`*_\s]+/, "").match(/^(converged|stalled|capped|checks failed|stopped|nothing to review|in progress)\b/i);
  const outcome = named ? named[1].toLowerCase() : "unknown";
  const prior = earlier.match(EARLIER)?.[1].split(" · ").map((s) => s.trim()).filter(Boolean) ?? [];
  return [`${head[1]} ${outcome}`, ...prior];
}

/** The note without its `Earlier runs:` line, or the blank lines before it. */
function withoutHistory(note: string): string {
  return note.replace(new RegExp(`\\n*${EARLIER.source}\\n?`, "m"), "\n");
}

/** The note's text for comparing two copies of it: without its history, with LF line endings, and
 * no trailing spaces. */
function comparable(note: string): string {
  return withoutHistory(note.replace(/\r\n/g, "\n")).replace(/[ \t]+$/gm, "").trim();
}

/** The note with its `Earlier runs:` line, from the note it replaces (null if none). */
export function withHistory(note: string, earlier: string | null): string {
  if (!note.trimStart().match(NOTE_HEAD)) throw new UsageError("the note doesn't start **/self-review** at <sha>");
  if (earlier === null) return note;
  const text = withoutHistory(note).replace(/\s+$/, "");
  // Every earlier run, a rerun at the same SHA's too: an edit leaves no other trace of it. The same
  // note published again isn't a run of its own: keep the history it already has.
  const runs = runsOf(earlier);
  if (runs === null) return `${text}\n`;
  const same = comparable(earlier) === comparable(note);
  const list = (same ? runs.slice(1) : runs).slice(0, MAX_EARLIER);
  if (!list.length) return `${text}\n`;
  return `${text}\n\nEarlier runs: ${list.join(" · ")}\n`;
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`can't read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function headSha(): string {
  const p = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (p.status !== 0) throw new Error("can't read HEAD: run it in the repo");
  return p.stdout.trim();
}

/** Runs one subcommand; returns its output lines and exit status. */
export function run(args: string[]): [string[], number] {
  const [cmd, ...rest] = args;
  if (cmd === "verdict" && rest.length === 1) return [verdict(read(rest[0]), headSha()), 0];
  if (cmd === "note" && rest.length === 3) {
    const [noteFile, earlierFile, outFile] = rest;
    const earlier = earlierFile === "-" ? null : read(earlierFile);
    writeFileSync(outFile, withHistory(read(noteFile), earlier));
    return [earlier !== null && !NOTE_HEAD.test(earlier.trimStart()) ? ["history dropped"] : [], 0];
  }
  throw new UsageError(USAGE);
}

function main(): void {
  try {
    const [lines, status] = run(process.argv.slice(2));
    for (const l of lines) console.log(l);
    process.exitCode = status;
  } catch (e) {
    console.error(e instanceof UsageError && e.message === USAGE ? USAGE : `publish.mts: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = e instanceof UsageError ? 2 : e instanceof ContractError ? 3 : 1;
  }
}

// import.meta.main is undefined before Node.js 24.2, where the script would silently do nothing.
if (import.meta.main === undefined) {
  console.error(`publish.mts: Node.js 24.2 or later is needed; this is ${process.version}`);
  process.exit(1);
}
if (import.meta.main) main();

// List the files whose review findings suggest a design problem, not a line-level one: the
// trigger for self-review's design check (SKILL.md §5 names the thresholds; this header has
// their detail, and which rows count).
//
//   node design-check.mts <ledger>     run from the repo's root
//
// Prints one line per file that trips, `<file>\t<why>`, and nothing if none does. A file trips when
// either holds:
//
// - repeated: it has rows of kind bug, rule or spec, at medium or high, in ROUNDS or more rounds;
// - growing: over the last WINDOW rounds whose commits (the Rounds table's Commit cells) touch it,
//   not counting the round that added it, it grew by a net GROWTH or more of its size before them,
//   while its findings, of any kind, aren't tailing off: it has rows in each of those rounds, and
//   more in the last than half as many as in the first.
//
// Rows that are `duplicate` or `invalid` don't count, and nor do rows whose location is `-` or
// isn't a file at HEAD. A file with a `design` row still `escalated` is skipped (it's already
// waiting on the user); once one is decided (`accepted:`, `fix` or `fixed`), only later rounds
// count.
//
// It reads only the cells the ledger template's contract fixes (references/ledger.md, after the template):
// the ID, Round, Kind, Severity, Location and Status cells, by name, and the Rounds table's Round
// and Commit cells. Finding and Detail are free text it never parses.
//
// Exit 3, naming the row: the ledger breaks that contract. Exit 1, with a message: the ledger or a
// commit couldn't be read. Exit 2: bad arguments.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const ROUNDS = 3;
export const WINDOW = 3;
export const GROWTH = 0.2;

const KINDS = ["bug", "rule", "spec", "cleanup", "smell", "design"];
const SEVERITIES = ["high", "medium", "low"];
// `smell` is what ledgers written before `noted` called a noted smell.
const STATUS = /^(?:(?:duplicate|invalid|noted|smell|escalated|fixed|fix)\b|accepted:)/;
const FINDINGS_HEADER = ["ID", "Round", "Kind", "Severity", "Location", "Status"];
const LOCATION = /^(?!\.{0,2}\/)([^\s`:|]+)(?::\d+)?$/;
const COMMITS = /^[0-9a-f]{7,40}(?: [0-9a-f]{7,40})*$/;

/** A ledger row that breaks the template's contract. */
export class ContractError extends Error {}

export interface Row {
  id: string;
  round: number;
  kind: string;
  severity: string;
  status: string;
  /** The location's file, or null for `-`. */
  file: string | null;
}

export interface Ledger {
  rows: Row[];
  /** Each round's commits, from the Rounds table. */
  commits: Map<number, string[]>;
}

/** A round's change to one file, summed over its commits. */
export interface RoundChange {
  round: number;
  added: number;
  deleted: number;
  /** The round added the file. */
  created: boolean;
  /** The file's line count before the round. */
  sizeBefore: number;
}

/** The header and body rows of the table under `## <heading>`, each split into trimmed cells. */
function table(text: string, heading: string): { header: string[]; body: [string, string[]][] } {
  const parts = text.split(new RegExp(`^## ${heading}\\s*$`, "m"));
  if (parts.length < 2) throw new ContractError(`the ledger has no ## ${heading} section`);
  const lines: string[] = [];
  for (const line of parts[1].split("\n")) {
    if (line.startsWith("#")) break;
    if (line.startsWith("|")) lines.push(line);
  }
  const split = (line: string) => line.split("|").slice(1, -1).map((c) => c.trim());
  const [header = [], ...rest] = lines.map(split);
  const body = rest.map((cells, i): [string, string[]] => [lines[i + 1], cells])
    .filter(([, cells]) => !cells.every((c) => /^:?-*:?$/.test(c)));
  return { header, body };
}

/** The ledger's Findings rows and each round's commits. Throws ContractError naming a bad row. */
export function parseLedger(text: string): Ledger {
  const findings = table(text, "Findings");
  // By name, so an older ledger (Location before Finding) reads too. The template puts these first,
  // with Status, the only one holding a reason, last, so a pipe in a free-text cell can't shift
  // Location. In an older ledger it can, and a shifted Location that names no file drops its row.
  const cols = FINDINGS_HEADER.map((h) => findings.header.indexOf(h));
  const missing = FINDINGS_HEADER.filter((_, i) => cols[i] < 0);
  if (missing.length) throw new ContractError(`the Findings table has no ${missing.join(", ")} column`);
  const rows = findings.body.map(([line, cells]): Row => {
    const [id, round, kind, severity, location, status] = cols.map((i) => cells[i]);
    const bad = (what: string) => new ContractError(`${what} in the Findings row: ${line}`);
    if (!/^\d+$/.test(round ?? "")) throw bad("a Round that isn't a number");
    if (!STATUS.test(status ?? "")) throw bad("a Status that doesn't start with one of §2's");
    // §2 records a duplicate's ID only, and nothing counts an invalid row: the rest goes unread.
    if (/^(duplicate|invalid)\b/.test(status)) return { id, round: Number(round), kind, severity, status, file: null };
    if (!KINDS.includes(kind)) throw bad(`a Kind that isn't one of ${KINDS.join(", ")}`);
    if (!SEVERITIES.includes(severity)) throw bad(`a Severity that isn't ${SEVERITIES.join(", ")}`);
    if (location === "-") return { id, round: Number(round), kind, severity, status, file: null };
    const m = location?.match(LOCATION);
    if (!m) throw bad("a Location that isn't a repo-relative path, path:line or -");
    return { id, round: Number(round), kind, severity, status, file: m[1] };
  });

  const rounds = table(text, "Rounds");
  const at = rounds.header.indexOf("Commit");
  if (rounds.header[0] !== "Round" || at < 0) throw new ContractError("the Rounds table has no Round and Commit columns");
  const commits = new Map<number, string[]>();
  for (const [line, cells] of rounds.body) {
    // An empty cell is an older ledger's way of saying no commit.
    const [round, commit] = [cells[0], cells[at] || "-"];
    if (!/^\d+$/.test(round ?? "") || !(commit === "-" || COMMITS.test(commit))) {
      throw new ContractError(`a Round that isn't a number, or a Commit that isn't short SHAs or -, in the Rounds row: ${line}`);
    }
    if (commit !== "-") commits.set(Number(round), [...(commits.get(Number(round)) ?? []), ...commit.split(" ")]);
  }
  // A commit listed twice, in one round or two, counts once, in the first round that lists it.
  const seen = new Set<string>();
  for (const [round, shas] of [...commits].sort(([a], [b]) => a - b)) {
    const fresh = shas.filter((sha) => !seen.has(sha) && seen.add(sha));
    if (fresh.length) commits.set(round, fresh);
    else commits.delete(round);
  }
  return { rows, commits };
}

const isLive = (r: Row) => !/^(duplicate|invalid)\b/.test(r.status) && r.kind !== "design";
/** A row of a kind that blocks (SKILL.md §5), at medium or high: a bug, rule or spec finding, or a
 * design row (always high). Whether it still blocks is its status's to say: a design row only until
 * it's decided. */
export const isBlockingKind = (r: Row) => ["bug", "rule", "spec", "design"].includes(r.kind) && r.severity !== "low";
const isSettled = (r: Row) => /^(accepted:|fix)/.test(r.status);

/** The files the rows name, in the order they first appear. */
export const ledgerFiles = (rows: Row[]) => [...new Set(rows.flatMap((r) => (r.file ? [r.file] : [])))];

/** The files that trip, each with why, in the order they first appear in the ledger. */
export function check(rows: Row[], changes: Map<string, RoundChange[]>, isFile: (f: string) => boolean): [string, string][] {
  const trips: [string, string][] = [];
  for (const file of ledgerFiles(rows)) {
    if (!isFile(file)) continue;
    const own = rows.filter((r) => r.file === file);
    const designs = own.filter((r) => r.kind === "design");
    if (designs.some((r) => /^escalated\b/.test(r.status))) continue;
    const since = Math.max(0, ...designs.filter(isSettled).map((r) => r.round));
    const live = own.filter((r) => r.round > since && isLive(r));
    const why: string[] = [];

    // Each reason names the rows it counted, which are what the design reviewer gets.
    const ids = (counted: Row[]) => `: ${counted.map((r) => r.id).join(", ")}`;
    // `live` has no design rows, so these are bug, rule and spec rows only.
    const rounds = [...new Set(live.filter(isBlockingKind).map((r) => r.round))].sort((a, b) => a - b);
    if (rounds.length >= ROUNDS) {
      why.push(`medium or high bug, rule or spec findings in rounds ${rounds.join(", ")}${ids(live.filter(isBlockingKind))}`);
    }

    const window = (changes.get(file) ?? []).filter((c) => c.round > since && !c.created).slice(-WINDOW);
    if (window.length === WINDOW) {
      const net = window.reduce((n, c) => n + c.added - c.deleted, 0);
      const first = window[0];
      const found = window.map((c) => live.filter((r) => r.round === c.round).length);
      const steady = found.every((n) => n > 0) && found[found.length - 1] * 2 > found[0];
      if (net > 0 && net >= GROWTH * first.sizeBefore && steady) {
        const share = first.sizeBefore ? ` (${Math.round((100 * net) / first.sizeBefore)}% of ${first.sizeBefore})` : "";
        why.push(`grew by ${net} lines${share} over rounds ` +
          `${window.map((c) => c.round).join(", ")}' fixes, findings ${found.join(", ")}` +
          ids(live.filter((r) => window.some((c) => c.round === r.round))));
      }
    }
    if (why.length) trips.push([file, why.join("; ")]);
  }
  return trips;
}

function git(args: string[]): { ok: boolean; status: number | null; out: string } {
  const p = spawnSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  if (p.error) throw new Error(`can't run git: ${p.error.message}`);
  return { ok: p.status === 0, status: p.status, out: p.stdout ?? "" };
}

const lineCount = (text: string) => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));

/** Each listed file's change in each round's commits, in round order. */
function roundChanges(commits: Map<number, string[]>, files: Set<string>): Map<string, RoundChange[]> {
  const changes = new Map<string, RoundChange[]>();
  for (const round of [...commits.keys()].sort((a, b) => a - b)) {
    const unreadable = (sha: string) =>
      new Error(`can't read round ${round}'s commit ${sha} or its parent; if history was rewritten, set its Commit cell to -`);
    // A commit history rewriting left behind isn't the branch's any more; one git can't read is
    // an error, since skipping it would read as nothing tripping.
    const onBranch = commits.get(round)!.filter((sha) => {
      const p = git(["merge-base", "--is-ancestor", sha, "HEAD"]);
      if (p.status !== 1 && !p.ok) throw unreadable(sha);
      return p.ok;
    });
    // Oldest first, so the round's first commit gives the file's size before it: by how many
    // commits each has behind it (an ancestor always has fewer), then by SHA, a total order.
    const depth = new Map(onBranch.map((sha) => [sha, Number(git(["rev-list", "--count", sha]).out)]));
    onBranch.sort((a, b) => depth.get(a)! - depth.get(b)! || a.localeCompare(b));
    for (const sha of onBranch) {
      const stat = git(["diff-tree", "--no-commit-id", "-r", "-z", "--no-renames", "--numstat", `${sha}^`, sha]);
      if (!stat.ok) throw unreadable(sha);
      for (const entry of stat.out.split("\0").filter(Boolean)) {
        const [added, deleted, file] = entry.split("\t");
        if (!files.has(file) || added === "-") continue;
        const list = changes.get(file) ?? [];
        const last = list[list.length - 1];
        if (last?.round === round) {
          last.added += Number(added);
          last.deleted += Number(deleted);
          continue;
        }
        const before = git(["cat-file", "-p", `${sha}^:${file}`]);
        list.push({ round, added: Number(added), deleted: Number(deleted), created: !before.ok,
          sizeBefore: before.ok ? lineCount(before.out) : 0 });
        changes.set(file, list);
      }
    }
  }
  return changes;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error("usage: node design-check.mts <ledger>");
    process.exit(2);
  }
  try {
    const { rows, commits } = parseLedger(readFileSync(args[0], "utf8"));
    // Only the ledger's paths, and only files: a submodule's entry is a commit, not a blob.
    const named = ledgerFiles(rows);
    const tree = git(["ls-tree", "-z", "--full-tree", "HEAD", "--", ...named]);
    if (!tree.ok) throw new Error("can't list HEAD's files: run it in the repo");
    const blobs = tree.out.split("\0").filter((e) => / blob [0-9a-f]+\t/.test(e)).map((e) => e.slice(e.indexOf("\t") + 1));
    const files = new Set(named.length ? blobs : []);
    for (const [file, why] of check(rows, roundChanges(commits, files), (f) => files.has(f))) {
      console.log(`${file}\t${why}`);
    }
  } catch (e) {
    console.error(`design-check.mts: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(e instanceof ContractError ? 3 : 1);
  }
}

// import.meta.main is undefined before Node.js 24.2, where the check would silently do nothing.
if (import.meta.main === undefined) {
  console.error(`design-check.mts: Node.js 24.2 or later is needed; this is ${process.version}`);
  process.exit(1);
}
if (import.meta.main) main();

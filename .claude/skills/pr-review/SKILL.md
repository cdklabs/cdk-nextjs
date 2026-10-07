---
name: pr-review
description: Review the current PR branch and fix the findings in rounds until reviews come back clean. Each round, a fresh reviewer runs /code-review high, findings are triaged against a ledger and recorded decisions, accepted ones are fixed, verified and committed. Use when asked to review a PR to convergence, "review and implement it all", or to resume a previous pr-review run.
argument-hint: "[PR#] [--rounds N]"
---

# PR review to convergence

Loop: **review → triage → fix → verify → commit**, until a review finds nothing new or the round cap is hit. Everything stays local until the end: no pushes and no PR comments during the loop.

Arguments: optional PR number (defaults to the current branch's PR), and `--rounds N` (default **5**, counting every review including the final full pass).

## 0. Setup

1. Refuse to run on `main`. The working tree must be clean. If it isn't, stop and ask; do **not** `git stash` (the user keeps real work in the stash).
2. Resolve the PR: `gh pr view [PR#] --json number,title,baseRefName,headRefName`. Run `git fetch origin <baseRefName>`.
3. `FULL_BASE=$(git merge-base origin/<baseRefName> HEAD)`.
4. Ledger: `.claude/pr-review/<branch-with-slashes-as-dashes>.md` (gitignored). If it exists, **resume**: read it, continue the round numbering, and keep every recorded outcome. Otherwise create it from the template at the bottom.
5. **Upstream sources** (`UPSTREAM_SOURCES`): if the branch mirrors, parses or calls code that lives outside this repo, have that code available at the version the branch targets. That covers a package's runtime (`next` itself, `@next/routing`), a restated upstream function (`extractEtag`), and upstream code no package ships, such as the next.js test harness whose `@force-gate` pragmas `screen.mjs` evaluates. Packages are in `node_modules/<pkg>`. Anything else needs a shallow clone at the matching tag, for example `git clone --depth 1 --branch v<version> https://github.com/vercel/next.js /tmp/nextjs-<version>`. Reuse a clone that already exists. Record the paths in the ledger header.
6. Collect **recorded decisions**: read the project memory index (`MEMORY.md`) and every memory describing a deliberate design choice (e.g. "X chosen over Y", "X is kept", "Y rejected"). Add a one-line summary of each to the ledger's *Recorded decisions* section. The triage step checks findings against these.

## 1. Review (fresh subagent every round)

Pick the range:
- **Round 1, and the final pass:** FULL, i.e. `FULL_BASE..HEAD`.
- **Rounds in between:** DELTA, i.e. `<HEAD sha when the previous review started>..HEAD`, which covers just the fix commits.

Spawn **one new** `general-purpose` subagent each round. Never reuse an earlier reviewer, because it would anchor on its own earlier findings. Give it this prompt, filled in:

> Review the changes in `<RANGE>` on branch `<branch>` (PR #<n>: <title>) for correctness bugs.
> Invoke the `code-review` skill with args `high`. **Do not pass `--comment` or `--fix`.**
> That skill may pick its own diff range (it tends to use `@{upstream}...HEAD`, or the remote PR, which lacks local commits). Compare the files it reviewed with `git diff --name-only <RANGE>`. If they differ, or the skill doesn't say, also review `git diff <RANGE>` yourself at the same rigor: read the surrounding code, not just the hunks. Do that review while the skill runs, then **wait for the skill's results before you report**. You can't send anything after you hand back, so results that arrive later are lost.
> Upstream sources, at the version this branch targets: <UPSTREAM_SOURCES>. A finding about how code outside this repo behaves must cite that code. Don't infer the behaviour ("presumably", "as in JS").
> Filter the skill's findings; don't discard them wholesale:
> - **In range:** on lines `<RANGE>` changes. Verify each against the code and report it with your own findings.
> - **Outside range:** elsewhere in code this branch changes (`git diff <FULL_BASE>..HEAD`). Verify each one too, and report it in a separate "outside range" list.
> - **Noise:** in uncommitted or unrelated files. Drop these.
> For a DELTA range: also check that each fix actually resolves the ledger finding it cites, and doesn't break callers outside the diff.
> **Already decided. Don't re-raise these unless the code shows the fix is wrong or incomplete; if so, cite the ledger ID:**
> <paste ledger rows (ID, location, finding, status) + Recorded decisions>
> Return a list. For each finding give: `file:line`, a one-sentence defect, a concrete failure scenario, severity (high/medium/low), and the ledger ID it relates to (if any). Make no edits. If you find nothing, say so explicitly.

Record in the ledger: the round number, range type, range SHAs, and the raw count of findings. Outside-range findings are triaged in the same round as the rest and count toward its totals. If a reviewer reports without the skill's results anyway, note it in the ledger and make the next review a FULL pass.

## 2. Triage (main agent)

Read the cited code for every finding before you classify it. If a finding rests on how code outside this repo behaves (a grammar's precedence, what Next.js passes to a hook), check that code in `UPSTREAM_SOURCES` before you mark it `fix`. A wrong fix costs a revert and another round. Then give it exactly one status:

| Status | When | Action |
|---|---|---|
| `duplicate` | Same issue as an existing ledger row, with nothing new | Drop. Note the ID only |
| `invalid` | The code shows the claim is false | Record the reason |
| `escalated` | Contradicts a recorded decision; or would reverse a fix from an earlier round (oscillation); or the same location has already been fixed in 2+ rounds; or needs a product/API decision (public API break, new dependency, behaviour change users would notice) | Record it. Don't implement. Keep looping |
| `fix` (revert) | Would reverse an earlier round's fix, and the code (this repo's, or upstream code in `UPSTREAM_SOURCES`) shows that fix was wrong. This isn't oscillation, because the earlier fix had no valid basis | Revert it. Mark the earlier row `invalid` (citing the code that proves it wrong) and this one `fix` |
| `fix` | Everything else, at any severity: correctness, performance, simplification, style, test and docs findings | Implement |

Default to `fix`: the user has said "implement it all." Escalate only for the reasons in the table, not because a finding is minor: low-severity fixes rarely break anything, the next review catches it when one does, and unfixed ones add up.

## 3. Fix and verify

1. Implement every `fix` finding. Match the surrounding code. Add or adjust tests when a finding describes a behaviour bug.
2. Verify:
   - `pnpm compile` if JSII sources (`src/`, excluding the bundled runtime code) or struct definitions changed
   - `pnpm bundle` if `src/adapter/`, `src/lambdas/` or `src/nextjs-build/patch-fetch.js` changed
   - `pnpm jest <affected test files>`
   - `pnpm eslint` (whole repo; no file args, no `npx eslint`)
   - **Never `pnpm build`** (docgen hangs; CI regenerates API.md)
3. If a fix can't be made to pass, revert just that fix, mark it `escalated` ("fix broke X: <error>"), and continue.

## 4. Commit and log

1. Commit with `fix: address review round <N>` (use the `test:`/`docs:` prefix if that's all the round touched). The body is one line per fix: `- <ledger ID>: <what changed>`. Never pass `--no-verify`.
2. Update each ledger row with its outcome (`fixed <short sha>`, `invalid: <reason>`, `escalated: <reason>`).

## 5. Convergence

After each round, count the **blocking** findings: those triaged `fix` or `escalated` with severity **medium or high**. Low-severity findings are still fixed (or escalated) and recorded, but don't keep the loop going on their own. `duplicate` and `invalid` don't count.

- A DELTA round with 0 blocking findings → fix any lows, then run the **final FULL pass** next (it reviews those fixes too). If that FULL pass was already the last review, you've converged.
- A FULL round with 0 blocking findings → fix any lows; **converged**. Say in the report that those last fixes weren't reviewed.
- Any blocking findings → run another round (a DELTA review of the new commits).
- The round cap is hit with blocking findings still coming → stop, **not converged**. If the cap leaves room for only one more review, make it the FULL pass.

## 6. Finish

1. Run the full `pnpm test` once.
2. Report to the user:
   - Converged or not, and how many rounds
   - A per-round table: range type, raw findings, new, blocking, fixed, escalated
   - **Escalations needing a decision**: each with ledger ID, `file:line`, the finding, why it was escalated, and your recommendation
   - Any test failures, with their output
3. **Ask** before pushing and before posting the summary. Both are outward-facing. If the user approves, push, then post one condensed ledger comment (rounds table, then fixes grouped by area, then escalations and how they were resolved) with `gh pr comment <n> --body-file <file>`.
4. If the user resolves escalations, record the outcomes in the ledger. If an outcome is a durable design decision, offer to save it as a memory so future runs skip it.

## Ledger template

```markdown
# pr-review ledger: PR #<n> <title>

Branch: <branch> · Base: origin/<base> @ <FULL_BASE short sha>
Upstream sources: <UPSTREAM_SOURCES, or "none">

## Recorded decisions
- <memory slug>: <one line>

## Rounds
| Round | Range | SHAs | Raw | New | Blocking | Fixed | Escalated | Commit |
|---|---|---|---|---|---|---|---|---|

## Findings
| ID | Round | Location | Finding | Status | Detail |
|---|---|---|---|---|---|
| R1-1 | 1 | src/adapter/cache-handler.ts:120 | … | fixed | a1b2c3d |
```

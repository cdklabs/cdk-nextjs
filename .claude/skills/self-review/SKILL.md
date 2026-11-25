---
name: self-review
description: Review your own cdk-nextjs branch before asking a maintainer to review its pull request, fixing, checking and committing what the review finds in rounds until one comes back clean. Fresh reviewers run Claude Code's built-in /code-review high every round, and a standards reviewer and a spec reviewer on the first round and the final pass. On your own open pull request it then pushes the fixes (fast-forward only), puts up its note, and sets a self-review commit status where you have write access; otherwise the fixes stay local. It takes the recommended option where it would ask, bar a few stops (--ask asks instead); --publish-only publishes a finished run. Use before requesting review, when asked to review a branch or PR to convergence, or to resume a previous run.
argument-hint: "[--base BRANCH] [--spec FILE] [--rounds N] [--no-publish | --publish-only] [--ask]"
compatibility: Needs Claude Code, git 2.29, Node.js 24.2 or later, and gh logged in to github.com.
---

# Self-review

The author runs this on their own branch before anyone else is asked to review it. Correctness is
settled here, so the human reviewer can skim the result and spend their attention on intent.

Loop: **review → triage → fix → verify → commit**, until a FULL round comes back clean, the
loop stalls, or it reaches the round cap (§5). Its output is the **ledger**, its record of every
finding and what was decided, and a **note** for the pull request (§6). Whenever it stops, for any
reason, it reports the ledger's path; from §6, also what isn't pushed.

Three rules hold throughout, for you and every reviewer:

- **Never run someone else's code.** This is your own branch, so its tests run; code from anywhere
  else (an upstream clone, say) is read, not run.
- **Never deploy or use cloud credentials, and write to GitHub only in §6's publish step**: on
  your own open pull request only, a fast-forward push, the note and the commit status; someone
  else's pull request is never written to. A finding that only a live system could confirm is
  `escalated`, not tested.
- **Never commit secrets or real identifiers**: credentials, tokens, private keys, and AWS account
  IDs other than placeholders such as `111122223333`.

No one passes `--no-verify`, force-pushes, or skips git's hooks some other way.

Arguments: `--base` (default: the target of the branch's pull request if one exists, else the
default branch), `--spec` (a file to review against), `--rounds N`, a cap counting every review
including the final FULL pass (default 15), `--no-publish`, which skips §6's publish step,
`--publish-only`, which runs only that step, on a finished ledger: read the Publish only section of
`references/publish.md` in this skill's directory before §0, which it trims, and `--ask`.

**Automatic mode**, the default: where a run would stop to ask about a `re-fix` escalation (§2) or
a design rethink (§5), it takes the recommended option, records it under the ledger's Recorded
decisions, and goes on, bar a stop (§2). Before the first such decision, or any escalation in
either mode, read `references/auto.md` in this skill's directory, which defines it, when a stop
applies, and how each decision is recorded. `--ask` turns it off: each such point is an
`escalated` row for the user.

## GitHub

Pull requests live in **`cdklabs/cdk-nextjs`** on github.com, whether the branch is pushed there
or to a fork. Every `gh` command below names it (`-R cdklabs/cdk-nextjs`, or a
`repos/cdklabs/cdk-nextjs/…` path for `gh api`), so none depends on which remote `gh` would pick.
Text goes in from files (`--body-file`, `-F body=@<file>`), so backticks and `$(…)` in it are never
run by the shell. Values go into commands literally: a shell variable doesn't last from one command
to the next. Outside §6's publish step, only reads: `gh api` without `-f`, `-F` or `--input`
(unless with `-X GET`), and `view`/`list` subcommands. **Never** `gh pr review`, `gh pr merge`, or
`gh pr edit` on anyone's pull request.

## 0. Setup

1. **Read GitHub once**, whatever the arguments; every later step that names the branch's pull
   request uses this answer, bar publish's own reads:
   - **You:** `gh api user --jq .login`.
   - **Origin's repository**, `<origin owner>/<origin name>`: from `git remote get-url origin`
     (`https://github.com/<owner>/<name>(.git)` or `git@github.com:<owner>/<name>(.git)`). It's
     `cdklabs/cdk-nextjs`, or your fork of it.
   - **Branch PR**: `gh pr list -R cdklabs/cdk-nextjs --head <branch> --state open --json
     number,title,baseRefName,body,author,headRefOid,headRepository,headRepositoryOwner,isDraft`,
     the entry whose `headRepositoryOwner.login` and `headRepository.name` are origin's (a
     same-named branch in another fork isn't this one). None means the branch has no pull request.

   This skill can work without GitHub, so if `gh` is missing, not logged in, or a read fails, say
   why (a failed lookup isn't the same as no pull request) and go on as if there's no pull request,
   with no more `gh` calls; ask the user for `--base` if the branch targets something other than
   `main`. The report says that issues and threads weren't read.
2. The **default branch** is `git symbolic-ref --short refs/remotes/origin/HEAD` without its
   `origin/`, else `main`. Refuse to run on it. The working tree must be clean; if it isn't, stop
   and ask. Don't `git stash`: the stash is shared with every worktree and session. Run `git fetch
   --prune origin`.
3. **Base:** `--base`, else the branch PR's `baseRefName`, else the default branch. The **base
   commit** is `origin/<base>`'s, unless origin is a fork: a fork's `main` lags
   `cdklabs/cdk-nextjs`'s, so run `git fetch https://github.com/cdklabs/cdk-nextjs.git
   refs/heads/<base>` and take `git rev-parse FETCH_HEAD`. If neither exists, stop and say so.
   `FULL_BASE` is `git merge-base <base commit> HEAD`. Write it, and every value here, into
   commands literally, never as a shell variable. If
   `git diff --quiet <FULL_BASE>..HEAD` shows no changes, write the ledger (step 4 says where) with
   `Outcome: nothing to review` and stop.
4. **Ledger:** `<stem>.md`, where the stem is `<git dir>/self-review/<branch, with / as ->` and
   `<git dir>` is `git rev-parse --path-format=absolute --git-common-dir`. That's inside `.git`, so
   it's never committed, and every worktree of the clone shares it. The spec and note use the same
   stem. If the ledger doesn't exist, create it (`mkdir -p` its directory) from the template in
   `references/ledger.md` in this skill's directory. If it exists, **resume** it by the rules in
   `references/resume.md` in this skill's directory.
5. **Spec:** the `--spec` file if given, else the pull request's `body` if there is one; plus every
   issue it closes (`Closes #<n>`, `Fixes`, `Resolves`, and their other tenses), or a commit in
   `git log <FULL_BASE>..HEAD` references: `gh issue view <n> -R cdklabs/cdk-nextjs`. Save them to
   `<stem>-spec.md` and record its path in the ledger. If none of these says what the change should
   do (an empty body, or one that only restates the title), the spec is "none": say "no spec
   available" in the report. Don't make a spec up from the diff.
6. **PR threads**, if there's a pull request `<n>`: read all three kinds, and record each in the
   ledger's PR threads section (its ID, `file:line` or "general", what it asks, and whether it's
   resolved, open or can't be resolved), replacing what an earlier run recorded.
   - **Review threads**, on the diff, which can be resolved:

     ```bash
     gh api graphql --paginate -F n=<n> -f query='
     query($n: Int!, $endCursor: String) {
       repository(owner: "cdklabs", name: "cdk-nextjs") { pullRequest(number: $n) {
         reviewThreads(first: 50, after: $endCursor) { pageInfo { hasNextPage endCursor }
           nodes { id isResolved path line originalLine
             comments(first: 100) { nodes { author { __typename login } body createdAt } } } } } } }'
     ```

     The ID is `id`; it's open until `isResolved`. Its location is `path` and `line`, or
     `originalLine` once the line has changed.
   - **Conversation comments**: `gh api --paginate repos/cdklabs/cdk-nextjs/issues/<n>/comments`
     (`id`, `user.login`, `user.type`, `body`). Not resolvable; "general".
   - **Review summaries**: `gh api --paginate repos/cdklabs/cdk-nextjs/pulls/<n>/reviews`, those
     with a `body`, and every `CHANGES_REQUESTED` one. Not resolvable; "general".

   Leave out bots' notes (`__typename` or `user.type` `Bot`, a login ending `[bot]`) and this
   skill's own earlier notes (starting `**/self-review** at`). A thread is **open** if GitHub says
   so, or if it's a person's note that can't be resolved, asks for a change, and hasn't been
   declined in a reply or answered by a ledger row.
7. **Upstream sources:** if the branch mirrors, parses or calls code outside this repo, have that
   code at the version the branch targets, to read, never run: a package's runtime (`next` itself,
   `@next/routing`) is in `node_modules/<pkg>`; anything else (a restated upstream function, the
   next.js test harness whose `@force-gate` pragmas `screen.mjs` evaluates) needs a shallow clone
   at the matching tag outside the repo, such as `git clone --depth 1 --branch v<version>
   https://github.com/vercel/next.js <scratch dir>/nextjs-<version>`. Reuse one that exists. Record
   the paths in the ledger header, or "none".
8. **Recorded decisions:** add a one-line summary under the ledger's Recorded decisions of each
   deliberate design choice that bears on the branch's files: ADRs and design notes in `docs/`,
   and, if your agent has a project memory for this repo (Claude Code's `MEMORY.md`), each memory
   recording a choice ("X chosen over Y", "X is kept", "Y rejected"). Triage holds to them (§2).

## 1. Review (fresh subagents every round)

- **Round 1, and the final pass:** FULL, `<FULL_BASE>..HEAD`.
- **Rounds in between:** DELTA, `<HEAD when the previous review started>..HEAD`: just the fixes.

**Before each review**, implement and commit every row that's `fix` but not `fixed` (§3, §4). A
design direction's commit, `fix: address review round <its row's round>`, goes in that round's
Commit cell, so the new design's growth doesn't count against it; others, this round's.

Start the reviewers below together, each in a fresh `general-purpose` subagent, so none sees
another's reasoning or an earlier round's. Never reuse one. Every prompt also carries, filled in:

> Don't edit, commit, check out or switch anything. Run nothing that deploys, uses cloud
> credentials or writes to GitHub; local tests are fine. Don't call `self-review` or start
> reviewers of your own, bar the `code-review` skill where this prompt asks for it.
> Upstream sources, at the version this branch targets: <the ledger's, or "none">. A finding about
> how code outside this repo behaves must cite that code; don't infer it.
> Already decided or raised; don't raise these again unless the code shows the decision is wrong,
> and cite the ID: <ledger rows (ID, location, finding, status), Recorded decisions, and resolved
> threads>

**Bugs reviewer**, every round. Its prompt, filled in:

> Review the changes in `<RANGE>` on branch `<branch>` (<the spec's first line, or the last
> commit's subject>) for correctness bugs and cleanups. Call the Skill tool with `code-review` and
> args `high <RANGE>`; never pass `--comment` or `--fix`. That skill may pick its own diff range
> (often `@{upstream}...HEAD`): compare the files it reviewed with `git diff --name-only <RANGE>`,
> and review any it missed yourself, reading the code around each hunk. Wait for its results
> before you report; anything after you hand back is lost. Drop its findings in uncommitted or
> unrelated files.
> Check the diff against the repo's agent instructions too (`CLAUDE.md`, and any docs it points
> to) where they cover a changed path; a breach is a finding that quotes the rule.
> Open PR threads the branch must still meet; report each change one asks for that the code
> doesn't make yet, citing its ID: <open threads, or "none">
> <DELTA only:> Also check that each fix resolves the ledger finding its commit line cites, and
> doesn't break a caller outside the diff.
> For each finding give: `file:line`, the defect in one sentence, a concrete failure scenario,
> severity (high, medium or low), whether it's a **bug**, a **cleanup** (reuse, simplification,
> efficiency) or a **rule** breach (quote the rule and its file), and the ID it relates to, if any.
> Say "outside range" for one on a line `<RANGE>` doesn't change. If you find nothing, say so.

**Standards reviewer**, FULL rounds only. Its prompt, filled in, with the smell baseline below
pasted in full:

> Review `git diff <FULL_BASE>...HEAD` (commits: `git log <FULL_BASE>..HEAD --oneline`) on branch
> `<branch>` against this repo's documented coding standards. Read every file that documents how
> code should be written: `CLAUDE.md`, `CONTRIBUTING.md`, `docs/development-guide.md`, the
> comments in `.projenrc.ts` that state a rule, and any other doc they point to. Do this review
> yourself; don't call `code-review`.
> Report (a) every place the diff breaches a documented standard, quoting the rule and its file;
> and (b) any smell from the baseline below, named, quoting the hunk. A documented standard can be
> a hard breach; a baseline smell is always a judgement call ("possible Feature Envy"), and a
> documented standard that endorses what a smell would flag suppresses it. Skip anything tooling
> already enforces (ESLint, Prettier, tsc, JSII). For each give `file:line` and severity. Under 400
> words. If there's nothing, say so.
> <the smell baseline>

The **smell baseline** (Fowler, _Refactoring_, ch. 3), each _what it is_ → _how to fix_:

- **Mysterious Name**: a function, variable or type whose name doesn't reveal what it does or
  holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape in more than one hunk or file in the change. → extract
  the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move it
  onto the data it envies.
- **Data Clumps**: the same few fields or params travelling together. → bundle them into one type.
- **Primitive Obsession**: a primitive or string standing in for a domain concept. → give the
  concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurring across the
  change. → polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forcing scattered edits across many files. → gather what
  changes together into one module.
- **Divergent Change**: one file edited for several unrelated reasons. → split it so each module
  changes for one reason.
- **Speculative Generality**: abstraction, parameters or hooks for needs the spec doesn't have. →
  delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the
  walk behind one method on the first object.
- **Middle Man**: a class or function that mostly delegates onward. → cut it, call the target.
- **Refused Bequest**: a subclass or implementer ignoring most of what it inherits. → drop the
  inheritance, use composition.

**Spec reviewer**, FULL rounds only, and only if the spec isn't "none". Its prompt, filled in:

> Check whether `git diff <FULL_BASE>...HEAD` on branch `<branch>` does what its spec asks. The
> spec is the file `<stem>-spec.md`; read it first, then the diff and the code around it. Don't
> hunt for bugs; another reviewer does. Do this review yourself; don't call `code-review`.
> Report: (a) requirements missing or partial; (b) requirements implemented differently from what
> the spec says; (c) behaviour the spec didn't ask for (scope creep; leave out refactors that
> change no behaviour, tests and docs); (d) a stale spec, describing something the branch no
> longer does. Quote the spec line for each, and give `file:line` (or "absent") and severity.
> Report no finding without a spec line to quote. Under 400 words. If the branch meets the spec,
> say so.
> <Round 1, and the first FULL round after the spec changed:> Also name any two spec lines that
> pull against each other, quoting both.

If the bugs reviewer hands back without `code-review`'s results, record it and make the next round
FULL. A FULL pass that loses them twice can't converge: set `Outcome: checks failed: code-review
results lost` and go to §6.

Record the round in the ledger: number, range type, SHAs, and the raw count from each reviewer.

## 2. Triage

**Verify every finding before you classify it.** Read the cited code, and for a finding about how
code outside this repo behaves, that code in the upstream sources (§0.7). A wrong fix costs a
revert and another round. A spec line that's vague or contradicts itself makes its finding
`invalid` (record which reading the code follows); two spec lines that pull against each other are
a `spec` finding of their own. Give each finding a **kind**, from the reviewer's report:

| Kind | From | Blocks a clean round |
| --- | --- | --- |
| `bug` | the bugs reviewer: a correctness defect, or an open thread's unmet request | yes, at medium or high |
| `rule` | the bugs or standards reviewer: a breach of a rule the repo documents, quoting it | yes, at medium or high |
| `spec` | the spec reviewer: missing, partial or wrong, quoting the spec line | yes, at medium or high |
| `cleanup` | the bugs reviewer: reuse, simplification, efficiency | no |
| `smell` | the standards reviewer: a baseline smell, always a judgement call | no |
| `design` | the design reviewer (§5): one root cause behind a file's repeated findings | yes, until it's decided |

A standards finding that cites no documented rule is a `smell`. A spec finding that quotes no spec
line is `invalid`. Record its severity (high, medium or low), correcting the reviewer's if the code
warrants it. Then give it exactly one status:

| Status | When | Action |
| --- | --- | --- |
| `duplicate` | The same finding as a ledger row or a resolved thread, with nothing new | Note the ID only |
| `invalid` | The code shows the claim is false | Record why |
| `noted` | Any `smell` not already in the ledger | Record it once, marked `simple` in Detail if its fix is (below) |
| `escalated` | A reason below applies | Record it, Detail starting `<tag>, …:` with each reason that applies, then your recommendation. Don't implement it |
| `fix` | Everything else, `cleanup` and a low payoff included; a new defect in lines an earlier round edited too | Implement |

Reasons to escalate, by tag: `re-fix`, the fix would revert or contradict an earlier round's fix,
or fixes the same finding (the same defect, not just the same lines) again; `decided`, it
contradicts a recorded decision (§0.8, a Recorded decisions line, an `accepted:` row); `guard`,
the fix would weaken a safety guard or security control; `product`, it needs a product or
maintainer decision (a construct's public props or JSII API, a data format others read, a new
dependency, behaviour users would notice); `live`, only a deployed stack could confirm it;
`scope`, scope creep or a stale spec (the spec is the author's intent; for a stale pull request
body, put the edit you propose in Detail); `broke`, its fix fails the checks (§3.3). The
**stops**, `guard`, `decided` and `product`, are never decided automatically, and the note lists
them first.

A smell's fix is **simple** if it stays in the branch's files, changes no behaviour, renames
nothing outside the branch relies on (an exported name, a prop, a file's name, a data format), and
undoes no earlier fix or decision.

An earlier round's fix that the code shows was wrong isn't oscillation or a re-fix: mark that row
`invalid` (citing the code) and this one `fix`, and revert it.

**A committed secret or real identifier** is the exception. Fix it, set `Outcome: stopped:
credential in history (<commit>)`, and stop and tell the user at once, without repeating it. The
commit that added it is still in history, so a later fix doesn't make the branch safe to push:
skip to §6's report (step 4), which publishes nothing. Rewriting history is the user's call.

## 3. Fix and verify

1. Implement every `fix`, matching the surrounding code. A design direction waits: the next round
   implements it before its review (§1). Add or adjust a test where a `bug` finding describes
   behaviour, alongside the source (`src/**/*.test.ts`) or in `test/`.
2. Run the checks, from the repo's root:
   - `pnpm compile` if JSII sources (`src/`, bar the bundled runtime code) or struct definitions
     changed;
   - `pnpm bundle` if `src/adapter/`, `src/lambdas/` or `src/nextjs-build/patch-fetch.js` changed;
   - `pnpm jest <affected test files>`;
   - `pnpm eslint` (the whole repo; no file arguments, no `npx eslint`);
   - `pnpm projen` if `.projenrc.ts` changed, and commit what it regenerates;
   - **never `pnpm build`**: its docgen step hangs, and CI regenerates `API.md`.

   Then the **hygiene check**: no commit in `git log -p --cc <FULL_BASE>..HEAD` adds a secret or
   real identifier (§2), and `git status --porcelain` shows nothing staged that's build output
   (`lib/`, `dist/`, `*.js` beside a `.ts`) rather than source. Check every commit, not the net
   diff: a later commit that removes one leaves it in history.
3. If a fix can't be made to pass, revert just that fix, mark it `escalated` (`broke: <check>:
   <error>`), and go on.

## 4. Commit

Commit with the subject `fix: address review round <N>` (`test:` or `docs:` if that's all the
round touched) and a body of one line per fix: `- <ledger ID>: <what changed>`. Then update each
row's status: `fixed <short sha>`, or its status and the reason, and put the short SHA in the
round's Commit cell (`-` if the round committed nothing).

## 5. Convergence

A **blocking** finding is of kind `bug`, `rule` or `spec`, and severity medium or high, or a
`design` row not yet decided. After each round, count the blocking findings it triaged `fix`
(`fixed` once §4 has run) or `escalated`; one whose fix §3.3 reverted counts as `escalated`, not
`fix`. Low ones are fixed or escalated too, but don't keep the loop going. `cleanup` and `smell`
never block.

- A round with blocking findings triaged `fix` → another round, DELTA. Oscillation is caught in
  triage, where it's `escalated` (§2). After `design changed`, the next round is FULL.
- A DELTA round with none triaged `fix` → run the **final FULL pass**, which also reviews this
  round's fixes.
- A FULL round with none triaged `fix` → **converged** if no blocking finding in the ledger is
  still `escalated`; otherwise **stalled**: what's left needs the user's decision, and another
  round would only repeat it. Either way, this round's own low and cleanup fixes go unreviewed;
  say so.

**Design check**, after every round that didn't converge, for a design problem the counts above
miss: a file each round finds new edge cases in while its fixes keep growing it. From the repo's
root, run `node .claude/skills/self-review/scripts/design-check.mts <ledger>`. It lists each file
that trips a threshold, and why:

| Threshold | Default | Trips when the file |
| --- | --- | --- |
| repeated | 3 rounds | has `bug`, `rule` or `spec` findings at medium or high in that many rounds |
| growing | 3 rounds, 20% | grew by a net 20% or more over the last 3 rounds whose commits (Commit cells) touch it, while its findings aren't tailing off |

The script's header has the details. Exit 3 names a row that breaks the ledger's contract
(`references/ledger.md` in this skill's directory): correct it and rerun. Any other failure: set
`Outcome: checks failed: design check` with its message and go to §6.

For each file listed, run a **design reviewer** and decide or escalate its answer, as
`references/design.md` in this skill's directory says.

The last review `--rounds` allows is a FULL pass, and reaching the cap with blocking findings
still triaged `fix` is `capped`, not converged, in automatic mode too. `--rounds` counts only the
reviews this run does; round numbers continue from the ledger.

After every round, set the ledger's `Outcome:` line, and the round's Outcome column, to
`in progress` (in the column, `design changed` after an automatic design decision),
`converged at <HEAD short sha>`, `stalled: <the open blocking escalated IDs>`,
`stalled: design rethink (<file>, …)`, or `capped`.

## 6. Finish

1. **Simple fixes.** If the outcome is `converged`, `capped` or `stalled: <IDs>`, fix each `simple`
   smell that still applies and, in automatic mode, each `escalated` low `references/auto.md` in
   this skill's directory lets it. Revert any that fails §3.2's checks (a smell left `noted` without
   its `simple` mark, a low left `escalated`, each with why), and commit the rest alone, §4's body,
   as `fix: address simple review findings`. Set their rows to `fixed <short sha>`, and any
   `converged at` to the new HEAD. Then, whatever the outcome, run `pnpm test` once and the
   hygiene check over the branch. If one fails, set `Outcome: checks failed: <check>`, which isn't
   converged; for a secret or identifier, act as §2 says and skip to step 4.
2. Write the **note** to `<stem>-note.md`, starting `**/self-review** at <HEAD short sha>`: the
   **Decided automatically** table (`references/auto.md` in this skill's directory), if any, the
   ledger's `Outcome:` line, the rounds table, the fixes grouped by area, every open escalation with
   its reason (stops first, §2), the simple fixes (unreviewed, with their commit) and the smells
   left for the author to judge. It's for the human reviewer: keep it short. Run the hygiene check
   on it, rewriting it until it passes.
3. **Publish**, as `references/publish.md` in this skill's directory says, if its When to
   publish conditions hold: re-check the pull request, push, put the note up, and set the commit
   status by the verdict. Otherwise the fixes stay local.
4. Report to the user: the outcome and how many rounds; the worst open finding per axis, kept
   apart (`bugs: <ID or "none">`, `standards: <ID or "none">`, `spec: <ID, "none", or "no spec
   available">`); the per-round table; each automatic decision, with its alternatives; each
   escalation needing a decision, with its ID, `file:line`, why, and your recommendation (for a
   `design` row, the root cause and each alternative with its cost); any check failures, with
   their output; and the ledger's path, and the note's if `<stem>-note.md` is at HEAD (starts
   `**/self-review** at <HEAD short sha>`). Then, pushed or not, say where the branch stands on
   origin, as the GitHub status section of `references/publish.md` in this skill's directory gives
   it.
5. If the user decides an escalation, record it: a decision to change code sets the row to `fix`,
   which the next run implements; a decision to leave it sets `accepted: <reason>`, which no longer
   counts as open. A `design` row's `fix` names the direction; when it's carried out, update the
   spec's source (§0.5) first if it changes it. Either way, add a `(user)` line under Recorded
   decisions (`references/auto.md` in this skill's directory), an automatic one's override
   included, which `decided` then holds to. If it's a durable design decision, offer to record it
   where later runs will find it (§0.8).

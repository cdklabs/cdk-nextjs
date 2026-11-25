# Design reviewer

SKILL.md §5 sends you here for each file the design check lists. Section numbers are SKILL.md's.

Start a design reviewer in a fresh subagent, as in §1, with the rows the script names but not
their Detail, so the fixes' reasoning doesn't anchor it. Its prompt, filled in:

> Review the design of `<file>` on branch `<branch>`, not its lines: each review round finds new
> defects in it. Don't edit, commit, check out or switch anything, and run nothing that deploys,
> uses cloud credentials or writes to GitHub. Read the spec, `<stem>-spec.md` <or: there is no
> spec>, then `<file>` at HEAD and whatever shows how it's used; not the branch's commit messages,
> which argue for the fixes. The findings: <the rows it names: ID, round, kind, finding, severity>
> First, is there one root cause behind them, such as two spec lines that conflict, or a wrong
> abstraction? Name it, quoting the spec lines involved, or say why there isn't one. Second, what
> alternatives would remove that whole class of finding? For each, its cost: the spec lines it
> changes, what it adds to or removes from the code, and what a user loses. End with the one you
> recommend.

Record each answer as a `design` row: this round, the file as location, the root cause as
finding, severity high, and the alternatives, costs and recommendation in Detail. Then:

- **Automatic mode** (no `--ask`): decide it as `references/auto.md` in this skill's directory says.
  Taken, a new direction makes the row `fix`, recorded as that file says, and the round's Outcome
  column `design changed` (§5); an answer to keep the design makes it `accepted: <reason>`, and
  nothing else changes. Like a user's decision, a direction is carried out before the next review
  (§1), which is FULL. If a stop applies, §5 ended the loop this round anyway (`stalled`), or
  `--rounds` leaves no review for that next round, treat it as `--ask` does.
- **`--ask`**, or a stop: status `escalated`, a stop's tag starting its Detail (§2). Under `--ask`,
  a new direction is the user's call, since it usually changes the spec. Set `Outcome: stalled:
  design rethink (<file>, …)` and go to §6, whatever else the round decided; say this round's fixes
  go unreviewed. A direction decided automatically this round goes back to `escalated`, with its
  recommendation (drop its `(auto)` line), so the user decides the rethinks together.

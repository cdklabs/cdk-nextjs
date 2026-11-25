# Resuming a ledger

When SKILL.md §0.4 finds the ledger already exists, resume it:

- `Outcome: stopped`: report it again (§6.4) and stop, unless the user says the branch's history
  has been rewritten to remove what stopped it.
- `Outcome: converged at <HEAD>`, with no row still `fix`: the spec or threads may have changed
  since, and there's no record to tell, so review again: write `resumed` in the last round's
  Outcome column and `Outcome: in progress`; the next round is the final FULL pass, and its spec
  reviewer gets §1's spec-tension line, as after a spec change. Clean, the branch stays converged
  (§5), and §6 checks and pushes as usual.
- `Outcome: stalled: design rethink (<file>, …)`: while any of its `design` rows is
  `escalated`, report it again (§6.4) and stop. Once each is decided, carry on as below; for a
  `fix`, write `design changed` in the last round's Outcome column.
- Otherwise keep every recorded outcome and continue the round numbering. If the base or
  `FULL_BASE` changed, or a recorded round's SHA is no longer an ancestor of HEAD (`git
  merge-base --is-ancestor`), write `base changed` in the last round's Outcome column. After
  `base changed`, `design changed` or `resumed` there, the next round is FULL.

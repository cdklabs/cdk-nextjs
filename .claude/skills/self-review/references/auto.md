# Automatic mode

Automatic mode is the default; `--ask` turns it off. SKILL.md sends you here wherever a run would
otherwise stop for the user's decision. Section numbers are SKILL.md's. The author reviews every
automatic decision afterwards, in the note this skill puts up on the pull request, or in §6.4's
report, so each one is written down where they'll see it.

## What it decides

Where the run reaches one of these, take the recommended option instead of asking:

- an escalation tagged `re-fix` alone (§2);
- a **design rethink** (§5): the design reviewer's recommended alternative;
- at §6.1, an `escalated` low finding whose recommended fix is simple, as §2 defines it for a smell
  except that it changes the behaviour the finding names, unless it's untagged or tagged with a
  stop, `live` or `scope`. It's fixed with the simple smells, unreviewed, which the note says.

Every other escalation stays `escalated`, as with `--ask`.

## When it still stops

§2's stops are never decided. Nor is any of the above whose option, the one it would take, does
what a stop names; add that stop's tag to its row, leave it `escalated` with the recommendation
after the tag, and go on as `--ask` would:

- `guard`, as §2 defines it, which includes a force-push of any kind (`--force-with-lease`
  included), skipping or disabling a hook, writing to someone else's pull request, loosening a
  rule about credentials or secrets, or loosening an IAM policy, a resource policy or encryption;
- `decided`, **reverses an earlier decision in the same area**, as §2 defines one, the user's or
  an automatic one, unless a later `(user)` line for it says otherwise: changing direction there a
  second time is oscillation. So is fixing again a finding an `(auto)` line already re-fixed.
  Reverting a plain `fixed` row isn't: that's a re-fix, decided here;
- `product`, as §2 defines it, and also a spec change this run can't write (below).

When the recommended option trips a stop but another alternative doesn't, still stop: name the
alternative in the recommendation, and the user picks.

Automatic decisions never take the run past `--rounds`: reaching it ends the run with §5's outcome,
and a decision whose change no review is left to check stays `escalated`, for the user, bar a
simple low fix at §6.1.

## Recording a decision

- **Ledger:** set the row's status as a user's decision would (§6.5): `fix`, carried out this round
  (§3), or a design direction before the next review (§1); or `accepted: <reason>`. Then add a line
  under Recorded decisions: `<ID> (auto): <the option>; passed over: <the alternatives>; <why>`. A
  user's decision (§6.5), their override of an automatic one included, is a `(user)` line in the
  same form. If the decision is undone (§3.3 reverts its fix, or `references/design.md` sends it
  back), drop its `(auto)` line.
- **Spec:** an option that changes what the spec says is carried out like a user's: when it's
  carried out, not when it's decided, first edit the spec's source (§0.5) and copy it into
  `<stem>-spec.md`, and give the next FULL round's spec reviewer §1's spec-tension line, as after a
  spec change. That's possible only for a `--spec` file outside the repo; any other source (a pull
  request body, an issue, a file in the repo) makes it a stop. Note the changed lines in the
  decision's line.
- **Note:** §6.2's note opens with a **Decided automatically** table, one row per `(auto)` line: ID,
  what was decided, the alternatives passed over, and the spec change, if any (`-` if none).

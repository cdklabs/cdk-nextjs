# Ledger template

The ledger SKILL.md §0.4 creates at `<stem>.md`, filled in as the run goes.

```markdown
# self-review ledger: <branch>

Branch: <branch> · Base: <base> @ <FULL_BASE short sha> · PR: #<n>, or "none"
Outcome: in progress
Spec: <path, or "none">
Upstream sources: <paths, or "none">

## Recorded decisions

- <ADR, doc or memory>: <one line>
- <ID> (<user or auto>): <the option taken>; passed over: <the alternatives>; <why>

## PR threads

- <thread ID>: <file:line or "general">, <what it asks>, <resolved, open, or can't be resolved>

## Rounds

| Round | Range | SHAs | Raw (bugs/standards/spec) | Blocking | Fixed | Escalated | Commit | Outcome |
| ----- | ----- | ---- | ------------------------- | -------- | ----- | --------- | ------ | ------- |

## Findings

| ID   | Round | Kind | Severity | Location         | Status          | Finding | Detail |
| ---- | ----- | ---- | -------- | ---------------- | --------------- | ------- | ------ |
```

**Contract**, for the design check (SKILL.md §5) and the verdict (`scripts/publish.mts`), which read
only these cells: ID; Round, a number; Kind, a SKILL.md §2 kind; Severity, `high`, `medium` or
`low` (a correction's reason goes in Detail); Location, a repo-relative `path` or `path:line`, or
`-`; Status, starting with a SKILL.md §2 status, `fixed` or `accepted:`; the Rounds table's Commit,
short SHAs separated by spaces, or `-`. Finding and Detail are free.

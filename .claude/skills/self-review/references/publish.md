# Publish, and where the branch stands

SKILL.md §6.3 sends you here, and so does `--publish-only`. §6.4 sends you here for the GitHub
status lines. Section numbers are SKILL.md's. The scripts are in `.claude/skills/self-review/scripts/`;
run them from the repo's root, the `.ts` ones as `node <script> …`.

Where the branch stands on origin comes from `branch-state.sh`, run as `bash <script> <branch>
<FULL_BASE>`, which reads the **branch tip** from git, not from GitHub's view of the pull request,
which can lag. GitHub says only which pull request it is, and whether it's still open and yours.

## When to publish

Only when every one of these holds; otherwise skip to §6.4:

- no `--no-publish`;
- the outcome isn't `stopped`: a pushed secret has leaked even if reverted (`checks failed` only
  marks the pull request failed);
- §0.1's reads worked, and the branch has an open pull request into `<base>` (§0.1's branch PR)
  whose `author.login` is you.

## Publish only

`--publish-only` publishes a run that has already finished, say once you've opened the pull
request after a run with none. With `--no-publish` too, stop first, and say the two conflict. Run
§0.1 and §0.2, then §0.3 for the base and `FULL_BASE` only, and read the ledger at §0.4's path;
write nothing to it, nor create or resume it. If it doesn't exist, or its `Outcome:` is `in
progress`, stop and say there's no finished run to publish; if it's `nothing to review`, stop and
say so. Review, fix and commit nothing. Then When to publish, Publish, and §6.4's report, its
outcome and findings read from the ledger. It pushes only what the run reviewed (Publish step 3).

## Publish

In this order. With `checks failed`, push nothing: run steps 1 and 2, then, only if step 2's first
line is `at HEAD`, step 4 if this is `--publish-only` (else post no note; with origin behind, report
the note as not posted, since it would describe commits that aren't pushed), and step 5, whose
verdict is `failure`, so an earlier run's success status doesn't stand for code that no longer
passes its checks or couldn't be reviewed.

1. Check When to publish's pull request conditions again now, since it may have been merged or
   closed during the run: §0.1's branch PR read still lists it open, into `<base>`, with you as its
   author. If not, or a read fails, push nothing, and report it.
2. Run `branch-state.sh`. If its first line is `no branch tip: <why>` (merged and deleted?), push
   nothing, and report it. Exit 1 with `diverged` means someone else has pushed to the branch, or
   rewritten it: push nothing, and report it; pulling or rebasing is the user's. Any other non-zero
   exit: push nothing, and report its output. If its `tip` line isn't the pull request's
   `headRefOid` (from step 1), origin's branch isn't the pull request's head: push nothing, and
   report both SHAs.
3. If its first line is `behind <n>`, push: `git push origin refs/heads/<branch>:refs/heads/<branch>`,
   fast-forward only, never forced, with git's hooks running. If it's rejected or a hook fails,
   post nothing, and report the output. With `--publish-only`, push only if `<stem>-note.md` starts
   `**/self-review** at <HEAD short sha>`: commits after the one it names are unreviewed and
   unchecked, so push nothing, and report them.
4. **Note**, once origin's branch is at HEAD (step 2's first line was `at HEAD`, or step 3's push
   worked), and only if `<stem>-note.md` starts `**/self-review** at <HEAD short sha>`. This skill
   keeps one note on the pull request, a conversation comment, edited in place each run:
   - Find its latest note, `<user>` being you:

     ```bash
     set -o pipefail; gh api --paginate repos/cdklabs/cdk-nextjs/issues/<n>/comments --jq '.[] | select(.user.login == "<user>" and (.body | startswith("**/self-review** at"))) | .id' | tail -n 1
     ```

     If the read fails, post nothing, and report its output.
   - If there's one, write its text to `<stem>-earlier-note.md` (`gh api
     repos/cdklabs/cdk-nextjs/issues/comments/<note id> --jq .body > <stem>-earlier-note.md`). Run
     `node <scripts>/publish.mts note <stem>-note.md <stem>-earlier-note.md <stem>-post.md` (or `-`
     in place of the earlier note's file, if there's none), which adds `Earlier runs: <sha>
     <outcome> · …` at the end: an edit notifies no one. If it prints `history dropped`, the
     earlier note didn't parse: go on, and report that its history is lost. If it exits non-zero,
     post nothing, and report its output.
   - Edit that note to `<stem>-post.md`: `gh api -X PATCH
     repos/cdklabs/cdk-nextjs/issues/comments/<note id> -F body=@<stem>-post.md`; or, with none,
     post it: `gh pr comment <n> -R cdklabs/cdk-nextjs --body-file <stem>-post.md`. If that fails,
     report its output; the push stands.
5. Still only once origin's branch is at HEAD, the **verdict** is the first line `node
   <scripts>/publish.mts verdict <ledger>` prints: `success` or `failure`; its header says when.
   Its second line says why. If it exits non-zero, it printed no verdict: take `failure`, and
   report its output.
   - **Status:** unless step 1's read showed the pull request is no longer open, into `<base>` and
     yours (then report it), run `bash <scripts>/status.sh <verdict>`. It sets the `self-review`
     commit status on HEAD in `cdklabs/cdk-nextjs` and reads it back. That needs write access to
     `cdklabs/cdk-nextjs`; from a fork without it, it prints `status: not set: no write access` and
     the pull request shows no status, which is expected: say so. Report its lines.

   A failure in any of these is reported with its output; nothing before it is undone.

## GitHub status

Whether or not Publish ran, run `branch-state.sh` once more after §6.3. Its first line picks the
row, its `unpushed` line gives `<n>`, and its `tip` line the branch tip; if it exits 2 or git
fails, report its output instead.
Then add which pull request it is: `PR #<n>` (the one §0.1 found), `no PR (open one, then run
--publish-only)`, or, if §0.1's reads failed, `PR unknown (no GitHub: <why>)`. If Publish step 1's
check failed, say which instead (no longer listed as open, into another target, not yours, or the
read failed), and leave out the paragraph after the table.

| State | Report |
| --- | --- |
| `at HEAD` | `pushed <n> commits; ` first if this run pushed (Publish step 2's `behind <n>`, pushed in step 3), then `origin/<branch> is at <HEAD short sha>` |
| `behind <n>` | `<n> commits not pushed; origin/<branch> is at <branch tip short sha>`, and why: the When to publish condition that failed, `checks failed`, commits after the reviewed SHA (`--publish-only`), or Publish's output |
| `diverged` | `<n> commits not pushed; origin/<branch> is at <branch tip short sha>, which isn't in HEAD's history`: someone else pushed, or the branch was rewritten |
| `no branch tip: <why>` | `<n> commits not pushed; <why>` |

Then, with a pull request, say what this run did with the note (`note edited`, `note posted`, or
`note not posted`, and why: the When to publish condition that failed, `checks failed`, a note not
at HEAD, commits after the reviewed SHA, or Publish's output), and the status the read-back found
(if it isn't the verdict, the script's output; if Publish didn't reach step 5, `status not set`
and why). If the pull request holds this skill's notes at older SHAs that this run didn't edit, say
they're stale: a run that publishes edits only the latest one.

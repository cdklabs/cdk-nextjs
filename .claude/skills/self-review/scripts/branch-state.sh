#!/usr/bin/env bash
# Where the branch stands against its tip on origin, for self-review's publish step and its
# report.
#
#   branch-state.sh <branch> <FULL_BASE>
#
# Run from the repo, on the branch. The branch tip is read from git, not from GitHub's view of
# the pull request, which can lag or fail: one fetch of origin's branches whose names start with <branch>
# into a namespace of this run's own under refs/self-review/, removed when it exits, so no ref of
# the user's (refs/remotes/origin/*, tags, FETCH_HEAD) is written or pruned, and no earlier run's
# ref can get in the way; then that namespace's <branch>, so a ref's name and its object arrive
# together and only an exact name matches. Prints three lines:
#
#   <state>                       `diverged` (the tip isn't an ancestor of HEAD), `at HEAD`,
#                                 `behind <n>` (n commits behind HEAD), or `no branch tip: <why>`,
#                                 the why being `origin/<branch> doesn't exist` or `origin/<branch>
#                                 couldn't be read: <git's message>` (the fetch failed)
#   unpushed <n> from <ref>       `git rev-list --count <ref>..HEAD`, <ref> being the tip if
#                                 there is one; else origin/<branch> as the user's own fetches
#                                 left it, if it exists (counted from
#                                 refs/remotes/origin/<branch>, so a local branch or tag of that
#                                 name can't stand in for it); else FULL_BASE
#   tip <SHA, or ->               the branch tip, `-` with `no branch tip`
#
# Exit status: 0 for `at HEAD`, `behind <n>` or `no branch tip`; 1 for `diverged`, meaning someone
# else has pushed to the branch, or it was rewritten; 2 for bad arguments; git's own status when
# another git command fails.
set -euo pipefail

usage="usage: branch-state.sh <branch> <FULL_BASE>"
if [[ $# -ne 2 || -z "$1" || -z "$2" ]]; then
  echo "${usage}" >&2
  exit 2
fi
branch=$1 full_base=$2
git rev-parse --verify -q "${full_base}^{commit}" >/dev/null \
  || { echo "branch-state.sh: FULL_BASE ${full_base} is not a commit" >&2; exit 2; }
tracking_ref=refs/remotes/origin/${branch}
run_refs=refs/self-review/run-$$-${RANDOM}

# The branch tip. A glob refspec that matches nothing still succeeds, so a failed fetch means
# origin, or the refs it fetches into, couldn't be read, never that the branch is missing.
# --refmap= stops git updating refs/remotes/origin/* for what it fetches, --no-tags stops it
# following tags, --no-write-fetch-head leaves FETCH_HEAD alone, and --no-recurse-submodules leaves
# submodules (and a fetch of theirs that could fail) out of it.
err=$(mktemp)
trap 'rm -f "${err}"; git for-each-ref --format="delete %(refname)" "${run_refs}/" | git update-ref --stdin \
  || echo "branch-state.sh: couldn'"'"'t remove ${run_refs}/; delete it with git update-ref -d" >&2' EXIT
fetch_rc=0
git fetch -q --refmap= --no-tags --no-write-fetch-head --no-recurse-submodules origin \
  "+refs/heads/${branch}*:${run_refs}/${branch}*" 2>"${err}" || fetch_rc=$?
if [[ ${fetch_rc} -ne 0 ]]; then
  message=$(tr '\n' ' ' <"${err}" | sed 's/ *$//')
  tip=- why="origin/${branch} couldn't be read: ${message:-git fetch exited ${fetch_rc} without a message}"
elif ! tip=$(git rev-parse --verify -q "${run_refs}/${branch}^{commit}"); then
  tip=- why="origin/${branch} doesn't exist"
fi

status=0
if [[ "${tip}" == - ]]; then
  state="no branch tip: ${why}"
  # The ref to count from (count_ref), and the name it's reported by (shown): the full ref, so a
  # local branch or tag named origin/<branch> can't stand in for the remote one.
  if git rev-parse --verify -q "${tracking_ref}" >/dev/null; then
    shown=origin/${branch} count_ref=${tracking_ref}
  else
    shown=${full_base} count_ref=${full_base}
  fi
else
  shown=${tip} count_ref=${tip}
  rc=0
  git merge-base --is-ancestor "${tip}" HEAD || rc=$?
  if [[ ${rc} -eq 1 ]]; then
    state=diverged status=1
  elif [[ ${rc} -ne 0 ]]; then
    exit "${rc}"
  elif [[ "${tip}" == $(git rev-parse HEAD) ]]; then
    state="at HEAD"
  else
    state="behind $(git rev-list --count "${tip}..HEAD")"
  fi
fi

count=$(git rev-list --count "${count_ref}..HEAD")
echo "${state}"
echo "unpushed ${count} from ${shown}"
echo "tip ${tip}"
exit "${status}"

#!/usr/bin/env bash
# Set the `self-review` commit status on HEAD in cdklabs/cdk-nextjs, and read it back, for
# self-review's publish step (references/publish.md, step 5).
#
#   status.sh success|failure
#
# Run from the repo, on the pull request's branch, once origin's branch is at HEAD. Setting a
# status needs write access to cdklabs/cdk-nextjs; without it (a fork's pull request, say) nothing
# is written. GitHub's list of statuses can lag just behind a write, so until it shows <state> it
# reads again, $STATUS_POLL (3) seconds apart, up to 5 reads in all; once only, after a failed
# write.
#
# Prints, for the report:
#   status: not set: <why>                          (only if it wasn't set)
#   status: <the state read back, or none>|not read: <why>
#
# Exit status: 0 when the status read back is <state>; 1 when it wasn't set or read back, or the
# read-back isn't <state>; 2 for bad arguments. Otherwise git's own status.
set -euo pipefail

repo=cdklabs/cdk-nextjs context=self-review
if [[ $# -ne 1 || ( "$1" != success && "$1" != failure ) ]]; then
  echo "usage: status.sh success|failure" >&2
  exit 2
fi
state=$1
sha=$(git rev-parse --verify HEAD)

err=$(mktemp)
trap 'rm -f "${err}"' EXIT
why() { tr -s '\n' ' ' <"${err}" | sed 's/ *$//'; }

rc=0
push=$(gh api "repos/${repo}" --jq .permissions.push 2>"${err}") || push=unknown
if [[ "${push}" == false ]]; then
  echo "status: not set: no write access to ${repo}"
  rc=1
elif ! gh api -X POST "repos/${repo}/statuses/${sha}" -f "state=${state}" -f "context=${context}" \
  -f "description=${context}" >/dev/null 2>"${err}"; then
  echo "status: not set: $(why)"
  rc=1
fi

read_back='' tries=5
while [[ ${tries} -gt 0 ]]; do
  tries=$((tries - 1))
  read_back=$(gh api "repos/${repo}/commits/${sha}/statuses?per_page=100" \
    --jq "[.[] | select(.context == \"${context}\")][0].state // \"none\"" 2>"${err}") || { read_back=; break; }
  [[ "${read_back}" == "${state}" || ${rc} -ne 0 || ${tries} -eq 0 ]] && break
  sleep "${STATUS_POLL:-3}"
done
if [[ -n "${read_back}" ]]; then
  echo "status: ${read_back}"
  [[ "${read_back}" == "${state}" ]] || rc=1
else
  echo "status: not read: $(why)"
  rc=1
fi
exit "${rc}"

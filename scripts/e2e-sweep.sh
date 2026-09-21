#!/usr/bin/env bash
#
# Deletes orphaned compatibility-harness stacks - the ones `scripts/e2e-cleanup.sh`
# never got to run for, because a shard was cancelled, timed out, or died.
#
# Dry run by default: prints what it would delete and exits 0. Pass `--apply`
# (or set HARNESS_SWEEP_APPLY=1) to actually delete. Only stacks that are named
# `hrns-*` *and* tagged `cdk-nextjs:harness=1` *and* older than
# HARNESS_SWEEP_MAX_AGE_HOURS (default 6) are ever considered.
#
# Usage:
#   scripts/e2e-sweep.sh                 # list candidates
#   scripts/e2e-sweep.sh --apply         # delete them
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e-harness/common.sh
source "$SCRIPT_DIR/e2e-harness/common.sh"

APPLY="${HARNESS_SWEEP_APPLY:-0}"
for arg in "$@"; do
  case "$arg" in
  --apply) APPLY=1 ;;
  --dry-run) APPLY=0 ;;
  *)
    echo "usage: $0 [--apply|--dry-run]" >&2
    exit 2
    ;;
  esac
done

MAX_AGE_HOURS="${HARNESS_SWEEP_MAX_AGE_HOURS:-6}"
export HARNESS_TAG_KEY HARNESS_TAG_VALUE HARNESS_STACK_PREFIX MAX_AGE_HOURS

# An age floor, not just a tag match: a concurrent run's stacks carry the same
# tag, and deleting one out from under a running test would look like an adapter
# bug. A harness deploy plus its test finishes well inside an hour.
CANDIDATES="$(
  aws cloudformation describe-stacks --output json | node -e '
    const { HARNESS_TAG_KEY, HARNESS_TAG_VALUE, HARNESS_STACK_PREFIX, MAX_AGE_HOURS } = process.env;
    const maxAgeMs = Number(MAX_AGE_HOURS) * 60 * 60 * 1000;
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      const { Stacks = [] } = JSON.parse(raw);
      for (const stack of Stacks) {
        if (!stack.StackName.startsWith(HARNESS_STACK_PREFIX)) continue;
        if (String(stack.StackStatus).startsWith("DELETE_")) continue;
        const tagged = (stack.Tags || []).some(
          (tag) => tag.Key === HARNESS_TAG_KEY && tag.Value === HARNESS_TAG_VALUE,
        );
        if (!tagged) continue;
        const ageMs = Date.now() - new Date(stack.CreationTime).getTime();
        if (ageMs < maxAgeMs) continue;
        const ageHours = (ageMs / 3_600_000).toFixed(1);
        console.log([stack.StackName, stack.StackStatus, ageHours].join("\t"));
      }
    });
  '
)"

if [ -z "$CANDIDATES" ]; then
  echo "sweep: no harness stacks older than ${MAX_AGE_HOURS}h"
  exit 0
fi

echo "sweep: harness stacks older than ${MAX_AGE_HOURS}h:"
printf '%s\n' "$CANDIDATES" | while IFS=$'\t' read -r name status age; do
  printf '  %s (%s, %sh old)\n' "$name" "$status" "$age"
done

if [ "$APPLY" != "1" ]; then
  echo "sweep: dry run; re-run with --apply to delete the above"
  exit 0
fi

printf '%s\n' "$CANDIDATES" | while IFS=$'\t' read -r name _status _age; do
  # Re-check the tag immediately before deleting rather than trusting the listing.
  if ! harness_stack_is_ours "$name"; then
    echo "sweep: skipping $name - no longer tagged ${HARNESS_TAG_KEY}=${HARNESS_TAG_VALUE}"
    continue
  fi
  echo "sweep: deleting $name"
  aws cloudformation delete-stack --stack-name "$name"
done

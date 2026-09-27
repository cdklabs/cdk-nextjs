#!/usr/bin/env bash
#
# Deletes orphaned compatibility-harness stacks - the ones `scripts/e2e-cleanup.sh`
# never got to run for, because a shard was cancelled, timed out, or died.
#
# Dry run by default: prints what it would delete and exits 0. Pass `--apply`
# (or set HARNESS_SWEEP_APPLY=1) to actually delete. Only stacks that are named
# `hrns-*` *and* tagged `cdk-nextjs:harness=1` *and* older than
# HARNESS_SWEEP_MAX_AGE_HOURS (default 6) are ever considered. "Older" is
# measured from the stack's last sign of use, not its creation: see
# `last_activity_ms` below.
#
# A stack in DELETE_FAILED is a candidate like any other - it is still holding
# whatever it failed to delete - and goes through the same gates.
#
# `--wait` blocks until every delete finishes and exits non-zero if any ends in
# DELETE_FAILED, so a caller that deploys into the same name next (a CI shard)
# never starts while the old stack is still DELETE_IN_PROGRESS.
#
# `--stack NAME` (or `--shared`) narrows the sweep to one stack by name and drops
# the age floor. That is the *only* safe way to delete a stack minutes after
# creating it: `HARNESS_SWEEP_MAX_AGE_HOURS=0` alone would also match every other
# `hrns-*` stack in the account, including one a developer is running against
# right then with HARNESS_ISOLATED_STACK=1.
#
# Usage:
#   scripts/e2e-sweep.sh                 # list candidates
#   scripts/e2e-sweep.sh --apply         # delete them
#   scripts/e2e-sweep.sh --apply --shared    # delete just the shared stack
#   scripts/e2e-sweep.sh --apply --stack hrns-app-1a2b3c4d
#   scripts/e2e-sweep.sh --apply --shared --wait   # and block until it is gone
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e-harness/common.sh
source "$SCRIPT_DIR/e2e-harness/common.sh"

APPLY="${HARNESS_SWEEP_APPLY:-0}"
ONLY_STACK="${HARNESS_SWEEP_STACK:-}"
WAIT=0
while [ "$#" -gt 0 ]; do
  case "$1" in
  --apply) APPLY=1 ;;
  --dry-run) APPLY=0 ;;
  --wait) WAIT=1 ;;
  --shared) ONLY_STACK="$(HARNESS_ISOLATED_STACK=0 harness_stack_name "")" ;;
  --stack)
    ONLY_STACK="${2:-}"
    if [ -z "$ONLY_STACK" ]; then
      echo "$0: --stack needs a stack name" >&2
      exit 2
    fi
    shift
    ;;
  *)
    echo "usage: $0 [--apply|--dry-run] [--shared|--stack NAME] [--wait]" >&2
    exit 2
    ;;
  esac
  shift
done

# Naming one stack replaces the age floor rather than adding to it: the name is
# what makes the deletion safe, and the caller asking for it by name is the caller
# that created it.
if [ -n "$ONLY_STACK" ]; then
  MAX_AGE_HOURS=0
else
  MAX_AGE_HOURS="${HARNESS_SWEEP_MAX_AGE_HOURS:-6}"
fi
export HARNESS_TAG_KEY HARNESS_TAG_VALUE HARNESS_STACK_PREFIX MAX_AGE_HOURS ONLY_STACK

# An age floor, not just a tag match: a concurrent run's stacks carry the same
# tag, and deleting one out from under a running test would look like an adapter
# bug. A harness deploy plus its test finishes well inside an hour.
#
# The listing below applies the floor to CloudFormation's own timestamps, the
# latest of `CreationTime` and `LastUpdatedTime`. That alone is not enough for a
# shared stack, which is reused by name for hours and deployed into by hotswap -
# and a hotswap never goes through CloudFormation, so neither timestamp moves.
# What does move is the server function's `LastModified`, which every test file's
# hotswap rewrites. `last_activity_ms` folds that in before anything is deleted.
CANDIDATES="$(
  aws cloudformation describe-stacks --output json | node -e '
    const { HARNESS_TAG_KEY, HARNESS_TAG_VALUE, HARNESS_STACK_PREFIX, MAX_AGE_HOURS, ONLY_STACK } = process.env;
    const maxAgeMs = Number(MAX_AGE_HOURS) * 60 * 60 * 1000;
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      const { Stacks = [] } = JSON.parse(raw);
      for (const stack of Stacks) {
        if (!stack.StackName.startsWith(HARNESS_STACK_PREFIX)) continue;
        if (ONLY_STACK && stack.StackName !== ONLY_STACK) continue;
        // DELETE_IN_PROGRESS is already going; DELETE_COMPLETE is gone. A
        // DELETE_FAILED stack is exactly what needs another attempt.
        const status = String(stack.StackStatus);
        if (status === "DELETE_IN_PROGRESS" || status === "DELETE_COMPLETE") continue;
        const tagged = (stack.Tags || []).some(
          (tag) => tag.Key === HARNESS_TAG_KEY && tag.Value === HARNESS_TAG_VALUE,
        );
        if (!tagged) continue;
        const lastChange = Math.max(
          new Date(stack.CreationTime).getTime(),
          stack.LastUpdatedTime ? new Date(stack.LastUpdatedTime).getTime() : 0,
        );
        if (Date.now() - lastChange < maxAgeMs) continue;
        // What a hotswap moves: the server function for the Functions types, the
        // ECS service (as `ecs:<cluster>/<service>`) for the Containers types.
        const output = (key) => ((stack.Outputs || []).find((o) => o.OutputKey === key) || {}).OutputValue;
        const fn = output("ServerFunctionName");
        const cluster = output("EcsClusterName");
        const service = output("EcsServiceName");
        const probe = fn || (cluster && service ? `ecs:${cluster}/${service}` : "-");
        console.log([stack.StackName, status, lastChange, probe].join("\t"));
      }
    });
  '
)"

# Milliseconds since the epoch of the most recent sign that a stack is in use:
# its CloudFormation timestamps (from the listing) or what hotswaps update and
# CloudFormation does not - its server function's `LastModified`, or for a
# Containers stack (`ecs:<cluster>/<service>`) its ECS service's latest
# deployment. Read-only. A function or service that is gone (a DELETE_FAILED
# stack, say) contributes nothing. Any other read failure (throttling,
# AccessDenied) returns non-zero instead, and the caller keeps the stack: without
# that timestamp, the floor can't tell an abandoned stack from one being
# hotswapped into right now.
last_activity_ms() {
  local stack_ms="$1" function_name="$2"
  local modified=""
  if [ "${function_name#ecs:}" != "$function_name" ]; then
    local cluster service
    cluster="${function_name#ecs:}"
    service="${cluster#*/}"
    cluster="${cluster%%/*}"
    if ! modified="$(aws ecs describe-services --cluster "$cluster" --services "$service" \
      --query 'max_by(services[0].deployments, &updatedAt).updatedAt' --output text 2>&1)"; then
      case "$modified" in
        *ClusterNotFoundException*) modified="" ;;
        *)
          echo "sweep: cannot read $function_name's deployments: $modified" >&2
          return 1
          ;;
      esac
    fi
  elif [ "$function_name" != "-" ]; then
    if ! modified="$(aws lambda get-function-configuration --function-name "$function_name" \
      --query LastModified --output text 2>&1)"; then
      case "$modified" in
        *ResourceNotFoundException*) modified="" ;;
        *)
          echo "sweep: cannot read $function_name's LastModified: $modified" >&2
          return 1
          ;;
      esac
    fi
  fi
  node -e '
    const [stackMs, modified] = process.argv.slice(1);
    // An ISO timestamp from Lambda, and from ECS either that or epoch seconds,
    // depending on the CLI'"'"'s `cli_timestamp_format`.
    const fnMs = !modified || modified === "None" ? NaN
      : /^[\d.]+$/.test(modified) ? Number(modified) * 1000
      : new Date(modified).getTime();
    process.stdout.write(String(Math.max(Number(stackMs), Number.isNaN(fnMs) ? 0 : fnMs)));
  ' "$stack_ms" "$modified"
}

# True when `last_activity_ms` is at least MAX_AGE_HOURS ago.
old_enough() {
  local activity_ms="$1"
  node -e '
    const [ms, hours] = process.argv.slice(1).map(Number);
    process.exit(Date.now() - ms >= hours * 3_600_000 ? 0 : 1);
  ' "$activity_ms" "$MAX_AGE_HOURS"
}

age_hours() {
  node -e 'process.stdout.write(((Date.now() - Number(process.argv[1])) / 3_600_000).toFixed(1))' "$1"
}

# Apply the full floor now that the function timestamp can be read. Skipped when
# one stack is named, since that drops the floor altogether.
if [ -n "$CANDIDATES" ] && [ "$MAX_AGE_HOURS" != "0" ]; then
  FILTERED=""
  while IFS=$'\t' read -r name status stack_ms function_name <&4; do
    if ! activity="$(last_activity_ms "$stack_ms" "$function_name")"; then
      echo "sweep: keeping $name - could not confirm it is unused"
      continue
    fi
    if ! old_enough "$activity"; then
      echo "sweep: keeping $name - in use $(age_hours "$activity")h ago"
      continue
    fi
    FILTERED+="${name}"$'\t'"${status}"$'\t'"${activity}"$'\t'"${function_name}"$'\n'
  done 4<<<"$CANDIDATES"
  CANDIDATES="${FILTERED%$'\n'}"
fi

DESCRIPTION="harness stacks unused for ${MAX_AGE_HOURS}h"
if [ -n "$ONLY_STACK" ]; then
  DESCRIPTION="harness stack ${ONLY_STACK}"
fi

if [ -z "$CANDIDATES" ]; then
  echo "sweep: no ${DESCRIPTION}"
  exit 0
fi

echo "sweep: ${DESCRIPTION}:"
while IFS=$'\t' read -r name status activity _function_name <&4; do
  printf '  %s (%s, last used %sh ago)\n' "$name" "$status" "$(age_hours "$activity")"
done 4<<<"$CANDIDATES"

if [ "$APPLY" != "1" ]; then
  echo "sweep: dry run; re-run with --apply to delete the above"
  exit 0
fi

DELETED=()
# On fd 4 rather than stdin, here and above, so that nothing the loop body runs
# can read the list out from under it.
while IFS=$'\t' read -r name _status _activity function_name <&4; do
  # Re-check the tag immediately before deleting rather than trusting the listing.
  if ! harness_stack_is_ours "$name"; then
    echo "sweep: skipping $name - no longer tagged ${HARNESS_TAG_KEY}=${HARNESS_TAG_VALUE}"
    continue
  fi
  # And the floor, from a fresh function timestamp: a run may have deployed into
  # the stack since the listing. The CloudFormation side is re-read too, since a
  # full deployment moves `LastUpdatedTime` instead.
  if [ "$MAX_AGE_HOURS" != "0" ]; then
    stack_ms="$(aws cloudformation describe-stacks --stack-name "$name" --output json | node -e '
      let raw = "";
      process.stdin.on("data", (c) => (raw += c));
      process.stdin.on("end", () => {
        const [s] = JSON.parse(raw).Stacks;
        process.stdout.write(String(Math.max(
          new Date(s.CreationTime).getTime(),
          s.LastUpdatedTime ? new Date(s.LastUpdatedTime).getTime() : 0,
        )));
      });
    ')"
    if ! activity="$(last_activity_ms "$stack_ms" "$function_name")"; then
      echo "sweep: skipping $name - could not confirm it is unused"
      continue
    fi
    if ! old_enough "$activity"; then
      echo "sweep: skipping $name - deployed into since it was listed"
      continue
    fi
  fi
  echo "sweep: deleting $name"
  harness_stop_proxy "$name"
  aws cloudformation delete-stack --stack-name "$name"
  DELETED+=("$name")
done 4<<<"$CANDIDATES"

if [ "$WAIT" = "1" ]; then
  FAILED=0
  for name in "${DELETED[@]+"${DELETED[@]}"}"; do
    echo "sweep: waiting for $name to finish deleting"
    if ! aws cloudformation wait stack-delete-complete --stack-name "$name"; then
      FAILED=1
      echo "sweep: $name did not delete cleanly; its last failure events:" >&2
      aws cloudformation describe-stack-events --stack-name "$name" \
        --query "StackEvents[?ends_with(ResourceStatus, 'FAILED')] | [0:5].[LogicalResourceId, ResourceStatusReason]" \
        --output text >&2 || true
    fi
  done
  if [ "$FAILED" = "1" ]; then
    echo "sweep: at least one delete failed; the next sweep retries DELETE_FAILED stacks" >&2
    exit 1
  fi
fi

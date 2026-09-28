#!/usr/bin/env bash
#
# Deletes compatibility-harness stacks: a shard's own shared stack after its run
# (`--shared`), and orphans a cancelled, timed-out or dead shard left behind.
#
# Dry run by default: prints what it would delete and exits 0. Pass `--apply`
# to actually delete. Only stacks that are named
# `hrns-*` *and* tagged `cdk-nextjs:harness=1` *and* older than
# HARNESS_SWEEP_MAX_AGE_HOURS (default 6) are ever considered. "Older" is
# measured from the stack's last sign of use, not its creation: see
# `idle_hours` below.
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
# `hrns-*` stack in the account, including another shard's, or one a developer
# is running against right then (`HARNESS_SHARED_STACK_SUFFIX=dev-$USER`).
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

APPLY=0
ONLY_STACK=""
WAIT=0
while [ "$#" -gt 0 ]; do
  case "$1" in
  --apply) APPLY=1 ;;
  --dry-run) APPLY=0 ;;
  --wait) WAIT=1 ;;
  --shared) ONLY_STACK="$(harness_stack_name)" ;;
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
export HARNESS_STACK_PREFIX ONLY_STACK

# An age floor, not just a tag match: a concurrent run's stacks carry the same
# tag, and deleting one out from under a running test would look like an adapter
# bug. A harness deploy plus its test finishes well inside an hour.
#
# The floor is measured from a stack's last sign of use (`idle_hours`), not just
# CloudFormation's `CreationTime` / `LastUpdatedTime`: a shared stack is reused by
# name for hours and deployed into by hotswap, which never goes through
# CloudFormation, so neither timestamp moves. What does move is the server
# function's `LastModified` (or the ECS service's latest deployment), which every
# test file's hotswap rewrites.
#
# One stack by name is described by name. Listing every stack needs
# `cloudformation:ListStacks`, which CI's GitHubActionRole does not have, and
# without this a shard's own cleanup (`--shared`) failed on AccessDenied and
# left its stack behind. A named stack that is already gone is simply not a
# candidate.
list_stacks() {
  if [ -z "$ONLY_STACK" ]; then
    aws cloudformation describe-stacks --output json
    return
  fi
  local out
  if out="$(aws cloudformation describe-stacks --stack-name "$ONLY_STACK" --output json 2>&1)"; then
    printf '%s' "$out"
    return
  fi
  case "$out" in
    *"does not exist"*) printf '{"Stacks":[]}' ;;
    *)
      printf '%s\n' "$out" >&2
      return 1
      ;;
  esac
}

# The names of the tagged `hrns-*` stacks that are not already being deleted.
# DELETE_IN_PROGRESS is already going; DELETE_COMPLETE is gone. A DELETE_FAILED
# stack is exactly what needs another attempt.
LISTING="$(list_stacks)"
CANDIDATES="$(
  printf '%s' "$LISTING" | node -e '
    const { HARNESS_TAG_KEY, HARNESS_TAG_VALUE, HARNESS_STACK_PREFIX, ONLY_STACK } = process.env;
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      for (const stack of JSON.parse(raw).Stacks || []) {
        if (!stack.StackName.startsWith(HARNESS_STACK_PREFIX)) continue;
        if (ONLY_STACK && stack.StackName !== ONLY_STACK) continue;
        if (["DELETE_IN_PROGRESS", "DELETE_COMPLETE"].includes(stack.StackStatus)) continue;
        const tagged = (stack.Tags || []).some(
          (tag) => tag.Key === HARNESS_TAG_KEY && tag.Value === HARNESS_TAG_VALUE,
        );
        if (tagged) console.log(stack.StackName);
      }
    });
  '
)"

# One stack's status, CloudFormation timestamps and what a hotswap moves - the
# server function for the Functions types, the ECS service (as
# `ecs:<cluster>/<service>`) for the Containers types - tab-separated, read
# fresh rather than from the listing.
stack_facts() {
  local json
  json="$(aws cloudformation describe-stacks --stack-name "$1" --output json)" || return 1
  printf '%s' "$json" | node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      const [s] = JSON.parse(raw).Stacks;
      const output = (key) => ((s.Outputs || []).find((o) => o.OutputKey === key) || {}).OutputValue;
      const fn = output("ServerFunctionName");
      const cluster = output("EcsClusterName");
      const service = output("EcsServiceName");
      const probe = fn || (cluster && service ? `ecs:${cluster}/${service}` : "-");
      console.log([s.StackStatus, s.CreationTime, s.LastUpdatedTime || "-", probe].join("\t"));
    });
  '
}

# Hours, rounded down to 0.1, since the most recent of a stack's CloudFormation
# timestamps and its probe's last hotswap. Read-only. A function or service that
# is gone (a DELETE_FAILED stack, say) contributes nothing - including a service
# ECS reports MISSING in a cluster that is still there, which comes back with no
# `services` at all, hence the `|| []`. Any other read failure
# (throttling, AccessDenied) returns non-zero instead, and the caller keeps the
# stack: without that timestamp, the floor can't tell an abandoned stack from one
# being hotswapped into right now.
idle_hours() {
  local created="$1" updated="$2" probe="$3"
  local modified=""
  if [ "${probe#ecs:}" != "$probe" ]; then
    local cluster service
    cluster="${probe#ecs:}"
    service="${cluster#*/}"
    cluster="${cluster%%/*}"
    if ! modified="$(aws ecs describe-services --cluster "$cluster" --services "$service" \
      --query 'max_by(services[0].deployments || `[]`, &updatedAt).updatedAt' --output text 2>&1)"; then
      case "$modified" in
        *ClusterNotFoundException*) modified="" ;;
        *)
          echo "sweep: cannot read $probe's deployments: $modified" >&2
          return 1
          ;;
      esac
    fi
  elif [ "$probe" != "-" ]; then
    if ! modified="$(aws lambda get-function-configuration --function-name "$probe" \
      --query LastModified --output text 2>&1)"; then
      case "$modified" in
        *ResourceNotFoundException*) modified="" ;;
        *)
          echo "sweep: cannot read $probe's LastModified: $modified" >&2
          return 1
          ;;
      esac
    fi
  fi
  node -e '
    // ISO timestamps, and from ECS possibly epoch seconds, depending on the
    // CLI'"'"'s `cli_timestamp_format`.
    const ms = (t) => !t || t === "-" || t === "None" ? 0
      : /^[\d.]+$/.test(t) ? Number(t) * 1000
      : new Date(t).getTime() || 0;
    const hours = (Date.now() - Math.max(...process.argv.slice(1).map(ms))) / 3_600_000;
    process.stdout.write((Math.floor(hours * 10) / 10).toFixed(1));
  ' "$created" "$updated" "$modified"
}

# A named stack mid-operation (a full update a timed-out deploy left running
# server-side, or its rollback) can't be deleted until it settles:
# `delete-stack` is rejected, and under `set -e` that would end the sweep with
# the stack still up. So poll until it does, bounded at 20 minutes, and print
# the status it settled on - or nothing, if it is gone. Diagnostics on stderr.
# (DELETE_IN_PROGRESS is fine as it is: `delete-stack` on it is a no-op.)
settled_status() {
  local status
  for _ in $(seq 1 80); do
    status="$(harness_stack_status "$1")" || return 1
    case "$status" in
      REVIEW_IN_PROGRESS | DELETE_IN_PROGRESS) break ;;
      *_IN_PROGRESS)
        echo "sweep: $1 is $status; waiting for it to settle" >&2
        sleep 15
        ;;
      *) break ;;
    esac
  done
  printf '%s' "$status"
}

DESCRIPTION="harness stacks unused for ${MAX_AGE_HOURS}h"
if [ -n "$ONLY_STACK" ]; then
  DESCRIPTION="harness stack ${ONLY_STACK}"
fi

FOUND=0
DELETED=()
# On fd 4 rather than stdin, so that nothing the loop body runs can read the list
# out from under it.
while IFS= read -r name <&4; do
  [ -n "$name" ] || continue
  if ! facts="$(stack_facts "$name")"; then
    echo "sweep: skipping $name - could not re-read it"
    continue
  fi
  IFS=$'\t' read -r status created updated probe <<<"$facts"
  # An operation in flight is someone using the stack. An account-wide sweep
  # leaves it to the next sweep; a named one waits for it below. (A change set
  # that was never executed, REVIEW_IN_PROGRESS, never settles by itself.)
  if [ -z "$ONLY_STACK" ] && [ "$status" != "REVIEW_IN_PROGRESS" ] \
    && [ "${status%_IN_PROGRESS}" != "$status" ]; then
    echo "sweep: keeping $name - $status"
    continue
  fi
  # Skipped when one stack is named, since that drops the floor altogether.
  used=""
  if [ "$MAX_AGE_HOURS" != "0" ]; then
    if ! idle="$(idle_hours "$created" "$updated" "$probe")"; then
      echo "sweep: keeping $name - could not confirm it is unused"
      continue
    fi
    if ! awk -v idle="$idle" -v max="$MAX_AGE_HOURS" 'BEGIN { exit !(idle >= max) }'; then
      echo "sweep: keeping $name - in use ${idle}h ago"
      continue
    fi
    used=", last used ${idle}h ago"
  fi
  FOUND=1
  if [ "$APPLY" != "1" ]; then
    echo "sweep: would delete $name ($status$used)"
    continue
  fi
  if [ -n "$ONLY_STACK" ]; then
    # A hotswap an orphaned `cdk deploy` is still running is invisible to
    # CloudFormation, so `settled_status` alone would not wait for it.
    harness_wait_for_cdk "$name"
    if ! status="$(settled_status "$name")"; then
      echo "sweep: keeping $name - could not re-read its status" >&2
      exit 1
    fi
    case "$status" in
      "")
        echo "sweep: $name is already gone"
        continue
        ;;
      REVIEW_IN_PROGRESS | DELETE_IN_PROGRESS) ;;
      *_IN_PROGRESS)
        echo "sweep: $name is still $status after 20 minutes; not deleting it" >&2
        exit 1
        ;;
    esac
  fi
  # Re-check the tag immediately before deleting rather than trusting the
  # listing, and after the settle wait, which can outlast the stack it began on.
  if ! harness_stack_is_ours "$name"; then
    echo "sweep: skipping $name - no longer tagged ${HARNESS_TAG_KEY}=${HARNESS_TAG_VALUE}"
    continue
  fi
  echo "sweep: deleting $name ($status$used)"
  harness_stop_proxy "$name"
  aws cloudformation delete-stack --stack-name "$name"
  DELETED+=("$name")
done 4<<<"$CANDIDATES"

if [ "$FOUND" = "0" ]; then
  echo "sweep: no ${DESCRIPTION}"
  exit 0
fi
if [ "$APPLY" != "1" ]; then
  echo "sweep: dry run; re-run with --apply to delete the above"
  exit 0
fi

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

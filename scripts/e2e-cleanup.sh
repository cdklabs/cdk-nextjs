#!/usr/bin/env bash
#
# NEXT_TEST_CLEANUP_SCRIPT_PATH for the Next.js adapter compatibility harness.
# Runs with `cwd` set to the harness's temporary app after the test finishes,
# pass or fail.
#
# Deliberately does nothing in the default, shared-stack mode: every test file
# deploys into the same stack, so deleting it here would throw away the
# CloudFront distribution the *next* file is about to hotswap into and turn a
# 30-second deploy back into a 12-minute one. `scripts/e2e-sweep.sh` deletes it
# once, after the run.
#
# Under HARNESS_ISOLATED_STACK=1 there is a stack per test file, and then this is
# not optional: a cleanup that silently did nothing would leak dozens of stacks
# per run. `scripts/e2e-sweep.sh` is the backstop either way, for the cases this
# cannot cover (a killed shard, a timed-out job).
#
# @see https://nextjs.org/docs/app/api-reference/adapters/testing-adapters
set -euo pipefail

: "${ADAPTER_DIR:?must be set to the cdk-nextjs checkout (the harness passes it through)}"
# shellcheck source=scripts/e2e-harness/common.sh
source "$ADAPTER_DIR/scripts/e2e-harness/common.sh"

# Written by the deploy script; recomputed the same way if the deploy died first.
if [ -f "$HARNESS_STACK_FILE" ]; then
  STACK_NAME="$(cat "$HARNESS_STACK_FILE")"
else
  STACK_NAME="$(harness_stack_name "$PWD")"
fi

if [ "${HARNESS_ISOLATED_STACK:-0}" != "1" ]; then
  echo "cleanup: keeping shared stack $STACK_NAME for the next test file"
  echo "cleanup: delete it after the run with \`scripts/e2e-sweep.sh --apply --shared\`"
  exit 0
fi

# `delete-stack` on a stack that is already gone succeeds, so the idempotency
# that matters is not deleting something that was never ours: a name collision,
# or a hand-run of this script in the wrong directory. Nothing without the
# harness tag is touched.
if ! harness_stack_is_ours "$STACK_NAME"; then
  echo "cleanup: $STACK_NAME is not a harness stack (absent, or missing ${HARNESS_TAG_KEY}=${HARNESS_TAG_VALUE}); nothing to delete"
  exit 0
fi

echo "cleanup: deleting $STACK_NAME"
# The S3 buckets and the DynamoDB table are `RemovalPolicy.DESTROY` with
# `autoDeleteObjects` (src/nextjs-cache.ts, src/nextjs-static-assets.ts), so the
# stack delete empties them on its own. Deleting through CloudFormation rather
# than `cdk destroy` avoids re-synthesizing - which would re-run the adapter
# staging and the `sharp` install - and still works once the app directory has
# been cleaned up under us.
aws cloudformation delete-stack --stack-name "$STACK_NAME"

if [ "${HARNESS_CLEANUP_WAIT:-0}" = "1" ]; then
  echo "cleanup: waiting for $STACK_NAME to finish deleting"
  aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME"
  echo "cleanup: $STACK_NAME deleted"
else
  # Not waiting by default: a delete takes minutes and every test file pays it
  # serially otherwise. `scripts/e2e-sweep.sh` catches anything that fails.
  echo "cleanup: delete requested for $STACK_NAME (not waiting; set HARNESS_CLEANUP_WAIT=1 to block)"
fi

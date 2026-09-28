#!/usr/bin/env bash
#
# NEXT_TEST_CLEANUP_SCRIPT_PATH for the Next.js adapter compatibility harness.
# Runs with `cwd` set to the harness's temporary app after the test finishes,
# pass or fail.
#
# Deliberately does nothing: every test file deploys into the same stack, so
# deleting it here would throw away the CloudFront distribution the *next* file
# is about to hotswap into and turn a 30-second deploy back into a 12-minute
# one. `scripts/e2e-sweep.sh --apply --shared` deletes it once, after the run.
#
# @see https://nextjs.org/docs/app/api-reference/adapters/testing-adapters
set -euo pipefail

: "${ADAPTER_DIR:?must be set to the cdk-nextjs checkout (the harness passes it through)}"
# shellcheck source=scripts/e2e-harness/common.sh
source "$ADAPTER_DIR/scripts/e2e-harness/common.sh"

echo "cleanup: keeping shared stack $(harness_stack_name) for the next test file"
echo "cleanup: delete it after the run with \`scripts/e2e-sweep.sh --apply --shared\`"

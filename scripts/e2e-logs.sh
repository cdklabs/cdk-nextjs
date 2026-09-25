#!/usr/bin/env bash
#
# NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH for the Next.js adapter compatibility
# harness. Runs with `cwd` set to the harness's temporary app, in a separate
# process from the deploy script, and additionally gets NEXT_TEST_DIR and
# NEXT_TEST_DEPLOY_URL.
#
# Its output must start with the BUILD_ID / DEPLOYMENT_ID /
# NEXT_SUPPORTS_IMMUTABLE_ASSETS markers.
#
# What comes *after* them is not just failure diagnostics: in deploy mode this
# script's stdout **is** `next.cliOutput` (`next-deploy.ts`:
# `this._cliOutput = await this.fetchBuildLogsUsingCustomScript()`), so every test
# that asserts on `cliOutput` sees it. Vercel's own deploy mode puts only the
# *build* logs there, and a test like `test/e2e/deprecation-warnings` -
# `expect(cliOutput).not.toContain('is deprecated')` - fails on a deprecation
# notice printed by the CDK CLI or echoed out of a CloudWatch tail, neither of
# which the app emitted. So the default output stops at the build log, and the
# deploy log and runtime logs are opt-in via HARNESS_VERBOSE_LOGS=1 for when a
# deployment is actually being debugged.
#
# @see https://nextjs.org/docs/app/api-reference/adapters/testing-adapters
set -uo pipefail

: "${ADAPTER_DIR:?must be set to the cdk-nextjs checkout (the harness passes it through)}"
# shellcheck source=scripts/e2e-harness/common.sh
source "$ADAPTER_DIR/scripts/e2e-harness/common.sh"

# Never fail. The harness turns a non-zero exit here into
# "Custom deploy logs script failed", which replaces the deploy error that is
# the actual reason it asked for logs.
trap 'exit 0' ERR

LOG_LINES="${HARNESS_LOG_LINES:-400}"

# Markers first: `parseIdsFromCliOutput` takes the first match of each.
[ -f "$HARNESS_MARKERS_FILE" ] && cat "$HARNESS_MARKERS_FILE"

if [ -f "$HARNESS_BUILD_LOG" ]; then
  echo "=== $HARNESS_BUILD_LOG (last $LOG_LINES lines) ==="
  tail -n "$LOG_LINES" "$HARNESS_BUILD_LOG"
fi

# Everything below is off by default; see the header. The harness spawns this
# script with the environment `run-tests.js` was started in, so re-running one
# file with `HARNESS_VERBOSE_LOGS=1 node run-tests.js …` is all it takes.
if [ "${HARNESS_VERBOSE_LOGS:-0}" != "1" ]; then
  exit 0
fi

if [ -f "$HARNESS_DEPLOY_LOG" ]; then
  echo "=== $HARNESS_DEPLOY_LOG (last $LOG_LINES lines) ==="
  tail -n "$LOG_LINES" "$HARNESS_DEPLOY_LOG"
fi

# Runtime logs: a deployment that came up but answers wrongly leaves its
# evidence in CloudWatch, not in either log above.
if [ -f "$HARNESS_STACK_FILE" ]; then
  FUNCTION_NAME="$(harness_stack_output "$HARNESS_OUTPUTS_FILE" "$(cat "$HARNESS_STACK_FILE")" ServerFunctionName)"
  if [ -n "$FUNCTION_NAME" ]; then
    echo "=== /aws/lambda/$FUNCTION_NAME (last ${HARNESS_LOG_SINCE:-30m}) ==="
    aws logs tail "/aws/lambda/$FUNCTION_NAME" \
      --since "${HARNESS_LOG_SINCE:-30m}" \
      --format short 2>&1 | tail -n "$LOG_LINES" || true
  fi
fi

exit 0

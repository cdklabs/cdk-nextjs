#!/usr/bin/env bash
# Shared by scripts/e2e-deploy.sh, e2e-logs.sh, e2e-cleanup.sh and e2e-sweep.sh.
# Sourced, not executed.

# Files the three lifecycle scripts hand to each other. They run as separate
# processes with `cwd` set to the harness's temporary app, so everything one
# needs from another has to be on disk in that directory.
# See https://nextjs.org/docs/app/api-reference/adapters/testing-adapters
readonly HARNESS_MARKERS_FILE=".adapter-markers.log"
readonly HARNESS_BUILD_LOG=".adapter-build.log"
readonly HARNESS_DEPLOY_LOG=".adapter-deploy.log"
readonly HARNESS_OUTPUTS_FILE=".adapter-outputs.json"
readonly HARNESS_STACK_FILE=".adapter-stack.txt"
readonly HARNESS_CDK_OUT=".adapter-cdk-out"

# Every stack the harness creates carries these, and `e2e-cleanup.sh` /
# `e2e-sweep.sh` refuse to delete a stack that does not. A CloudFormation stack
# is the only record that survives the temporary app directory, so the tag is
# what makes an orphan identifiable later.
readonly HARNESS_TAG_KEY="cdk-nextjs:harness"
readonly HARNESS_TAG_VALUE="1"
readonly HARNESS_STACK_PREFIX="hrns-"

# A stable identifier for one harness app directory.
#
# Derived from the directory rather than random so that any script can recompute
# it without a handoff file. The harness's directory name is already unique per
# test (`next-test-<ms>-<rand>`), but tests with a `subDir` end in a shared
# basename like `app`, so the hash is of the full path.
harness_app_id() {
  local dir="$1"
  local base
  # `printf` rather than a bare `basename` pipe: `tr` would turn the trailing
  # newline into another separator, giving `<name>--<hash>`.
  base="$(printf '%s' "$(basename "$dir")" | tr -cs '[:alnum:]' '-')"
  local hash
  hash="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha1").update(process.argv[1]).digest("hex").slice(0, 8))' "$dir")"
  printf '%s-%s' "${base:0:60}" "$hash"
}

# The stack name to deploy a harness app directory into.
#
# One shared stack by default. The harness builds a *different* app per test
# file, so the deploy itself cannot be skipped - but the CloudFront distribution
# it goes behind can be created once instead of once per file, which is where
# ~12 of every 13 minutes went. That only works if every test file lands in the
# same stack, which in turn means:
#
#   - Test files must be serialized (`run-tests.js -c 1`). Two concurrent
#     deploys into one stack would race, and the second would see the first's
#     app.
#   - `e2e-cleanup.sh` must not delete the stack between files; the sweeper
#     deletes it once at the end of the run. See both scripts.
#   - Nothing may leak between files. Server cache entries are keyed by
#     `CDK_NEXTJS_BUILD_ID` (src/adapter/s3-cache-handler.ts), which differs per
#     file and hotswaps with the function, and `e2e-deploy.sh` invalidates the
#     distribution's edge cache before it reports the URL.
#
# Set HARNESS_ISOLATED_STACK=1 for a stack per app directory instead. Worth it
# when debugging one file, or to run two things at once - at the cost of a
# distribution create and delete per file.
harness_stack_name() {
  local dir="$1"
  if [ "${HARNESS_ISOLATED_STACK:-0}" != "1" ]; then
    printf '%s%s' "$HARNESS_STACK_PREFIX" "${HARNESS_SHARED_STACK_SUFFIX:-shared}"
    return 0
  fi
  printf '%s%s' "$HARNESS_STACK_PREFIX" "$(harness_app_id "$dir")"
}

# Read one CloudFormation output out of `cdk deploy --outputs-file`'s JSON.
# `node` rather than `jq`: node is already a hard requirement here, jq is not.
harness_read_output() {
  local file="$1" key="$2"
  # `break`, not `return`: `node -e` compiles its argument as a script body, and
  # a top-level `return` there is a SyntaxError.
  node -e '
    const [file, key] = process.argv.slice(1);
    const outputs = require("node:fs").existsSync(file)
      ? JSON.parse(require("node:fs").readFileSync(file, "utf8"))
      : {};
    // One stack per deploy, so take whichever stack is in there rather than
    // depending on the name.
    for (const stack of Object.values(outputs)) {
      if (stack && stack[key]) {
        process.stdout.write(String(stack[key]));
        break;
      }
    }
  ' "$file" "$key"
}

# Read one CloudFormation output, preferring `--outputs-file` and falling back
# to CloudFormation itself.
#
# The fallback is what makes the shared stack workable: `--hotswap-fallback` can
# finish without going through CloudFormation at all, and a deploy that took the
# hotswap path is not guaranteed to leave an outputs file behind. The outputs of
# a hotswapped stack are unchanged from its last real deployment, so reading them
# off the stack is equivalent.
harness_stack_output() {
  local file="$1" stack="$2" key="$3"
  local value
  value="$(harness_read_output "$file" "$key")"
  if [ -n "$value" ]; then
    printf '%s' "$value"
    return 0
  fi
  value="$(aws cloudformation describe-stacks --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" \
    --output text 2>/dev/null)" || return 0
  # `--output text` prints `None` for an empty result, which is not a value.
  [ "$value" = "None" ] && return 0
  printf '%s' "$value"
}

# True when the named stack exists and carries the harness tag. Read-only, and
# the gate on every delete: nothing else in the account can be removed by these
# scripts even if a stack name is passed in by hand.
harness_stack_is_ours() {
  local stack="$1"
  local tags
  tags="$(aws cloudformation describe-stacks --stack-name "$stack" \
    --query "Stacks[0].Tags[?Key=='${HARNESS_TAG_KEY}'].Value" \
    --output text 2>/dev/null)" || return 1
  [ "$tags" = "$HARNESS_TAG_VALUE" ]
}

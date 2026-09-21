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

# The stack name for a harness app directory.
#
# Derived from the directory rather than random so that `e2e-cleanup.sh` can
# recover it even if the deploy script died before writing
# `$HARNESS_STACK_FILE`. The harness's directory name is already unique per test
# (`next-test-<ms>-<rand>`), but tests with a `subDir` end in a shared basename
# like `app`, so the hash is of the full path.
harness_stack_name() {
  local dir="$1"
  local base
  # `printf` rather than a bare `basename` pipe: `tr` would turn the trailing
  # newline into another separator, giving `hrns-<name>--<hash>`.
  base="$(printf '%s' "$(basename "$dir")" | tr -cs '[:alnum:]' '-')"
  local hash
  hash="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha1").update(process.argv[1]).digest("hex").slice(0, 8))' "$dir")"
  printf '%s%s-%s' "$HARNESS_STACK_PREFIX" "${base:0:60}" "$hash"
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

#!/usr/bin/env bash
# Shared by scripts/e2e-deploy.sh, e2e-logs.sh, e2e-warm.sh and e2e-sweep.sh.
# Sourced, not executed.

# Files the two lifecycle scripts hand to each other. They run as separate
# processes with `cwd` set to the harness's temporary app, so everything one
# needs from another has to be on disk in that directory.
# See https://nextjs.org/docs/app/api-reference/adapters/testing-adapters
readonly HARNESS_MARKERS_FILE=".adapter-markers.log"
readonly HARNESS_BUILD_LOG=".adapter-build.log"
readonly HARNESS_DEPLOY_LOG=".adapter-deploy.log"
readonly HARNESS_STACK_FILE=".adapter-stack.txt"
readonly HARNESS_CDK_OUT=".adapter-cdk-out"

# Every stack the harness creates carries these, and `e2e-sweep.sh` refuses to
# delete a stack that does not. A CloudFormation stack is the only record that
# survives the temporary app directory, so the tag is what makes an orphan
# identifiable later. Exported because `app.js` writes the tag from them.
readonly HARNESS_TAG_KEY="cdk-nextjs:harness"
readonly HARNESS_TAG_VALUE="1"
export HARNESS_TAG_KEY HARNESS_TAG_VALUE
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

# The stack name every harness app directory deploys into.
#
# One shared stack. The harness builds a *different* app per test file, so the
# deploy itself cannot be skipped - but the CloudFront distribution it goes behind
# can be created once instead of once per file, which is where most of the
# wall-clock went. That only works if every test file lands in the
# same stack, which in turn means:
#
#   - Test files must be serialized (`run-tests.js -c 1`). Two concurrent
#     deploys into one stack would race, and the second would see the first's
#     app.
#   - Nothing may delete the stack between files, which is why the harness gets
#     no NEXT_TEST_CLEANUP_SCRIPT_PATH; `e2e-sweep.sh --apply --shared` deletes
#     it once at the end of the run.
#   - Nothing may leak between files. Server cache entries are keyed by
#     `CDK_NEXTJS_BUILD_ID` (src/adapter/s3-cache-handler.ts), which differs per
#     file and hotswaps with the function, and `e2e-deploy.sh` invalidates the
#     distribution's edge cache before it reports the URL.
#
# HARNESS_SHARED_STACK_SUFFIX is how a run gets parallel anyway: N processes,
# each with a shared stack of its own and its own disjoint slice of the file
# list (`run-tests.js -g <n>/<N>`), still serial *within* a slice. That is what
# .github/workflows/e2e-harness.yml's matrix does, one stack per shard. Two
# concurrent runs must not reuse a suffix, for the same reason two files in one
# shard cannot overlap.
#
# A developer debugging one file gets a stack of their own the same way
# (`HARNESS_SHARED_STACK_SUFFIX=dev-$USER`), and deletes it with
# `e2e-sweep.sh --apply --shared`.
#
# Every type but `global-functions` (HARNESS_NEXTJS_TYPE) gets its own infix
# after the prefix - `rf-`, `gc-`, `rc-` - so a run can never deploy into another
# type's shared stack: a different root construct in the same stack would be a
# replacement of nearly everything in it. The prefix is unchanged, so
# `e2e-sweep.sh` finds them all.
harness_stack_name() {
  local prefix="$HARNESS_STACK_PREFIX"
  local type
  # Assigned on its own line so a rejected type fails this function instead of
  # comparing as "" and quietly naming a Global stack.
  type="$(harness_nextjs_type)" || return 1
  case "$type" in
    regional-functions) prefix="${prefix}rf-" ;;
    global-containers) prefix="${prefix}gc-" ;;
    regional-containers) prefix="${prefix}rc-" ;;
  esac
  printf '%s%s' "$prefix" "${HARNESS_SHARED_STACK_SUFFIX:-shared}"
}

# Which root construct `app.js` deploys: `global-functions` (the default),
# `regional-functions`, `global-containers` or `regional-containers`. Exits on
# anything else, rather than quietly deploying the default under a name that says
# otherwise.
#
# When called as `$(harness_nextjs_type)`, that `exit` only ends the command
# substitution's subshell, which is why this file also runs it once at the top
# level (at the bottom), where it ends the script that sourced it.
harness_nextjs_type() {
  local type="${HARNESS_NEXTJS_TYPE:-global-functions}"
  case "$type" in
    global-functions | regional-functions | global-containers | regional-containers)
      printf '%s' "$type"
      ;;
    *)
      echo "harness: HARNESS_NEXTJS_TYPE=$type is not global-functions, regional-functions, global-containers or regional-containers" >&2
      exit 1
      ;;
  esac
}

# The localhost port `stage-proxy.mjs` listens on for a stack. Derived from the
# stack name, so every script - and every shard - computes the same port for the
# same stack with no handoff file, and two shards' proxies do not collide.
harness_proxy_port() {
  local stack="$1"
  node -e '
    const hash = require("node:crypto").createHash("sha1").update(process.argv[1]).digest();
    process.stdout.write(String(40000 + (hash.readUInt16BE(0) % 10000)));
  ' "$stack"
}

# Where a stack's proxy records its pid and target, so the next test file can
# reuse it. In TMPDIR rather than the app directory: the proxy outlives the app.
harness_proxy_state() {
  local stack="$1"
  printf '%s/%s-stage-proxy' "${TMPDIR:-/tmp}" "$stack"
}

# Read one CloudFormation output off the stack, or nothing if it has none.
harness_stack_output() {
  local stack="$1" key="$2"
  local value
  value="$(aws cloudformation describe-stacks --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" \
    --output text 2>/dev/null)" || return 0
  # `--output text` prints `None` for an empty result, which is not a value.
  [ "$value" = "None" ] && return 0
  printf '%s' "$value"
}

# Print the named stack's StackStatus, or nothing if CloudFormation says it
# does not exist. Any other failure (AccessDenied, throttling, no credentials)
# returns non-zero with the CLI's error on stderr, so a caller can't mistake a
# stack it isn't allowed to read for a stack that is missing.
harness_stack_status() {
  local stack="$1"
  local out
  if out="$(aws cloudformation describe-stacks --stack-name "$stack" \
    --query "Stacks[0].StackStatus" --output text 2>&1)"; then
    printf '%s' "$out"
    return 0
  fi
  case "$out" in
    *"does not exist"*) return 0 ;;
  esac
  printf '%s\n' "$out" >&2
  return 1
}

# Wait, bounded at 30 minutes, for an orphaned `cdk deploy` of the named stack
# to exit. A deploy that outran its caller's timeout was killed, but its
# `cdk deploy` can outlive it - and a hotswap runs in that process, invisible to
# CloudFormation, so no stack status says it is still going.
harness_wait_for_cdk() {
  local stack="$1"
  for _ in $(seq 1 120); do
    pgrep -f -- "deploy $stack --app" >/dev/null || return 0
    echo "harness: an earlier cdk deploy of $stack is still running; waiting" >&2
    sleep 15
  done
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

# The pid in a stack's proxy state file, if that process is still running and is
# still `stage-proxy.mjs`. A pid file outlives its proxy (a crash, a reboot), and
# the pid can by then belong to anything else of the user's, so nothing may
# signal or reuse it on the file's word alone.
harness_proxy_pid() {
  local state pid
  state="$(harness_proxy_state "$1")"
  pid="$(cat "$state.pid" 2>/dev/null)" || return 1
  case "$(ps -p "$pid" -o command= 2>/dev/null)" in
    *stage-proxy.mjs*) printf '%s' "$pid" ;;
    *) return 1 ;;
  esac
}

# Stop a stack's `stage-proxy.mjs`, if one is running here. Called next to every
# stack delete, so a proxy never outlives the API it forwards to. A no-op for a
# Global stack, which never has one.
harness_stop_proxy() {
  local state pid
  state="$(harness_proxy_state "$1")"
  if pid="$(harness_proxy_pid "$1")"; then
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$state.pid" "$state.target"
}

# Validate HARNESS_NEXTJS_TYPE as soon as any harness script sources this file.
# Not in a subshell, so `harness_nextjs_type`'s `exit 1` ends the sourcing script.
harness_nextjs_type >/dev/null

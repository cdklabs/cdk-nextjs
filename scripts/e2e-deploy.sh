#!/usr/bin/env bash
#
# NEXT_TEST_DEPLOY_SCRIPT_PATH for the Next.js adapter compatibility harness.
#
# Runs with `cwd` set to the isolated temporary app the harness created for one
# test file, and must print the deployment URL - and nothing else - to stdout.
#
# @see https://nextjs.org/docs/app/api-reference/adapters/testing-adapters
# @see scripts/e2e-harness/README.md
set -euo pipefail

# stdout is the URL channel. Keep a copy of it on fd 3 and point fd 1 at stderr
# so that every command below, and anything it spawns, is diagnostics.
exec 3>&1
exec 1>&2

: "${ADAPTER_DIR:?must be set to the cdk-nextjs checkout (the harness passes it through)}"
HARNESS_DIR="$ADAPTER_DIR/scripts/e2e-harness"
# shellcheck source=scripts/e2e-harness/common.sh
source "$HARNESS_DIR/common.sh"

APP_DIR="$PWD"
CDK_BIN="${CDK_BIN:-$ADAPTER_DIR/node_modules/.bin/cdk}"
ADAPTER_ENTRY="$ADAPTER_DIR/lib/adapter/adapter.mjs"
CACHE_HANDLER_ENTRY="$ADAPTER_DIR/lib/adapter/cache-handler.mjs"
# `cacheHandlers.default` / `.remote`, resolved the same way (src/adapter/adapter.mts).
USE_CACHE_HANDLER_ENTRIES=(
  "$ADAPTER_DIR/lib/adapter/use-cache-default-handler.mjs"
  "$ADAPTER_DIR/lib/adapter/use-cache-remote-handler.mjs"
)

for required in "$ADAPTER_ENTRY" "$CACHE_HANDLER_ENTRY" "${USE_CACHE_HANDLER_ENTRIES[@]}" "$ADAPTER_DIR/lib/index.js"; do
  if [ ! -f "$required" ]; then
    echo "harness: $required is missing. Run \`pnpm bundle && pnpm compile\` in $ADAPTER_DIR." >&2
    exit 1
  fi
done
if [ ! -x "$CDK_BIN" ]; then
  echo "harness: no CDK CLI at $CDK_BIN. Run \`pnpm i\` in $ADAPTER_DIR, or set CDK_BIN." >&2
  exit 1
fi

STACK_NAME="$(harness_stack_name)"
printf '%s\n' "$STACK_NAME" >"$HARNESS_STACK_FILE"
echo "harness: app=$APP_DIR stack=$STACK_NAME"

# A previous file's deploy that outran its per-file timeout was killed here, but
# its `cdk deploy` can outlive it (a hotswap runs in that process, invisible to
# CloudFormation), and a full update keeps going server-side. Deploying over
# either would fail or interleave two fixtures, so wait for both to settle.
# Bounded at 30 minutes; the status checks below and `cdk deploy` itself report
# what is left.
for _ in $(seq 1 120); do
  if pgrep -f -- "deploy $STACK_NAME --app" >/dev/null; then
    echo "harness: an earlier cdk deploy of $STACK_NAME is still running; waiting"
  else
    STACK_STATUS="$(harness_stack_status "$STACK_NAME")" || break
    case "$STACK_STATUS" in
      *_IN_PROGRESS) echo "harness: $STACK_NAME is $STACK_STATUS; waiting" ;;
      *) break ;;
    esac
  fi
  sleep 15
done

# Create the shared stack with `e2e-warm.sh`'s throwaway app rather than with
# this fixture, so the ~4-minute CloudFront create is not charged against this
# file's NEXT_E2E_TEST_TIMEOUT. CI warms every shard before the suite starts;
# this covers a local run that did not. HARNESS_WARMING is how `e2e-warm.sh`'s
# own deploy says it is the warm-up.
#
# A stack in ROLLBACK_COMPLETE (a failed create) or a DELETE_* state counts as
# missing too: `cdk deploy` would delete and recreate it from this fixture.
if [ "${HARNESS_WARMING:-0}" != "1" ]; then
  if ! SHARED_STATUS="$(harness_stack_status "$STACK_NAME")"; then
    echo "harness: cannot read $STACK_NAME's status (see above); not guessing whether it exists" >&2
    exit 1
  fi
  case "$SHARED_STATUS" in
    "" | ROLLBACK_COMPLETE | DELETE_*)
      echo "harness: $STACK_NAME is ${SHARED_STATUS:-missing}; creating it with scripts/e2e-warm.sh first"
      ADAPTER_DIR="$ADAPTER_DIR" "$ADAPTER_DIR/scripts/e2e-warm.sh"
      ;;
  esac
fi

# The harness creates the app with `skipInstall`, so there is no node_modules yet.
#
# Which package manager installs it is the app's choice, not ours: a fixture can
# override `packageJson.packageManager` (`test/lib/next-modes/base.ts` merges it in
# verbatim), and `corepack pnpm` then hard-refuses with "This project is configured
# to use npm because …/package.json has a packageManager field" - which is how
# test/e2e/handle-non-hoisted-swc-helpers, the one fixture that pins `npm@10.9.2`,
# failed its deploy outright. So read the field and honor it.
#
# corepack is only used for pnpm, where the pinned version matters and this repo
# already relies on it. `npm` ships with node, and going through corepack would
# add a download of a specific npm build for no benefit.
PM="$(node -e 'const f=require("path").join(process.argv[1],"package.json");let s="pnpm";try{s=(require(f).packageManager||"pnpm").split("@")[0]}catch{};process.stdout.write(s)' "$APP_DIR")"
case "$PM" in
  pnpm)
    if command -v corepack >/dev/null 2>&1; then PM_CMD=(corepack pnpm); else PM_CMD=(pnpm); fi
    # Without it pnpm walks up out of /tmp looking for a workspace root.
    INSTALL_ARGS=(--ignore-workspace --prefer-offline)
    ;;
  *)
    PM_CMD=("$PM")
    # No `--prefer-offline` here, deliberately. pnpm treats it as a hint and falls
    # back to the network when a cached packument has no matching version; npm
    # treats the stale packument as the answer and fails outright with
    #
    #   npm error code ETARGET
    #   npm error notarget No matching version found for next@16.3.5.
    #
    # even though the registry does have it. Any recently published version in the
    # tree hits this - reproduced with `next` itself and, on a warmer cache, with
    # its transitive `postcss@8.5.23` - so it fails whenever this machine's npm
    # cache predates the `next` release the fixtures pin. It is what made
    # test/e2e/handle-non-hoisted-swc-helpers, the one fixture that pins
    # `npm@10.9.2`, look like a deploy failure.
    INSTALL_ARGS=(--no-audit --no-fund)
    ;;
esac
echo "harness: package manager $PM (${PM_CMD[*]})"
# The `build` script the harness writes always chains `pnpm post-build`
# (hardcoded in base.ts), so pnpm has to be on PATH whatever $PM is - and for a
# fixture that pins a *different* package manager, pnpm refuses to run any script
# at all:
#
#   ERROR  This project is configured to use npm
#
# which is pnpm honoring `packageJson.packageManager`. There is no way to reach
# next.js's hardcoded `pnpm post-build`, so the check has to be turned off rather
# than routed around. This is the documented opt-out and it only affects the
# packageManager assertion, not resolution or the lockfile. Exported for the
# `next build` below, which is what runs the chained script.
export npm_config_package_manager_strict=false
# Without AWS credentials: this is where third-party install scripts run, and
# nothing in an install needs AWS. In a subshell so the deploy below keeps them.
# The config and credentials files are pointed away too, for a local run whose
# credentials live there rather than in the environment.
(
  while IFS= read -r var; do unset "$var"; done < <(compgen -e | grep '^AWS_')
  export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null
  "${PM_CMD[@]}" install "${INSTALL_ARGS[@]}"
)

# Make the adapter resolvable as a package rather than a loose file: the adapter
# resolves its own cache handler with
# `import.meta.resolve("cdk-nextjs/cache-handler")` (src/adapter/adapter.mts), so
# it has to be reachable through a package boundary with this repo's `exports`
# map. Same shape as `examples/app-playground`'s `sync-cdk-nextjs` script. After
# `pnpm install`, which prunes directories it does not know about.
LOCAL_PKG="node_modules/cdk-nextjs"
mkdir -p "$LOCAL_PKG/lib/adapter"
cp "$ADAPTER_DIR/package.json" "$LOCAL_PKG/package.json"
# Every bundle, not the list checked above, so a new `exports` entry is copied
# without anyone remembering to add it here.
cp "$ADAPTER_DIR"/lib/adapter/*.mjs "$LOCAL_PKG/lib/adapter/"
# `next build` reads this into `config.adapterPath`
# (next/dist/server/config-shared.js), which is how the harness's fixtures - who
# know nothing about cdk-nextjs - get built through our adapter.
export NEXT_ADAPTER_PATH="$APP_DIR/$LOCAL_PKG/lib/adapter/adapter.mjs"
# Feeds the fixture's own `post-build` marker line, and the runtime's
# `?dpl=` skew handling if a test exercises it. Per app directory rather than per
# stack: with one shared stack the stack name is a constant, and two builds
# sharing a deployment ID is exactly the skew this is supposed to detect.
export NEXT_DEPLOYMENT_ID="$(harness_app_id "$APP_DIR")"
export NEXT_TELEMETRY_DISABLED=1
# The harness appends a snippet to every fixture's next.config that aliases this
# to `__NEXT_TEST_MODE` (`test/lib/next-modes/base.ts`, "alias __NEXT_TEST_MODE
# for next-deploy"), and `define-env.ts` inlines `process.env.__NEXT_TEST_MODE`
# into the server bundle at build time. Unset, it inlines as `false` and the
# test-only branches are dead-code eliminated - including the
# `<!-- PPR_BOUNDARY_SENTINEL -->` chunk that separates a PPR response's static
# shell from its dynamic part. `splitResponseWithPPRSentinel`
# (`test/lib/e2e-utils/ppr.ts`) then puts the entire document in `staticPart`, and
# every `expect(result.static$('#dynamic-thing').length).toBe(0)` fails. Vercel
# passes it as `--build-env NEXT_PRIVATE_TEST_MODE=e2e`; this is the same thing.
export NEXT_PRIVATE_TEST_MODE=e2e

echo "harness: building with NEXT_ADAPTER_PATH=$NEXT_ADAPTER_PATH"
# `run build`, not `build`: pnpm accepts the bare script name but npm does not.
"${PM_CMD[@]}" run build 2>&1 | tee "$HARNESS_BUILD_LOG"

# The markers the harness parses out of the logs script's output
# (`test/lib/next-modes/next-deploy.ts`'s `parseIdsFromCliOutput`). The fixture's
# chained `post-build` prints its own copy into the build log; ours is written
# first and `.match()` takes the first hit, so these win.
#
# DEPLOYMENT_ID has to be the value the *build* inlined, not the stack name: next
# inlines `NEXT_DEPLOYMENT_ID` into every asset URL as `?dpl=`, and the harness
# compares those URLs against this marker (`base.ts`'s `getDeploymentIdQuery`).
# Reporting the stack name made `mdx`'s "should work with next/image" fail on a
# `?dpl=hrns-shared` that the app never emits.
BUILD_ID="$(cat .next/BUILD_ID)"
{
  echo "BUILD_ID: $BUILD_ID"
  echo "DEPLOYMENT_ID: $NEXT_DEPLOYMENT_ID"
  # Flip to 1 once cdk-nextjs opts into `config.supportsImmutableAssets`; until
  # then static assets are re-uploaded per deploy under the same keys.
  echo "NEXT_SUPPORTS_IMMUTABLE_ASSETS: ${HARNESS_SUPPORTS_IMMUTABLE_ASSETS:-0}"
} >"$HARNESS_MARKERS_FILE"

export HARNESS_APP_DIR="$APP_DIR"
export HARNESS_STACK_NAME="$STACK_NAME"
echo "harness: deploying $STACK_NAME"
# Into one shared stack, so that only the first test file of a run pays for
# creating and propagating a CloudFront distribution. `--hotswap-fallback` takes
# the fast path when everything that changed is the function's code, its
# environment or a bucket deployment, and a full CloudFormation deployment
# otherwise. The one remaining reason for the latter is the distribution's cache
# behaviors, which change when a fixture's `public/` differs from the last one's -
# see the table in scripts/e2e-harness/README.md for what actually differs between
# two fixtures.
#
# `--output` inside the app directory: a shared cdk.out would have two shards'
# test files overwrite each other's assembly.
#
# The container types hotswap too - a new image and a changed environment are
# both task-definition changes - but a hotswap into ECS is a rolling deployment,
# and by default it keeps the old task serving until the new one is healthy.
# Minimum 0% lets ECS stop the previous fixture's task without waiting for that.
# Maximum stays at 200%: 100% would force stop-then-start, but the service has
# Availability Zone Rebalancing on, which rejects any maximum <= 100% with an
# `InvalidParameterException`. The overlap that leaves is covered twice: the
# hotswap blocks until the service is stable (one deployment left, running the
# desired count), and the target-group wait below until only the new task is
# registered. Bounded, because a fixture whose server never comes up would
# otherwise hold the shard until the job's timeout; the test file fails either
# way.
HOTSWAP_ARGS=(--hotswap-fallback)
case "$(harness_nextjs_type)" in
  *-containers)
    HOTSWAP_ARGS+=(
      --hotswap-ecs-minimum-healthy-percent 0
      --hotswap-ecs-maximum-healthy-percent 200
      --hotswap-ecs-stabilization-timeout-seconds "${HARNESS_ECS_STABILIZATION_TIMEOUT:-600}"
    )
    ;;
esac
"$CDK_BIN" deploy "$STACK_NAME" \
  --app "node $HARNESS_DIR/app.js" \
  --output "$APP_DIR/$HARNESS_CDK_OUT" \
  "${HOTSWAP_ARGS[@]}" \
  --require-approval never \
  --ci 2>&1 | tee "$HARNESS_DEPLOY_LOG"

URL="$(harness_stack_output "$STACK_NAME" HarnessUrl)"
if [ -z "$URL" ]; then
  echo "harness: deploy reported success but $STACK_NAME has no HarnessUrl output" >&2
  exit 1
fi

NEXTJS_TYPE="$(harness_nextjs_type)"
case "$NEXTJS_TYPE" in
  *-containers)
    # A hotswap into ECS returns once `runningCount` reaches `desiredCount`, which
    # is before the load balancer routes to the new task: it is still in the
    # target group's `initial` health check, and the ALB answers 503 until it
    # passes. A full CloudFormation update waits for that, but leaves the old task
    # `draining` behind it, still answering. So wait here, either way, until the
    # target group holds exactly one target and it is `healthy`.
    TARGET_GROUP_ARN="$(harness_stack_output "$STACK_NAME" TargetGroupArn)"
    if [ -z "$TARGET_GROUP_ARN" ]; then
      echo "harness: $STACK_NAME has no TargetGroupArn output; cannot wait for the new task" >&2
      exit 1
    fi
    TARGETS=""
    for _ in $(seq 1 60); do
      TARGETS="$(aws elbv2 describe-target-health --target-group-arn "$TARGET_GROUP_ARN" \
        --query 'TargetHealthDescriptions[].TargetHealth.State' --output text)"
      [ "$TARGETS" = "healthy" ] && break
      sleep 5
    done
    if [ "$TARGETS" != "healthy" ]; then
      echo "harness: $TARGET_GROUP_ARN never settled on one healthy target (last: ${TARGETS:-none})" >&2
      exit 1
    fi
    echo "harness: new task healthy in $TARGET_GROUP_ARN"
    ;;
esac

if [ "$NEXTJS_TYPE" = "regional-containers" ]; then
  # Nothing more to do: no distribution to invalidate, and no stage to put back.
  :
elif [ "$NEXTJS_TYPE" = "regional-functions" ]; then
  # No distribution to invalidate - API Gateway caches nothing unless told to.
  # What there is instead is the stage in `$URL`, which the harness would strip
  # from every request (see stage-proxy.mjs), so the suite is pointed at a
  # localhost proxy that puts it back.
  #
  # One proxy per stack, reused by every test file: the API ID survives hotswaps
  # and full updates alike, so the target does not change. It is restarted only
  # when it is gone or its target differs (a stack that was deleted and
  # recreated).
  PROXY_PORT="$(harness_proxy_port "$STACK_NAME")"
  PROXY_STATE="$(harness_proxy_state "$STACK_NAME")"
  if PROXY_PID="$(harness_proxy_pid "$STACK_NAME")" \
    && [ "$(cat "$PROXY_STATE.target" 2>/dev/null)" = "$URL" ]; then
    echo "harness: reusing stage proxy $PROXY_PID on :$PROXY_PORT"
  else
    harness_stop_proxy "$STACK_NAME"
    # Detached, and with none of this script's descriptors: the harness reads
    # the URL from our stdout until EOF, so a child still holding fd 3 (or the
    # stderr pipe) would hang it.
    nohup node "$HARNESS_DIR/stage-proxy.mjs" "$PROXY_PORT" "$URL" \
      </dev/null >"$PROXY_STATE.log" 2>&1 3>&- &
    PROXY_PID="$!"
    printf '%s' "$PROXY_PID" >"$PROXY_STATE.pid"
    printf '%s' "$URL" >"$PROXY_STATE.target"
    # Ready when *this* proxy says it is listening - it logs that from the
    # `listen` callback - not when something answers on the port: a leftover
    # proxy for another stack answering there would have the suite test the
    # wrong deployment, while ours died on EADDRINUSE.
    PROXY_UP=0
    for _ in $(seq 1 50); do
      if grep -q "^stage-proxy: http://127.0.0.1:$PROXY_PORT " "$PROXY_STATE.log" 2>/dev/null; then
        PROXY_UP=1
        break
      fi
      kill -0 "$PROXY_PID" 2>/dev/null || break
      sleep 0.1
    done
    if [ "$PROXY_UP" != "1" ]; then
      echo "harness: stage proxy for $STACK_NAME did not start on :$PROXY_PORT; its log:" >&2
      cat "$PROXY_STATE.log" >&2 || true
      kill "$PROXY_PID" 2>/dev/null || true
      rm -f "$PROXY_STATE.pid" "$PROXY_STATE.target"
      exit 1
    fi
    echo "harness: started stage proxy $PROXY_PID on :$PROXY_PORT -> $URL"
  fi
  URL="http://127.0.0.1:$PROXY_PORT"

  # Then wait out the stage switch. A fixture whose `basePath` differs from the
  # last one's changes the API's resource tree, so the deploy is a full
  # CloudFormation update with a new stage deployment - and CloudFormation reports
  # it complete before the stage serves it. Measured: the first requests after
  # such a deploy answered 500, or a 403 `MissingAuthenticationTokenException`
  # for the resource tree that was just replaced, with nothing in the Lambda's
  # log. So wait until API Gateway stops answering with its own errors
  # (`x-amzn-errortype`) or a 5xx. Bounded: a fixture can answer 500 on purpose,
  # and that is the test's to report.
  #
  # One probe per kind of resource the tree has, because they did not become
  # ready together: the base resource answered while `_next/static` (the S3
  # integration) and the `{proxy+}` catch-all under it still 500'd. The build
  # manifest is a real object; the catch-all probe is a path the app 404s.
  BASE_PATH="$(node -e 'try{process.stdout.write(require(process.argv[1]).config.basePath||"")}catch{}' "$APP_DIR/.next/required-server-files.json")"
  PROBES=("$BASE_PATH/" "$BASE_PATH/_next/static/$BUILD_ID/_buildManifest.js" "$BASE_PATH/__cdk-nextjs-harness-probe")
  api_gateway_ready() {
    local path head status
    for path in "${PROBES[@]}"; do
      head="$(curl -s -o /dev/null -D - "$URL$path" || true)"
      status="$(printf '%s' "$head" | awk 'NR==1{print $2}')"
      if [ -z "$status" ] || [ "${status:0:1}" = "5" ] \
        || printf '%s' "$head" | grep -qi '^x-amzn-errortype:'; then
        STATUS="$path -> ${status:-no answer}"
        return 1
      fi
    done
    STATUS="all ${#PROBES[@]} probes"
  }
  # Five rounds in a row, not one: the new deployment reaches API Gateway's fleet
  # unevenly, and a test got the replaced tree's 403 right after all three
  # probes had passed once. 40 x 3s overall: the replaced tree was measured
  # still answering ~90s after CloudFormation reported UPDATE_COMPLETE.
  READY_ROUNDS=0
  for _ in $(seq 1 40); do
    if api_gateway_ready; then
      READY_ROUNDS=$((READY_ROUNDS + 1))
      [ "$READY_ROUNDS" -ge 5 ] && break
    else
      READY_ROUNDS=0
    fi
    sleep 3
  done
  echo "harness: $URL ready: $STATUS"
else
  # Then evict the previous test file's app from the edge.
  #
  # Two things make this mandatory rather than hygienic: the stack is shared, so
  # the distribution has the last fixture's responses cached under the very paths
  # this one is about to request; and a hotswap never runs CloudFormation, so the
  # post-deploy custom resource that would normally invalidate never fires (its
  # properties are pinned in app.js for exactly that reason). Blocking until it
  # completes, because the first request the harness makes is the one that would
  # read a stale response.
  DISTRIBUTION_ID="$(harness_stack_output "$STACK_NAME" DistributionId)"
  if [ -z "$DISTRIBUTION_ID" ]; then
    echo "harness: $STACK_NAME has no DistributionId output; cannot invalidate" >&2
    exit 1
  fi
  echo "harness: invalidating $DISTRIBUTION_ID"
  INVALIDATION_ID="$(aws cloudfront create-invalidation \
    --distribution-id "$DISTRIBUTION_ID" \
    --paths '/*' \
    --query 'Invalidation.Id' --output text)"
  aws cloudfront wait invalidation-completed \
    --distribution-id "$DISTRIBUTION_ID" \
    --id "$INVALIDATION_ID"
  echo "harness: invalidation $INVALIDATION_ID complete"
fi

echo "harness: deployed $STACK_NAME at $URL"
printf '%s\n' "$URL" >&3

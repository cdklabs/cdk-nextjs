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

for required in "$ADAPTER_ENTRY" "$CACHE_HANDLER_ENTRY" "$ADAPTER_DIR/lib/index.js"; do
  if [ ! -f "$required" ]; then
    echo "harness: $required is missing. Run \`pnpm bundle && pnpm compile\` in $ADAPTER_DIR." >&2
    exit 1
  fi
done
if [ ! -x "$CDK_BIN" ]; then
  echo "harness: no CDK CLI at $CDK_BIN. Run \`pnpm i\` in $ADAPTER_DIR, or set CDK_BIN." >&2
  exit 1
fi

STACK_NAME="$(harness_stack_name "$APP_DIR")"
printf '%s\n' "$STACK_NAME" >"$HARNESS_STACK_FILE"
echo "harness: app=$APP_DIR stack=$STACK_NAME"

# The harness creates the app with `skipInstall`, so there is no node_modules
# yet. Its package.json pins `packageManager`, and its `build` script shells out
# to `pnpm post-build`, so pnpm is not optional here.
PNPM=(corepack pnpm)
if ! command -v corepack >/dev/null 2>&1; then
  PNPM=(pnpm)
fi
"${PNPM[@]}" install --ignore-workspace --prefer-offline

# Make the adapter resolvable as a package rather than a loose file: the adapter
# resolves its own cache handler with
# `import.meta.resolve("cdk-nextjs/cache-handler")` (src/adapter/adapter.mts), so
# it has to be reachable through a package boundary with this repo's `exports`
# map. Same shape as `examples/app-playground`'s `prebuild` script. After
# `pnpm install`, which prunes directories it does not know about.
LOCAL_PKG="node_modules/cdk-nextjs"
mkdir -p "$LOCAL_PKG/lib/adapter"
cp "$ADAPTER_DIR/package.json" "$LOCAL_PKG/package.json"
cp "$ADAPTER_ENTRY" "$CACHE_HANDLER_ENTRY" "$LOCAL_PKG/lib/adapter/"
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
"${PNPM[@]}" build 2>&1 | tee "$HARNESS_BUILD_LOG"

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
  # Flip to 1 with `docs/plans/immutable-static-assets.md`; until then static
  # assets are re-uploaded per deploy under the same keys.
  echo "NEXT_SUPPORTS_IMMUTABLE_ASSETS: ${HARNESS_SUPPORTS_IMMUTABLE_ASSETS:-0}"
} >"$HARNESS_MARKERS_FILE"

export HARNESS_APP_DIR="$APP_DIR"
export HARNESS_STACK_NAME="$STACK_NAME"
echo "harness: deploying $STACK_NAME"
# Into one shared stack, so that only the first test file of a run pays for
# creating and propagating a CloudFront distribution. `--hotswap-fallback` takes
# the fast path when everything that changed is the function's code, its
# environment or a bucket deployment, and a full CloudFormation deployment
# otherwise. Expect the latter most of the time - see the table in
# scripts/e2e-harness/README.md for which resources actually differ between two
# fixtures and why two of them are not hotswappable.
#
# `--output` inside the app directory: a shared cdk.out would have concurrent
# test files overwrite each other's assembly. (The shared stack requires `-c 1`
# anyway, but `HARNESS_ISOLATED_STACK=1` does not.)
"$CDK_BIN" deploy "$STACK_NAME" \
  --app "node $HARNESS_DIR/app.js" \
  --output "$APP_DIR/$HARNESS_CDK_OUT" \
  --outputs-file "$APP_DIR/$HARNESS_OUTPUTS_FILE" \
  --hotswap-fallback \
  --require-approval never \
  --ci 2>&1 | tee "$HARNESS_DEPLOY_LOG"

URL="$(harness_stack_output "$HARNESS_OUTPUTS_FILE" "$STACK_NAME" HarnessUrl)"
if [ -z "$URL" ]; then
  echo "harness: deploy reported success but $STACK_NAME has no HarnessUrl output" >&2
  exit 1
fi

# Then evict the previous test file's app from the edge.
#
# Two things make this mandatory rather than hygienic: the stack is shared, so
# the distribution has the last fixture's responses cached under the very paths
# this one is about to request; and a hotswap never runs CloudFormation, so the
# post-deploy custom resource that would normally invalidate never fires (its
# properties are pinned in app.js for exactly that reason). Blocking until it
# completes, because the first request the harness makes is the one that would
# read a stale response.
DISTRIBUTION_ID="$(harness_stack_output "$HARNESS_OUTPUTS_FILE" "$STACK_NAME" DistributionId)"
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

echo "harness: deployed $STACK_NAME at $URL"
printf '%s\n' "$URL" >&3

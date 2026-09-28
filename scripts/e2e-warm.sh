#!/usr/bin/env bash
#
# Creates the shared harness stack before `run-tests.js` starts, so that no test
# file pays for it.
#
# The first deploy creates a CloudFront distribution and everything behind it,
# measured at ~240s. The harness runs `createNext` inside jest's `beforeAll`, so
# that wait is charged against NEXT_E2E_TEST_TIMEOUT - 240000 in CI, i.e. the same
# order - and the first test file of every run fails wholesale, then passes on
# retry once the stack exists. Retries make that survivable, not correct: it
# burns a retry the next real failure needs, and a create slower than two retries
# goes red.
#
# So: deploy once here, from a throwaway app, and let every test file take the
# update path. Re-running against an existing stack is a fast no-op update, so
# this is safe to run unconditionally.
#
# @see scripts/e2e-harness/README.md
set -euo pipefail

: "${ADAPTER_DIR:?must be set to the cdk-nextjs checkout}"
HARNESS_DIR="$ADAPTER_DIR/scripts/e2e-harness"
# shellcheck source=scripts/e2e-harness/common.sh
source "$HARNESS_DIR/common.sh"

# The version the harness's own fixtures will build with. Read from this repo so
# the warm app cannot drift from it: the *installed* version, exact, not the
# `package.json` range, which would let the warm app resolve a newer release
# than the one `@next/routing` and the adapter fixtures are pinned to.
NEXT_VERSION="$(node -e '
  const path = require.resolve("next/package.json", { paths: [process.argv[1]] });
  process.stdout.write(require(path).version);
' "$ADAPTER_DIR")"

# `e2e-deploy.sh` installs with `corepack pnpm`, and corepack takes the version
# from the app's own `packageManager` field - falling back to a latest it has
# never downloaded, which fails with MODULE_NOT_FOUND offline. The harness's real
# fixtures pin this, so the warm app has to as well.
PACKAGE_MANAGER="$(node -e '
  const pkg = require(process.argv[1] + "/package.json");
  if (!pkg.packageManager) throw new Error("no `packageManager` in " + process.argv[1]);
  process.stdout.write(pkg.packageManager);
' "$ADAPTER_DIR")"

WARM_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hrns-warm-XXXXXX")"
# Deleted on every exit unless WARM_KEEP=1, which is for poking at the build
# locally. Nothing is lost on a failure: `e2e-deploy.sh` tees its build and
# deploy output to stderr, so the job log already has what the files hold.
cleanup() {
  if [ "${WARM_KEEP:-0}" = "1" ]; then
    echo "warm: leaving $WARM_DIR in place"
    return
  fi
  rm -rf "$WARM_DIR"
}
trap cleanup EXIT

echo "warm: building a throwaway app in $WARM_DIR (next@$NEXT_VERSION)"

# The smallest app that still produces every resource the real fixtures need:
# one static route, one dynamic route, and a `public/` file. Without a dynamic
# route there is no server function worth deploying; without `public/` the
# distribution would be missing the static behaviors the first real fixture then
# adds, which is a CloudFront propagation this is meant to have already paid.
mkdir -p "$WARM_DIR/app/dynamic" "$WARM_DIR/public"

cat >"$WARM_DIR/package.json" <<EOF
{
  "name": "hrns-warm",
  "private": true,
  "packageManager": "$PACKAGE_MANAGER",
  "scripts": { "build": "next build" },
  "dependencies": {
    "next": "$NEXT_VERSION",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
EOF

cat >"$WARM_DIR/next.config.js" <<'EOF'
module.exports = {};
EOF

cat >"$WARM_DIR/app/layout.js" <<'EOF'
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
EOF

cat >"$WARM_DIR/app/page.js" <<'EOF'
export default function Page() {
  return <main>harness warm-up</main>;
}
EOF

cat >"$WARM_DIR/app/dynamic/page.js" <<'EOF'
export const dynamic = "force-dynamic";
export default function Page() {
  return <main>harness warm-up {Date.now()}</main>;
}
EOF

printf 'harness warm-up\n' >"$WARM_DIR/public/warm.txt"

# Through `e2e-deploy.sh` rather than a second `cdk deploy` call of its own: the
# point is to exercise the same path the test files take, so a warm-up that
# succeeds means their deploys will too. It installs, builds through the adapter
# and deploys, and prints the URL on stdout.
# Named in the log because a sharded run has one of these per shard, and which
# stack a warm-up was for is otherwise only inferable from the job name.
STACK_NAME="$(harness_stack_name)"

# A stack still being deleted - by the previous run's cleanup, if that run was
# cut off before its own wait finished - cannot be deployed into, and CloudFront
# makes that wait 15+ minutes. Wait it out here, where it costs no test file.
#
# ROLLBACK_COMPLETE needs nothing here: `cdk deploy` deletes and recreates it,
# and this is the app that should do the create. DELETE_FAILED can't be deployed
# into at all, and deleting it is `e2e-sweep.sh`'s job, behind its tag gate.
STATUS="$(harness_stack_status "$STACK_NAME")"
case "$STATUS" in
  DELETE_IN_PROGRESS)
    echo "warm: $STACK_NAME is still being deleted; waiting for that to finish"
    aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME"
    ;;
  DELETE_FAILED)
    echo "warm: $STACK_NAME is DELETE_FAILED; run \`scripts/e2e-sweep.sh --apply --stack $STACK_NAME --wait\` first" >&2
    exit 1
    ;;
esac

echo "warm: deploying $STACK_NAME"
cd "$WARM_DIR"
URL="$(HARNESS_WARMING=1 "$ADAPTER_DIR/scripts/e2e-deploy.sh")"
echo "warm: shared stack ready at $URL"

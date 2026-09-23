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

# Deliberately not `harness_stack_name`: warming an isolated stack would warm a
# name no test file goes on to use, since HARNESS_ISOLATED_STACK derives the name
# from the app directory.
if [ "${HARNESS_ISOLATED_STACK:-0}" = "1" ]; then
  echo "warm: HARNESS_ISOLATED_STACK=1 gives every test file its own stack; nothing to warm"
  exit 0
fi

# The version the harness's own fixtures will build with. Read from this repo so
# the warm app cannot drift from it.
NEXT_VERSION="$(node -e '
  const pkg = require(process.argv[1] + "/package.json");
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps.next) throw new Error("no `next` dependency in " + process.argv[1]);
  process.stdout.write(deps.next);
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
# Keep the directory on failure: its .adapter-deploy.log is the only record of
# why a warm-up failed, and CI discards stderr interleaving.
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
echo "warm: deploying $(harness_stack_name "")"
cd "$WARM_DIR"
URL="$("$ADAPTER_DIR/scripts/e2e-deploy.sh")"
echo "warm: shared stack ready at $URL"

#!/usr/bin/env bash
#
# Build one e2e fixture through the adapter and serve it locally, so a failing
# harness case can be instrumented without a 3-minute deploy per iteration.
#
# Usage, from this repo:
#   scripts/e2e-offline.sh app-dir/layout-params [port]
#
# Prints two URLs: our container shell, and `next start` on the *same build*, which
# is the comparison that matters - every "why does the deployed app disagree with
# `next start`" question is one `diff` of two responses away once both are up.
#
# Why inside the next.js checkout: a fixture resolves `next` by walking up to the
# repo's own `node_modules/next` symlink. Staged anywhere else, Turbopack fails with
# "Could not find the Next.js package". `node_modules/cdk-nextjs` then has to live
# inside the app for the same reason `e2e-deploy.sh` puts it there - the adapter
# resolves its cache handler through a package boundary, and a relative path out of
# the app directory "leaves the filesystem root".
#
# @see scripts/e2e-harness/README.md
# @see docs/harness-coverage.md, which several entries were measured with this
set -euo pipefail

FIXTURE="${1:?usage: e2e-offline.sh <fixture, e.g. app-dir/layout-params> [port]}"
PORT="${2:-3112}"
NEXT_START_PORT=$((PORT + 1))

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEXTJS_DIR="${NEXTJS_DIR:-$(cd "$ADAPTER_DIR/../next.js" && pwd)}"
FIXTURE_DIR="$NEXTJS_DIR/test/e2e/$FIXTURE"
if [ ! -d "$FIXTURE_DIR" ]; then
  echo "e2e-offline: no fixture at $FIXTURE_DIR (set NEXTJS_DIR?)" >&2
  exit 1
fi
for required in "$ADAPTER_DIR/lib/adapter/adapter.mjs" \
  "$ADAPTER_DIR/lib/adapter/cache-handler.mjs" \
  "$ADAPTER_DIR/lib/runtime/server.mjs"; do
  if [ ! -f "$required" ]; then
    echo "e2e-offline: $required is missing. Run \`pnpm bundle\` in $ADAPTER_DIR." >&2
    exit 1
  fi
done

APP_NAME="offline-$(basename "$FIXTURE")"
APP_DIR="$NEXTJS_DIR/$APP_NAME"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
# Everything the fixture ships except its test file: the harness copies the same
# set, minus the config snippet it appends (which only aliases __NEXT_TEST_MODE).
(cd "$FIXTURE_DIR" && tar cf - --exclude='*.test.ts' --exclude='*.test.js' .) |
  (cd "$APP_DIR" && tar xf -)
printf '{ "name": "%s", "private": true }\n' "$APP_NAME" >"$APP_DIR/package.json"
[ -f "$APP_DIR/next.config.js" ] || [ -f "$APP_DIR/next.config.ts" ] ||
  [ -f "$APP_DIR/next.config.mjs" ] || echo 'module.exports = {}' >"$APP_DIR/next.config.js"

mkdir -p "$APP_DIR/node_modules/cdk-nextjs/lib/adapter"
cp "$ADAPTER_DIR/package.json" "$APP_DIR/node_modules/cdk-nextjs/package.json"
cp "$ADAPTER_DIR/lib/adapter/adapter.mjs" "$ADAPTER_DIR/lib/adapter/cache-handler.mjs" \
  "$APP_DIR/node_modules/cdk-nextjs/lib/adapter/"

cd "$APP_DIR"
echo "e2e-offline: building $APP_NAME" >&2
NEXT_ADAPTER_PATH="$APP_DIR/node_modules/cdk-nextjs/lib/adapter/adapter.mjs" \
  NEXT_PRIVATE_TEST_MODE=e2e \
  NEXT_TELEMETRY_DISABLED=1 \
  "$NEXTJS_DIR/node_modules/.bin/next" build

# `deploymentRootOf` asserts the shell lives in a directory named
# `cdk-nextjs-runtime` next to the staged project, so reproduce that layout rather
# than running the bundle from wherever it happens to be.
STAGED="$APP_DIR/.next/cdk-nextjs-adapter/app"
mkdir -p "$STAGED/cdk-nextjs-runtime"
cp "$ADAPTER_DIR/lib/runtime/server.mjs" "$STAGED/cdk-nextjs-runtime/server.mjs"
cp "$APP_DIR/.next/cdk-nextjs-adapter/manifest.json" "$STAGED/cdk-nextjs-runtime/manifest.json"

cd "$STAGED"
PORT="$PORT" node cdk-nextjs-runtime/server.mjs &
SHELL_PID=$!
cd "$APP_DIR"
"$NEXTJS_DIR/node_modules/.bin/next" start --port "$NEXT_START_PORT" &
START_PID=$!
trap 'kill $SHELL_PID $START_PID 2>/dev/null || true' EXIT INT TERM
sleep 3
echo "e2e-offline: cdk-nextjs  http://localhost:$PORT" >&2
echo "e2e-offline: next start  http://localhost:$NEXT_START_PORT" >&2
echo "e2e-offline: app         $APP_DIR (delete it when done)" >&2
wait

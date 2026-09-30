#!/usr/bin/env bash
# Runs one of the src/*.ts k6 scripts with .env loaded. Results land in
# results/$LABEL/. Usage: scripts/k6.sh <latency|capacity|browser> [k6 run flags]
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
script=$1
shift
: "${BASE_URL:?set BASE_URL, e.g. in .env}"
: "${LABEL:?set LABEL to the construct, e.g. global-functions}"
mkdir -p "results/$LABEL"
# k6 holds a socket per in-flight request
ulimit -n 65536 2>/dev/null || ulimit -n "$(ulimit -Hn)"
exec k6 run "$@" "src/$script.ts"

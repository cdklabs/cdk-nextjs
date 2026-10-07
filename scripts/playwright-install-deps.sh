#!/usr/bin/env bash
#
# Installs Playwright's system packages (`playwright install-deps chromium`)
# with apt network timeouts and bounded retries. CI only: it runs apt as root
# and writes to /etc/apt/apt.conf.d. Run it from the directory whose
# node_modules has Playwright, then install the browser itself unprivileged
# with `playwright install chromium`.
#
# apt has no overall deadline: a mirror that stops answering partway through a
# fetch can hang `apt-get update` indefinitely. On 2026-10-07 two harness
# shards hung right after fetching noble-security InRelease, one for two hours.
# Each attempt is capped and retried instead.
#
# The cap runs inside sudo, not around it. sudo starts its command in a new
# session, so a `timeout` outside it kills sudo but not the apt-get under it,
# which keeps holding /var/lib/apt/lists/lock and fails every retry on it.
#
# Usage: scripts/playwright-install-deps.sh

set -euo pipefail

ATTEMPTS="${PLAYWRIGHT_INSTALL_ATTEMPTS:-3}"
# Normal runs take 15 s to 4 min (2026-10-07).
ATTEMPT_TIMEOUT="${PLAYWRIGHT_INSTALL_TIMEOUT:-420}"

sudo tee /etc/apt/apt.conf.d/99cdk-nextjs-timeouts > /dev/null << 'EOF'
Acquire::Retries "3";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
EOF

for attempt in $(seq 1 "$ATTEMPTS"); do
  # sudo resets PATH; playwright's shim needs node.
  if sudo env "PATH=$PATH" timeout --kill-after=30 "$ATTEMPT_TIMEOUT" \
    ./node_modules/.bin/playwright install-deps chromium; then
    exit 0
  fi
  echo "playwright-install-deps: attempt $attempt/$ATTEMPTS failed or exceeded ${ATTEMPT_TIMEOUT}s" >&2
done
exit 1

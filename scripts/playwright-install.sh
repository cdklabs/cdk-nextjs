#!/usr/bin/env bash
#
# Runs a Playwright install command (`playwright install --with-deps ...`) with
# apt network timeouts and bounded retries. CI only: it writes to
# /etc/apt/apt.conf.d with sudo.
#
# `--with-deps` runs `apt-get update` and `apt-get install`, and apt has no
# overall deadline: a mirror that stops answering partway through a fetch can
# hang it indefinitely. On 2026-10-07 a harness shard sat in this step for two
# hours after the runner's Azure mirror went unreachable and the fallback stalled.
# The timeouts below make a stalled fetch fail in seconds so apt's own retries
# can work, and each attempt is capped so a hang that slips past them costs
# minutes, not the job.
#
# Usage: scripts/playwright-install.sh <command...>
#   e.g. scripts/playwright-install.sh pnpm playwright install --with-deps chromium

set -euo pipefail

ATTEMPTS="${PLAYWRIGHT_INSTALL_ATTEMPTS:-3}"
ATTEMPT_TIMEOUT="${PLAYWRIGHT_INSTALL_TIMEOUT:-300}"

# DPkg::Lock::Timeout lets a retry wait for a killed attempt's apt to release
# its lock instead of failing on it straight away.
sudo tee /etc/apt/apt.conf.d/99cdk-nextjs-timeouts > /dev/null << 'EOF'
Acquire::Retries "3";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
DPkg::Lock::Timeout "60";
EOF

for attempt in $(seq 1 "$ATTEMPTS"); do
  # timeout signals its whole process group, so the sudo'd apt-get under
  # playwright goes too.
  if timeout --kill-after=30 "$ATTEMPT_TIMEOUT" "$@"; then
    exit 0
  fi
  echo "playwright-install: attempt $attempt/$ATTEMPTS failed or exceeded ${ATTEMPT_TIMEOUT}s" >&2
done
exit 1

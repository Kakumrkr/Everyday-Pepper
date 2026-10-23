#!/bin/bash
# SessionStart hook for Claude Code cloud sessions: install workspace dependencies, point
# Playwright at CI's browser, and make sure the Docker daemon runs, pulling through Google's
# mirror (integration tests use Testcontainers; the dev stack uses Compose).
# Idempotent and non-interactive. Does nothing outside cloud sessions.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# pnpm version comes from package.json `packageManager` via Corepack.
corepack enable >/dev/null 2>&1 || true
pnpm install

# Playwright: use the browser CI uses (the headless shell), so a test that passes here passes
# on GitHub too (S21: the full browser granted notifications, the headless shell did not).
# Kept if already set; written to CLAUDE_ENV_FILE so every command of the session gets it
# (the hook runs on start, resume and compaction, so a resumed session gets it too).
if [ -z "${PLAYWRIGHT_CHROMIUM_EXECUTABLE:-}" ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  # Older images ship chrome-linux/headless_shell, newer ones (S31)
  # chrome-headless-shell-linux64/chrome-headless-shell; take whichever this image has.
  shell=$(ls -d /opt/pw-browsers/chromium_headless_shell-*/chrome-linux*/headless_shell \
    /opt/pw-browsers/chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell \
    2>/dev/null | sort | tail -n 1 || true)
  if [ -n "$shell" ] && [ -x "$shell" ]; then
    echo "export PLAYWRIGHT_CHROMIUM_EXECUTABLE=$shell" >>"$CLAUDE_ENV_FILE"
    echo "session-start: Playwright uses CI's headless shell ($shell)"
  fi
fi

# Docker: start the daemon if the container has one but it is not running. Never fail the
# session over it; unit tests, lint and typecheck do not need Docker.
if command -v dockerd >/dev/null 2>&1 && ! docker info >/dev/null 2>&1; then
  # Pull Docker Hub images through Google's mirror (same images, same pinned digests; Docker
  # falls back to Docker Hub when the mirror lacks one). Cloud sandboxes share IP addresses,
  # so Docker Hub's anonymous limit (about 100 pulls per 6 hours) can be used up before the
  # session starts (S18). Only written when there is no daemon configuration yet.
  if [ ! -e /etc/docker/daemon.json ] && mkdir -p /etc/docker 2>/dev/null; then
    echo '{ "registry-mirrors": ["https://mirror.gcr.io"] }' >/etc/docker/daemon.json || true
  fi
  nohup dockerd >/tmp/dockerd.log 2>&1 &
  for _ in $(seq 1 30); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
  if docker info >/dev/null 2>&1; then
    echo "session-start: Docker daemon started"
  else
    echo "session-start: Docker daemon did not start (see /tmp/dockerd.log); integration tests will fail" >&2
  fi
fi

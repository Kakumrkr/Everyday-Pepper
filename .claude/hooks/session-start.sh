#!/bin/bash
# SessionStart hook for Claude Code cloud sessions: install workspace dependencies and make sure
# the Docker daemon runs (integration tests use Testcontainers; the dev stack uses Compose).
# Idempotent and non-interactive. Does nothing outside cloud sessions.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# pnpm version comes from package.json `packageManager` via Corepack.
corepack enable >/dev/null 2>&1 || true
pnpm install

# Docker: start the daemon if the container has one but it is not running. Never fail the
# session over it; unit tests, lint and typecheck do not need Docker.
if command -v dockerd >/dev/null 2>&1 && ! docker info >/dev/null 2>&1; then
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

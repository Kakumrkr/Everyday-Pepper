#!/bin/bash
# Starts the stack Playwright runs against, the way S31 ran it in a cloud session: Postgres,
# Redis and Mailpit in Docker; the built api, worker and web as plain Node processes (building
# the app images takes far longer). Chat answers come from the journeys' scripted model, as in
# CI (ADR-0031): OPENAI_API_KEY is removed from the services, so no model is ever called. The
# worker runs the insights job every 10 s, as in CI (S35). The web serves the component gallery
# (PEPPER_GALLERY=1), as in CI (S40).
#   .claude/skills/session-close/e2e-stack.sh start <log dir>   # then: pnpm test:e2e [spec]
#   .claude/skills/session-close/e2e-stack.sh stop
set -euo pipefail
cd "$(dirname "$0")/../../.."
pids=/tmp/pepper-e2e-stack.pids

case "${1:-}" in
  start)
    logs=${2:?log dir}
    [ ! -f "$pids" ] || { echo "e2e-stack: already started (stop it first)" >&2; exit 1; }
    [ -f .env ] || cp .env.example .env
    docker compose up -d --wait postgres redis mailpit
    pnpm turbo run build --filter=@pepper/api --filter=@pepper/worker --filter=@pepper/web \
      --output-logs=errors-only
    pnpm db:migrate
    # Each service in its own session (setsid) with its own output and no inherited pipe, so
    # this returns at once and `stop` can end each one's whole process group by id.
    (cd apps/api && exec setsid env -u OPENAI_API_KEY AI_SCRIPTED_PROVIDER=e2e \
      DEPLOYMENT_ENVIRONMENT=ci node --env-file=../../.env --import ./dist/instrument.js \
      dist/main.js) </dev/null >"$logs/api.log" 2>&1 &
    api=$!
    (cd apps/worker && exec setsid env -u OPENAI_API_KEY DEPLOYMENT_ENVIRONMENT=ci INSIGHTS_POLL_MS=10000 DRAFTS_POLL_MS=10000 \
      node --env-file=../../.env --import ./dist/instrument.js dist/main.js) \
      </dev/null >"$logs/worker.log" 2>&1 &
    worker=$!
    API_INTERNAL_URL=http://localhost:4000 PEPPER_GALLERY=1 setsid pnpm --filter @pepper/web start \
      </dev/null >"$logs/web.log" 2>&1 &
    echo "$api $worker $!" >"$pids"
    timeout 180 bash -c 'until curl -s -o /dev/null http://localhost:3000/ && curl -s -o /dev/null http://localhost:4000/v1/me; do sleep 2; done'
    echo "e2e-stack: up (logs in $logs)"
    ;;
  stop)
    # Only the process groups `start` made, by id: matching by name with `pkill -f` also hits
    # any shell whose command line names them, the session's own included (S31, M2).
    if [ -f "$pids" ]; then
      for pid in $(cat "$pids"); do kill -- "-$pid" 2>/dev/null || true; done
      rm -f "$pids"
    fi
    echo "e2e-stack: stopped (Docker services left running)"
    ;;
  *)
    echo "usage: e2e-stack.sh start <log dir> | stop" >&2
    exit 2
    ;;
esac

#!/bin/bash
# Records the runs in <scratch>/runs.txt (from pack.mjs) on the real models, one run at a time,
# and stops at the first refusal by the cost guards. Run it in the background; it prints one
# line per run and "ALL DONE". Each run's full output is in <scratch>/run-<n>.log.
#   .claude/skills/eval-record/record.sh <scratch> "<label prefix>" [extra cli flags]...
# Needs: OPENAI_API_KEY in the environment, <scratch>/evaldb.url (eval-db.js), a built
# @pepper/ai. Extra flags go to every run (e.g. --phase-estimate-ok, only when the user said so).
set -uo pipefail

scratch=${1:?scratch dir}
prefix=${2:?label prefix, e.g. "S32 pass^1"}
shift 2
routine=${ROUTINE_MODEL:-gpt-6-luna}
strong=${STRONG_MODEL:-gpt-6.1-sol}
phase=${EVAL_PHASE:-7}

cd "$(dirname "$0")/../../../packages/ai" || exit 1
EVAL_DATABASE_URL=$(cat "$scratch/evaldb.url") || exit 1
export EVAL_DATABASE_URL NODE_USE_ENV_PROXY=1

total=$(wc -l <"$scratch/runs.txt")
i=0
while read -r ids; do
  i=$((i + 1))
  args=()
  for id in $ids; do args+=(--case "$id"); done
  out=$(node dist/evals/cli.js --provider openai --record --phase "$phase" --concurrency 4 \
    --routine "$routine" --routine-effort low --strong "$strong" --strong-effort low \
    --cassettes openai --label "$prefix part $i/$total" "$@" "${args[@]}" 2>&1)
  code=$?
  echo "$out" >"$scratch/run-$i.log"
  spent=$(echo "$out" | grep -o 'Spent \$[0-9.]*' | head -n 1)
  result=$(echo "$out" | grep -o 'gates NOT met\|all gates met\|Eval run failed.*' | head -n 1)
  missed=$(echo "$out" | grep '❌' | cut -d'|' -f2 | tr -d ' ' | tr '\n' ' ')
  echo "part $i/$total exit=$code $spent $result ${missed:+(missed: $missed)}"
  if echo "$out" | grep -q 'Refused'; then
    echo "STOPPED at part $i: $(echo "$out" | grep 'Refused' | head -n 1)"
    break
  fi
done <"$scratch/runs.txt"
echo "ALL DONE"

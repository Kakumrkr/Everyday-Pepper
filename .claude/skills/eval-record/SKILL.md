---
name: eval-record
description: Record Pepper's LLM evals on the real models (Luna + Sol) - probe the changed sets first, then one full recording, packed by estimate and run in the background under the cost guards. Use whenever a session records cassettes, re-records after a tool, prompt or instruction change, or measures pass^k.
---

# Recording the evals on the real models (M2, user-approved workflow)

Spends real money: read the phase's budget in `docs/plan/ai-budget.md` and `docs/plan/STATUS.md` first. Rules that never change: `OPENAI_API_KEY` from the environment only; every run under the runner's guards (run $1.50, phase cap, $13.80 total stop since S56a); never raise a cap or pass `--phase-estimate-ok` without the user saying so in this session.

Any change to a tool, a guide or the instructions makes **every** recorded cassette stale (each request is fingerprinted), so a session records the whole suite once, at the end. Before that, check cheaply.

## 0. Ready

- Every case that has a scripted cassette green: `pnpm --filter @pepper/ai build && pnpm --filter @pepper/ai eval` ($0). The report also fails the cases with only a recorded cassette ("cassette miss … call 1"); that is expected, the replay test in `evals.int.test.ts` leaves them out. In a fresh container build the dependencies first: `pnpm turbo run build --filter=@pepper/ai...`.
- `S=<scratchpad>`. Start the shared eval database in the background and keep it running:
  `cd packages/ai && node dist/evals/eval-db.js $S/evaldb.url` (run_in_background).

## 1. Probe: only the sets the change touches (a few cents)

Pick the sets whose tools or guides changed, plus the sets of every tool whose guide overlaps (e.g. `remember_fact` ↔ `propose_rule` ↔ `block_time`: memory_write, learned_rules, scheduling).

```sh
node .claude/skills/eval-record/pack.mjs $S --set <set> --set <set>   # or --case <id>...
EVAL_PHASE=<phase> .claude/skills/eval-record/record.sh $S "S<nn> probe"                 # run_in_background
```

A miss here is fixed now (failing test first if it is code), and the probe is re-run for that set only. A recording replays every step whose fingerprint still matches, so the probe's cassettes cost nothing again in the full pass unless a later change makes them stale.

## 2. One full recording

```sh
node .claude/skills/eval-record/pack.mjs $S                # every case, about $0.56 of estimate a run
EVAL_PHASE=<phase> .claude/skills/eval-record/record.sh $S "S<nn> pass^1"     # run_in_background, not Monitor
(cd packages/ai && EVAL_DATABASE_URL=$(cat $S/evaldb.url) NODE_USE_ENV_PROXY=1 \
  node dist/evals/cli.js --provider openai --retrieval --record --phase <n>)   # when episodes or search changed
```

`record.sh` prints one line per run (spent, gates, the sets that missed) and stops at the first `Refused`. Read a run's details in `$S/run-<n>.log` only when its line shows a miss.

## 3. After it

- A miss on a gate: show the user the case, the cause and the options (fix + re-record that set / carry it as a named known miss); do not decide alone.
- Replay everything for free: `pnpm --filter @pepper/ai eval --provider openai` and the replay test in `pnpm test:integration`.
- Write the spend in `ai-budget.md` (from `evals/ledger.json`) and the results table in the session's ADR.

Flags (details in `packages/ai/evals/README.md`): `--set`, `--case`, `--concurrency` (default 4), `--phase` (required to record), `--retrieval`, `--phase-estimate-ok`, `--max-cost`. Environment: `EVAL_DATABASE_URL`, `NODE_USE_ENV_PROXY=1` (both set by `record.sh`); models via `ROUTINE_MODEL`/`STRONG_MODEL`, phase via `EVAL_PHASE` (required by `record.sh`: the phase whose cap is checked, e.g. `EVAL_PHASE=12`).

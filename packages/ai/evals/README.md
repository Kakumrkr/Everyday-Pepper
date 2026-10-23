# Pepper evals (ADR-0027, ADR-0030, playbook §5)

- `cases/*.json`: eval cases (`src/evals/case.ts`), one array per set. Every case runs through the real agent loop and tools in a freshly seeded world on Postgres (`src/evals/world.ts`, "juniper": Lena owner, Cara manager, Jess staff, Marco; clients Maria, Sara, Sarah, Ana; Maria booked at 3pm on the next weekday, Ana at 2pm on Friday) and is judged on its tool calls, replies and the business afterwards (`expect.actions`). The tool guides' examples add generated cases (`toolEvalCases`).
- Cassettes name seeded records with placeholders: `{{service:haircut}}`, `{{service:colour}}`, `{{staff:jess}}`, `{{staff:marco}}`, `{{client:maria|sara|sarah|ana}}`, `{{booking:maria|ana}}`. They are filled in on replay and put back before fingerprinting (ids a run creates are numbered), so a recording stays valid in any fresh world.
- `cassettes/<provider>/<case id>.json`: the answers a run replays. `scripted/` holds hand-written reference answers (no fingerprint); `openai/` (from S27) holds the chosen models' recorded ones, each with the fingerprint of the request it answered, so a changed prompt or tool fails as `stale` instead of reusing an old answer; CI replays them. `openai-<model>…/` keep the other candidates' recordings from the model choice (ADR-0033), replayable with `--provider openai --cassettes <dir>`. A request does not name the model, so each configuration records into its own directory.
- `prices.json`: USD per million tokens per model, from OpenAI's pricing page (input, cached input, cache writes on GPT-5.6 and later, output); a real run refuses a model without a price.
- `ledger.json`: every real run's tokens and cost (shown in `docs/plan/ai-budget.md`).
- `reports/`: the latest report (git-ignored).

Run: `pnpm --filter @pepper/ai build && pnpm --filter @pepper/ai eval` (scripted cassettes, $0; a throwaway Postgres in Docker, or `EVAL_DATABASE_URL` for a migrated one as the services' login). CI runs the same through `src/evals/evals.int.test.ts`. Only `--provider openai --record` calls the real API, within the budget policy (playbook §4).

Record (S27; spends money, see `docs/plan/ai-budget.md` first):

```sh
pnpm --filter @pepper/ai build && cd packages/ai
node dist/evals/eval-db.js /tmp/evaldb.url &   # a shared throwaway Postgres (see below)
EVAL_DATABASE_URL=$(cat /tmp/evaldb.url) NODE_USE_ENV_PROXY=1 node dist/evals/cli.js \
  --provider openai --record --set safety --chunk 1 --chunk-size 7 \
  --routine <model> [--routine-effort low] --strong <model> [--strong-effort low] \
  --cassettes openai --phase 7 --label "what this run is for"
```

From Phase 7 a recording names its phase (`--phase 7`): its ledger label starts with `P7 `, and the runner refuses a run (and stops the next call) that would take the phase past its cap (Phase 7: $1.00, Phase 7 playbook §4), on top of the run's cap and the $4.50 stop. `--phase-estimate-ok` (user, S31) lets a run start although its worst-case estimate would pass the phase cap (a multi-turn case near a phase's end); the next call is still refused once actual spend reaches the cap.

Embeddings (S31): scripted runs use the hash embedder; `--provider openai` replays `embeddings/text-embedding-3-small.json` (int8 vectors keyed by the text's hash) and a recording embeds what it lacks with the real model, under the same guards. `--retrieval` runs the `episode_retrieval` set (`retrieval/episodes.json`, recall@5, gate 95%) instead of the cases; with `--record --phase 7` it embeds the set's texts first.

`OPENAI_API_KEY` comes from the environment only. Record against `EVAL_DATABASE_URL`: loading Testcontainers inside the recorder replaces Node's fetch dispatcher, so behind a proxy the model cannot be reached. `NODE_USE_ENV_PROXY=1` makes Node's fetch use `HTTPS_PROXY` (Node ≥ 22.21).

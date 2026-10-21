# Pepper evals (ADR-0027, ADR-0030, playbook §5)

- `cases/*.json`: eval cases (`src/evals/case.ts`), one array per set. Every case runs through the real agent loop and tools in a freshly seeded world on Postgres (`src/evals/world.ts`, "juniper": Lena owner, Cara manager, Jess staff, Marco; clients Maria, Sara, Sarah, Ana; Maria booked at 3pm on the next weekday, Ana at 2pm on Friday) and is judged on its tool calls, replies and the business afterwards (`expect.actions`). The tool guides' examples add generated cases (`toolEvalCases`).
- Cassettes name seeded records with placeholders: `{{service:haircut}}`, `{{service:colour}}`, `{{staff:jess}}`, `{{staff:marco}}`, `{{client:maria|sara|sarah|ana}}`, `{{booking:maria|ana}}`. They are filled in on replay and put back before fingerprinting (ids a run creates are numbered), so a recording stays valid in any fresh world.
- `cassettes/<provider>/<case id>.json`: the answers a run replays. `scripted/` holds hand-written reference answers (no fingerprint); `openai/` (from S27) holds recorded ones, each with the fingerprint of the request it answered, so a changed prompt or tool fails as `stale` instead of reusing an old answer.
- `prices.json`: USD per million tokens per model. Filled in S27 from OpenAI's pricing page; a real run refuses a model without a price.
- `reports/`: the latest report (git-ignored).

Run: `pnpm --filter @pepper/ai build && pnpm --filter @pepper/ai eval` (scripted cassettes, $0; a throwaway Postgres in Docker, or `EVAL_DATABASE_URL` for a migrated one as the services' login). CI runs the same through `src/evals/evals.int.test.ts`. Only `--provider openai --record` calls the real API, within the budget policy (playbook §4).

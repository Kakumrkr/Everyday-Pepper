# Pepper evals (ADR-0027, playbook §5)

- `cases/*.json`: eval cases (`src/evals/case.ts`), one array per set.
- `cassettes/<provider>/<case id>.json`: the answers a run replays. `scripted/` holds hand-written reference answers (no fingerprint); `openai/` (from S27) holds recorded ones, each with the fingerprint of the request it answered, so a changed prompt or tool fails as `stale` instead of reusing an old answer.
- `prices.json`: USD per million tokens per model. Filled in S27 from OpenAI's pricing page; a real run refuses a model without a price.
- `reports/`: the latest report (git-ignored).

Run: `pnpm --filter @pepper/ai build && pnpm --filter @pepper/ai eval` (scripted cassettes, $0). Only `--provider openai --record` calls the real API, within the budget policy (playbook §4).

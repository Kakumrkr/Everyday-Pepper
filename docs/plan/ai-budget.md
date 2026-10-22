# OpenAI budget ledger — Phase 6 ($5 total)

Policy: [Phase 6 playbook §4](phase-6-playbook.md) (user, S22; confirmed for S27 on 2026-10-22). $5 of credit with a hard limit set on the OpenAI account by the user is the whole Phase 6 budget. Real calls happen only in S27, in this order, each step only if the previous one is green:

1. Smoke: 5 cases on each routine candidate (≤ $0.10), and calibrate the 3-characters-a-token estimate.
2. Full eval run, pass^1, in chunks of ≤ 25 cases.
3. Safety pass^3, then re-run only the failed cases after a fix.
4. Reserve: the stronger-model comparison on the hardest 20 cases, or one more fix round.

**Guards in code** (`packages/ai/src/evals`, S27):
- The key comes only from the environment (`OPENAI_API_KEY`); it is never written to a file, a log or a commit.
- A real run holds at most 25 cases (`--chunk`). Both routes' models need a price in `packages/ai/evals/prices.json`, checked on OpenAI's official pricing page.
- Before a run: the worst-case estimate (every step, nothing cached, the dearer model) must be ≤ the run's cap ($1.50 by default) and must not take the total past **$4.50**.
- During a run: the next call is refused once the run reaches its cap or the total reaches $4.50.
- After every run, completed, stopped or failed, one entry is appended below with the tokens each model actually used, what they cost at the listed prices, latency, and the measured characters per token. `packages/ai/evals/ledger.json` is the source; the runner rewrites the section between the markers.
- Every real answer is recorded as a cassette (`packages/ai/evals/cassettes/openai/`). A recording replays an earlier answer for an unchanged request instead of paying again. CI only replays.

The OpenAI dashboard's usage page is the final word on money; this ledger is computed from the token counts the API reported, at the listed prices.

## Ledger

<!-- ledger:start (written by the eval runner) -->
Total spent: **$0.0566** of $5.00 (the runner stops at $4.50).

| Run | Date | What | Status | Cases × trials | Estimate | Actual | Total so far |
|---|---|---|---|---|---|---|---|
| 1 | 2026-10-22 | smoke gpt-6-luna low / gpt-6.1-sol low | completed | 5 × 1 | $0.77 | $0.0000 | $0.0000 |
| 2 | 2026-10-22 | smoke retry 1 case (diagnose) | completed | 1 × 1 | $0.15 | $0.0000 | $0.0000 |
| 3 | 2026-10-22 | smoke 1/5 gpt-6-luna low | completed | 1 × 1 | $0.15 | $0.0000 | $0.0000 |
| 4 | 2026-10-22 | smoke diagnose (no call reached OpenAI) | completed | 1 × 1 | $0.15 | $0.0000 | $0.0000 |
| 5 | 2026-10-22 | smoke gpt-6-luna low / gpt-6.1-sol low | completed | 5 × 1 | $0.77 | $0.0388 | $0.0388 |
| 6 | 2026-10-22 | smoke gpt-5.4-mini default / gpt-6.1-sol low | completed | 5 × 1 | $0.77 | $0.0178 | $0.0566 |

- Run 5, gpt-6-luna: 12 calls, 67483 in (38955 cached, 28492 written), 498 out, p50 1258 ms, p95 3286 ms; 3.61 chars a token
- Run 5, gpt-6.1-sol: 4 calls, 24750 in (12287 cached, 12451 written), 224 out, p50 2023 ms, p95 2349 ms; 3.61 chars a token
- Run 6, gpt-5.4-mini-2026-03-17: 12 calls, 67892 in (52992 cached, 0 written), 585 out, p50 1021 ms, p95 1415 ms; 3.52 chars a token
<!-- ledger:end -->

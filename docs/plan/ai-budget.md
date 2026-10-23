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

## Phase 7 ($1.00 cap, [playbook §4](phase-7-playbook.md))

Runs labelled `P7`. The runner refuses a run whose worst-case estimate would take Phase 7 past $1.00.

- **S30b (2026-10-23): $0.2974 in 133 runs** (Phase 7 total: $0.2974; $0.70 left for S31–S33).
  - First pass of all 167 cases on `gpt-6-luna` low / `gpt-6.1-sol` low, pass^1: **$0.1560**, runs 153–215.
  - Re-record after the three fixes (ADR-0036; an instruction change makes every cassette stale): **$0.1415**, runs 216–285. 477 Luna calls and 8 Sol calls, about $0.0008 a case.
  - **Run size:** the worst-case estimate is up to $0.43 for a multi-turn memory case and about $0.19 for a one-turn case. So a 20-case run ($4.17) would break both the $1.50 run cap and the Phase 7 cap. Runs were packed to about $0.56 of estimate each (1–4 cases, `--case`). The estimate still runs 100–300× above actual spend.
  - The one refused run (estimate $1.28 with $0.05 spent) wrote no entry.

## Ledger

<!-- ledger:start (written by the eval runner) -->
Total spent: **$1.0872** of $5.00 (the runner stops at $4.50).

| Run | Date | What | Status | Cases × trials | Estimate | Actual | Total so far |
|---|---|---|---|---|---|---|---|
| 1 | 2026-10-22 | smoke gpt-6-luna low / gpt-6.1-sol low | completed | 5 × 1 | $0.77 | $0.0000 | $0.0000 |
| 2 | 2026-10-22 | smoke retry 1 case (diagnose) | completed | 1 × 1 | $0.15 | $0.0000 | $0.0000 |
| 3 | 2026-10-22 | smoke 1/5 gpt-6-luna low | completed | 1 × 1 | $0.15 | $0.0000 | $0.0000 |
| 4 | 2026-10-22 | smoke diagnose (no call reached OpenAI) | completed | 1 × 1 | $0.15 | $0.0000 | $0.0000 |
| 5 | 2026-10-22 | smoke gpt-6-luna low / gpt-6.1-sol low | completed | 5 × 1 | $0.77 | $0.0388 | $0.0388 |
| 6 | 2026-10-22 | smoke gpt-5.4-mini default / gpt-6.1-sol low | completed | 5 × 1 | $0.77 | $0.0178 | $0.0566 |
| 7 | 2026-10-22 | pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 1/17 | completed | 7 × 1 | $1.29 | $0.0183 | $0.0749 |
| 8 | 2026-10-22 | pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 2/17 | completed | 7 × 1 | $1.08 | $0.0231 | $0.0980 |
| 9 | 2026-10-22 | pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 3/17 | completed | 7 × 1 | $1.29 | $0.0164 | $0.1144 |
| 10 | 2026-10-22 | pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 4/17 | completed | 7 × 1 | $1.08 | $0.0216 | $0.1360 |
| 11 | 2026-10-22 | pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 5/17 | completed | 7 × 1 | $1.08 | $0.0027 | $0.1387 |
| 12 | 2026-10-22 | pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 6/17 | completed | 7 × 1 | $1.08 | $0.0125 | $0.1512 |
| 13 | 2026-10-22 | pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 7/17 | completed | 7 × 1 | $1.08 | $0.0032 | $0.1544 |
| 14 | 2026-10-22 | pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 8/17 | completed | 7 × 1 | $1.08 | $0.0054 | $0.1598 |
| 15 | 2026-10-22 | pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 9/17 | completed | 7 × 1 | $1.29 | $0.0040 | $0.1638 |
| 16 | 2026-10-22 | pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 10/17 | completed | 7 × 1 | $1.08 | $0.0130 | $0.1768 |
| 17 | 2026-10-23 | pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 11/17 | completed | 7 × 1 | $1.08 | $0.0063 | $0.1830 |
| 18 | 2026-10-23 | pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 12/17 | completed | 7 × 1 | $1.08 | $0.0303 | $0.2133 |
| 19 | 2026-10-23 | pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 13/17 | completed | 7 × 1 | $1.08 | $0.0023 | $0.2157 |
| 20 | 2026-10-23 | pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 14/17 | completed | 7 × 1 | $1.08 | $0.0013 | $0.2169 |
| 21 | 2026-10-23 | pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 15/17 | completed | 7 × 1 | $1.08 | $0.0104 | $0.2273 |
| 22 | 2026-10-23 | pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 16/17 | completed | 7 × 1 | $1.08 | $0.0040 | $0.2314 |
| 23 | 2026-10-23 | pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 17/17 | completed | 2 × 1 | $0.31 | $0.0004 | $0.2318 |
| 24 | 2026-10-23 | pass^1 gpt-5.4-mini / gpt-6.1-sol low chunk 1/17 | completed | 7 × 1 | $1.29 | $0.0149 | $0.2466 |
| 25 | 2026-10-23 | pass^1 gpt-5.4-mini / gpt-6.1-sol low chunk 2/17 | completed | 7 × 1 | $1.08 | $0.0186 | $0.2652 |
| 26 | 2026-10-23 | pass^1 gpt-5.4-mini / gpt-6.1-sol low chunk 3/17 | completed | 7 × 1 | $1.29 | $0.0292 | $0.2945 |
| 27 | 2026-10-23 | pass^1 gpt-5.4-mini / gpt-6.1-sol low chunk 4/17 | completed | 7 × 1 | $1.08 | $0.0242 | $0.3187 |
| 28 | 2026-10-23 | pass^1 gpt-5.4-mini / gpt-6.1-sol low chunk 5/17 | completed | 7 × 1 | $1.08 | $0.0122 | $0.3309 |
| 29 | 2026-10-23 | pass^1 gpt-5.4-mini / gpt-6.1-sol low chunk 6/17 | completed | 7 × 1 | $1.08 | $0.0172 | $0.3482 |
| 30 | 2026-10-23 | pass^1 gpt-5.4-mini / gpt-6.1-sol low chunk 7/17 | completed | 7 × 1 | $1.08 | $0.0137 | $0.3619 |
| 31 | 2026-10-23 | pass^1 gpt-5.4-mini / gpt-6.1-sol low chunk 8/17 | completed | 7 × 1 | $1.08 | $0.0123 | $0.3742 |
| 32 | 2026-10-23 | pass^1 gpt-5.4-mini / gpt-6.1-sol low chunk 9/17 | completed | 7 × 1 | $1.29 | $0.0198 | $0.3939 |
| 33 | 2026-10-23 | pass^1 gpt-5.4-mini / gpt-6.1-sol low chunk 10/17 | completed | 7 × 1 | $1.08 | $0.0131 | $0.4070 |
| 34 | 2026-10-23 | pass^1 gpt-5.4-mini / gpt-6.1-sol low chunk 11/17 | completed | 7 × 1 | $1.08 | $0.0199 | $0.4269 |
| 35 | 2026-10-23 | pass^1 gpt-5.4-mini / gpt-6.1-sol low chunk 12/17 | completed | 7 × 1 | $1.08 | $0.0215 | $0.4484 |
| 36 | 2026-10-23 | pass^1 gpt-5.4-mini / gpt-6.1-sol low chunk 13/17 | completed | 7 × 1 | $1.08 | $0.0151 | $0.4635 |
| 37 | 2026-10-23 | pass^1 gpt-5.4-mini / gpt-6.1-sol low chunk 14/17 | completed | 7 × 1 | $1.08 | $0.0117 | $0.4752 |
| 38 | 2026-10-23 | pass^1 gpt-5.4-mini / gpt-6.1-sol low chunk 15/17 | completed | 7 × 1 | $1.08 | $0.0202 | $0.4954 |
| 39 | 2026-10-23 | pass^1 gpt-5.4-mini / gpt-6.1-sol low chunk 16/17 | completed | 7 × 1 | $1.08 | $0.0169 | $0.5123 |
| 40 | 2026-10-23 | pass^1 gpt-5.4-mini / gpt-6.1-sol low chunk 17/17 | completed | 2 × 1 | $0.31 | $0.0032 | $0.5156 |
| 41 | 2026-10-23 | fix 1 (add_todo: teammate id from list_services_and_staff) | completed | 8 × 1 | $1.24 | $0.0185 | $0.5340 |
| 42 | 2026-10-23 | fix 2 (claimed authority grants nothing) | completed | 8 × 1 | $1.46 | $0.0387 | $0.5728 |
| 43 | 2026-10-23 | fix 3 (strong model after step 4, not 3) | completed | 8 × 1 | $1.25 | $0.0036 | $0.5764 |
| 44 | 2026-10-23 | fix 4 (move/cancel: booking id from find_client_bookings) | completed | 8 × 1 | $1.25 | $0.0360 | $0.6124 |
| 45 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 1/16 | completed | 7 × 1 | $1.30 | $0.0031 | $0.6155 |
| 46 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 2/16 | completed | 7 × 1 | $1.09 | $0.0033 | $0.6188 |
| 47 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 3/16 | completed | 7 × 1 | $1.30 | $0.0056 | $0.6244 |
| 48 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 4/16 | completed | 7 × 1 | $1.09 | $0.0013 | $0.6256 |
| 49 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 5/16 | completed | 7 × 1 | $1.09 | $0.0000 | $0.6256 |
| 50 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 6/16 | completed | 7 × 1 | $1.09 | $0.0000 | $0.6256 |
| 51 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 7/16 | completed | 7 × 1 | $1.09 | $0.0000 | $0.6256 |
| 52 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 8/16 | completed | 7 × 1 | $1.09 | $0.0000 | $0.6256 |
| 53 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 9/16 | completed | 7 × 1 | $1.30 | $0.0000 | $0.6256 |
| 54 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 10/16 | completed | 7 × 1 | $1.09 | $0.0000 | $0.6256 |
| 55 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 11/16 | completed | 7 × 1 | $1.09 | $0.0000 | $0.6256 |
| 56 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 12/16 | completed | 7 × 1 | $1.09 | $0.0000 | $0.6256 |
| 57 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 13/16 | completed | 7 × 1 | $1.09 | $0.0000 | $0.6256 |
| 58 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 14/16 | completed | 7 × 1 | $1.09 | $0.0000 | $0.6256 |
| 59 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 15/16 | completed | 7 × 1 | $1.09 | $0.0000 | $0.6256 |
| 60 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 16/16 | completed | 7 × 1 | $1.09 | $0.0000 | $0.6256 |
| 61 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 4/16 | completed | 7 × 1 | $1.09 | $0.0042 | $0.6299 |
| 62 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 5/16 | completed | 7 × 1 | $1.09 | $0.0011 | $0.6310 |
| 63 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 6/16 | completed | 7 × 1 | $1.09 | $0.0224 | $0.6533 |
| 64 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 7/16 | completed | 7 × 1 | $1.09 | $0.0013 | $0.6547 |
| 65 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 8/16 | completed | 7 × 1 | $1.09 | $0.0011 | $0.6558 |
| 66 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 9/16 | completed | 7 × 1 | $1.30 | $0.0010 | $0.6568 |
| 67 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 10/16 | completed | 7 × 1 | $1.09 | $0.0025 | $0.6593 |
| 68 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 11/16 | completed | 7 × 1 | $1.09 | $0.0013 | $0.6606 |
| 69 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 12/16 | completed | 7 × 1 | $1.09 | $0.0028 | $0.6634 |
| 70 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 13/16 | completed | 7 × 1 | $1.09 | $0.0034 | $0.6668 |
| 71 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 14/16 | completed | 7 × 1 | $1.09 | $0.0012 | $0.6680 |
| 72 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 15/16 | completed | 7 × 1 | $1.09 | $0.0009 | $0.6689 |
| 73 | 2026-10-23 | final pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 16/16 | completed | 7 × 1 | $1.09 | $0.0018 | $0.6707 |
| 74 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 1 | completed | 3 × 3 | $1.41 | $0.0022 | $0.6729 |
| 75 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 1 | completed | 2 × 3 | $0.94 | $0.0000 | $0.6729 |
| 76 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 1 | completed | 1 × 3 | $0.47 | $0.0000 | $0.6729 |
| 77 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 2 | completed | 1 × 3 | $0.47 | $0.0000 | $0.6729 |
| 78 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 3 | completed | 1 × 3 | $0.47 | $0.0000 | $0.6729 |
| 79 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 4 | completed | 1 × 3 | $1.10 | $0.0009 | $0.6738 |
| 80 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 5 | completed | 1 × 3 | $0.47 | $0.0002 | $0.6740 |
| 81 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 6 | completed | 1 × 3 | $0.47 | $0.0078 | $0.6819 |
| 82 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 7 | completed | 1 × 3 | $0.47 | $0.0003 | $0.6821 |
| 83 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 8 | completed | 1 × 3 | $0.47 | $0.0005 | $0.6827 |
| 84 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 9 | completed | 1 × 3 | $0.47 | $0.0008 | $0.6835 |
| 85 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 10 | completed | 1 × 3 | $0.47 | $0.0007 | $0.6842 |
| 86 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 11 | completed | 1 × 3 | $0.47 | $0.0049 | $0.6891 |
| 87 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 12 | completed | 1 × 3 | $0.47 | $0.0004 | $0.6896 |
| 88 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 13 | completed | 1 × 3 | $0.47 | $0.0008 | $0.6904 |
| 89 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 14 | completed | 1 × 3 | $0.47 | $0.0003 | $0.6907 |
| 90 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 15 | completed | 1 × 3 | $0.47 | $0.0003 | $0.6909 |
| 91 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 16 | completed | 1 × 3 | $0.47 | $0.0003 | $0.6912 |
| 92 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 17 | completed | 1 × 3 | $0.47 | $0.0002 | $0.6914 |
| 93 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 18 | completed | 1 × 3 | $0.47 | $0.0007 | $0.6921 |
| 94 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 19 | completed | 1 × 3 | $0.47 | $0.0007 | $0.6928 |
| 95 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 20 | completed | 1 × 3 | $0.47 | $0.0001 | $0.6930 |
| 96 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 21 | completed | 1 × 3 | $0.47 | $0.0001 | $0.6931 |
| 97 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 22 | completed | 1 × 3 | $0.47 | $0.0001 | $0.6932 |
| 98 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 23 | completed | 1 × 3 | $0.47 | $0.0001 | $0.6934 |
| 99 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 24 | completed | 1 × 3 | $0.47 | $0.0003 | $0.6937 |
| 100 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 25 | completed | 1 × 3 | $0.47 | $0.0003 | $0.6940 |
| 101 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 26 | completed | 1 × 3 | $0.47 | $0.0001 | $0.6941 |
| 102 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 27 | completed | 1 × 3 | $0.47 | $0.0012 | $0.6953 |
| 103 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 28 | completed | 1 × 3 | $0.47 | $0.0001 | $0.6954 |
| 104 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 29 | completed | 1 × 3 | $0.47 | $0.0002 | $0.6956 |
| 105 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 30 | completed | 1 × 3 | $0.47 | $0.0002 | $0.6958 |
| 106 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 31 | completed | 1 × 3 | $1.10 | $0.0005 | $0.6962 |
| 107 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 32 | completed | 1 × 3 | $0.47 | $0.0003 | $0.6965 |
| 108 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 33 | completed | 1 × 3 | $0.47 | $0.0005 | $0.6971 |
| 109 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 34 | completed | 1 × 3 | $0.47 | $0.0003 | $0.6974 |
| 110 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 35 | completed | 1 × 3 | $0.47 | $0.0003 | $0.6976 |
| 111 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 36 | completed | 1 × 3 | $0.47 | $0.0007 | $0.6984 |
| 112 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 37 | completed | 1 × 3 | $0.47 | $0.0004 | $0.6988 |
| 113 | 2026-10-23 | pass^3 safety+permissions+autonomy chunk 38 | completed | 1 × 3 | $0.47 | $0.0002 | $0.6989 |
| 114 | 2026-10-23 | pass^3 scheduling chunk 1 | completed | 1 × 3 | $0.47 | $0.0008 | $0.6997 |
| 115 | 2026-10-23 | pass^3 scheduling chunk 2 | completed | 1 × 3 | $0.47 | $0.0007 | $0.7004 |
| 116 | 2026-10-23 | pass^3 scheduling chunk 3 | completed | 1 × 3 | $0.47 | $0.0007 | $0.7012 |
| 117 | 2026-10-23 | pass^3 scheduling chunk 4 | completed | 1 × 3 | $0.47 | $0.0007 | $0.7019 |
| 118 | 2026-10-23 | pass^3 scheduling chunk 5 | completed | 1 × 3 | $0.47 | $0.0004 | $0.7023 |
| 119 | 2026-10-23 | pass^3 scheduling chunk 6 | completed | 1 × 3 | $0.47 | $0.0007 | $0.7030 |
| 120 | 2026-10-23 | pass^3 scheduling chunk 7 | completed | 1 × 3 | $0.47 | $0.0005 | $0.7035 |
| 121 | 2026-10-23 | pass^3 scheduling chunk 8 | completed | 1 × 3 | $0.47 | $0.0004 | $0.7039 |
| 122 | 2026-10-23 | pass^3 scheduling chunk 9 | completed | 1 × 3 | $0.47 | $0.0006 | $0.7045 |
| 123 | 2026-10-23 | pass^3 scheduling chunk 10 | completed | 1 × 3 | $0.47 | $0.0064 | $0.7109 |
| 124 | 2026-10-23 | pass^3 scheduling chunk 11 | completed | 1 × 3 | $0.47 | $0.0008 | $0.7117 |
| 125 | 2026-10-23 | pass^3 scheduling chunk 12 | completed | 1 × 3 | $0.47 | $0.0009 | $0.7125 |
| 126 | 2026-10-23 | pass^3 scheduling chunk 13 | completed | 1 × 3 | $0.47 | $0.0005 | $0.7130 |
| 127 | 2026-10-23 | pass^3 scheduling chunk 14 | completed | 1 × 3 | $0.47 | $0.0012 | $0.7143 |
| 128 | 2026-10-23 | pass^3 scheduling chunk 15 | completed | 1 × 3 | $0.47 | $0.0007 | $0.7150 |
| 129 | 2026-10-23 | pass^3 scheduling chunk 16 | completed | 1 × 3 | $0.47 | $0.0008 | $0.7157 |
| 130 | 2026-10-23 | pass^3 scheduling chunk 17 | completed | 1 × 3 | $0.47 | $0.0008 | $0.7165 |
| 131 | 2026-10-23 | pass^3 scheduling chunk 18 | completed | 1 × 3 | $0.47 | $0.0009 | $0.7174 |
| 132 | 2026-10-23 | pass^3 scheduling chunk 19 | completed | 1 × 3 | $0.47 | $0.0004 | $0.7178 |
| 133 | 2026-10-23 | pass^3 scheduling chunk 20 | completed | 1 × 3 | $0.47 | $0.0007 | $0.7185 |
| 134 | 2026-10-23 | pass^3 scheduling chunk 21 | completed | 1 × 3 | $0.47 | $0.0007 | $0.7192 |
| 135 | 2026-10-23 | pass^3 scheduling chunk 22 | completed | 1 × 3 | $0.47 | $0.0008 | $0.7200 |
| 136 | 2026-10-23 | pass^3 scheduling chunk 23 | completed | 1 × 3 | $0.47 | $0.0005 | $0.7205 |
| 137 | 2026-10-23 | pass^3 scheduling chunk 24 | completed | 1 × 3 | $0.47 | $0.0005 | $0.7210 |
| 138 | 2026-10-23 | pass^3 scheduling chunk 25 | completed | 1 × 3 | $0.47 | $0.0005 | $0.7214 |
| 139 | 2026-10-23 | pass^3 scheduling chunk 26 | completed | 1 × 3 | $0.47 | $0.0003 | $0.7217 |
| 140 | 2026-10-23 | pass^3 scheduling chunk 27 | completed | 1 × 3 | $0.47 | $0.0003 | $0.7220 |
| 141 | 2026-10-23 | pass^3 scheduling chunk 28 | completed | 1 × 3 | $0.47 | $0.0003 | $0.7223 |
| 142 | 2026-10-23 | pass^3 scheduling chunk 29 | completed | 1 × 3 | $0.47 | $0.0003 | $0.7226 |
| 143 | 2026-10-23 | pass^3 scheduling chunk 30 | completed | 1 × 3 | $0.47 | $0.0007 | $0.7234 |
| 144 | 2026-10-23 | pass^3 scheduling chunk 31 | completed | 1 × 3 | $0.47 | $0.0049 | $0.7283 |
| 145 | 2026-10-23 | pass^3 scheduling chunk 32 | completed | 1 × 3 | $0.47 | $0.0007 | $0.7290 |
| 146 | 2026-10-23 | pass^3 scheduling chunk 33 | completed | 1 × 3 | $0.47 | $0.0097 | $0.7387 |
| 147 | 2026-10-23 | pass^3 scheduling chunk 34 | completed | 1 × 3 | $0.47 | $0.0007 | $0.7394 |
| 148 | 2026-10-23 | pass^3 scheduling chunk 35 | completed | 1 × 3 | $0.47 | $0.0007 | $0.7401 |
| 149 | 2026-10-23 | pass^3 scheduling chunk 36 | completed | 1 × 3 | $0.47 | $0.0003 | $0.7404 |
| 150 | 2026-10-23 | pass^3 scheduling chunk 37 | completed | 1 × 3 | $0.47 | $0.0005 | $0.7410 |
| 151 | 2026-10-23 | pass^3 scheduling chunk 38 | completed | 1 × 3 | $0.47 | $0.0008 | $0.7417 |
| 152 | 2026-10-23 | pass^3 scheduling chunk 39 | completed | 1 × 3 | $0.47 | $0.0008 | $0.7425 |
| 153 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 1/42 | completed | 4 × 1 | $0.98 | $0.0021 | $0.7446 |
| 154 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 2/56 | completed | 3 × 1 | $0.55 | $0.0016 | $0.7461 |
| 155 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 3/56 | completed | 3 × 1 | $0.55 | $0.0024 | $0.7486 |
| 156 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 4/56 | completed | 3 × 1 | $0.55 | $0.0017 | $0.7503 |
| 157 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 5/56 | completed | 3 × 1 | $0.55 | $0.0012 | $0.7515 |
| 158 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 6/56 | completed | 3 × 1 | $0.79 | $0.0212 | $0.7727 |
| 159 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 7/56 | completed | 3 × 1 | $0.55 | $0.0010 | $0.7737 |
| 160 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 8/56 | completed | 3 × 1 | $0.55 | $0.0017 | $0.7754 |
| 161 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 9/56 | completed | 3 × 1 | $0.55 | $0.0011 | $0.7765 |
| 162 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 10/56 | completed | 3 × 1 | $0.55 | $0.0008 | $0.7773 |
| 163 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 11/56 | completed | 3 × 1 | $0.55 | $0.0007 | $0.7780 |
| 164 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 12/56 | completed | 3 × 1 | $0.55 | $0.0038 | $0.7818 |
| 165 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 13/56 | completed | 3 × 1 | $0.55 | $0.0016 | $0.7835 |
| 166 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 14/56 | completed | 3 × 1 | $0.55 | $0.0015 | $0.7850 |
| 167 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 15/56 | completed | 3 × 1 | $0.56 | $0.0012 | $0.7862 |
| 168 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 16/56 | completed | 3 × 1 | $0.55 | $0.0007 | $0.7869 |
| 169 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 17/56 | completed | 3 × 1 | $0.55 | $0.0016 | $0.7885 |
| 170 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 18/56 | completed | 3 × 1 | $0.56 | $0.0011 | $0.7896 |
| 171 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 19/56 | completed | 3 × 1 | $0.79 | $0.0014 | $0.7910 |
| 172 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 20/56 | completed | 3 × 1 | $0.56 | $0.0006 | $0.7916 |
| 173 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 21/56 | completed | 3 × 1 | $0.56 | $0.0013 | $0.7929 |
| 174 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 22/56 | completed | 3 × 1 | $0.56 | $0.0009 | $0.7938 |
| 175 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low chunk 23/56 | completed | 3 × 1 | $0.80 | $0.0016 | $0.7954 |
| 176 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 1/40 | completed | 1 × 1 | $0.42 | $0.0006 | $0.7959 |
| 177 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 2/40 | completed | 1 × 1 | $0.42 | $0.0005 | $0.7964 |
| 178 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 3/40 | completed | 1 × 1 | $0.42 | $0.0003 | $0.7967 |
| 179 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 4/40 | completed | 1 × 1 | $0.42 | $0.0010 | $0.7977 |
| 180 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 5/40 | completed | 1 × 1 | $0.42 | $0.0004 | $0.7981 |
| 181 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 6/40 | completed | 1 × 1 | $0.19 | $0.0002 | $0.7983 |
| 182 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 7/40 | completed | 1 × 1 | $0.42 | $0.0005 | $0.7988 |
| 183 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 8/40 | completed | 1 × 1 | $0.19 | $0.0004 | $0.7991 |
| 184 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 9/40 | completed | 1 × 1 | $0.42 | $0.0006 | $0.7997 |
| 185 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 10/40 | completed | 3 × 1 | $0.56 | $0.0006 | $0.8003 |
| 186 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 11/40 | completed | 3 × 1 | $0.56 | $0.0024 | $0.8027 |
| 187 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 12/40 | completed | 3 × 1 | $0.56 | $0.0007 | $0.8034 |
| 188 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 13/40 | completed | 3 × 1 | $0.55 | $0.0008 | $0.8043 |
| 189 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 14/40 | completed | 3 × 1 | $0.55 | $0.0205 | $0.8247 |
| 190 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 15/40 | completed | 3 × 1 | $0.55 | $0.0007 | $0.8254 |
| 191 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 16/40 | completed | 3 × 1 | $0.56 | $0.0006 | $0.8260 |
| 192 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 17/40 | completed | 3 × 1 | $0.55 | $0.0004 | $0.8264 |
| 193 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 18/40 | completed | 3 × 1 | $0.55 | $0.0009 | $0.8273 |
| 194 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 19/40 | completed | 3 × 1 | $0.56 | $0.0003 | $0.8276 |
| 195 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 20/40 | completed | 1 × 1 | $0.42 | $0.0003 | $0.8279 |
| 196 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 21/40 | completed | 3 × 1 | $0.55 | $0.0009 | $0.8288 |
| 197 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 22/40 | completed | 3 × 1 | $0.55 | $0.0009 | $0.8297 |
| 198 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 23/40 | completed | 3 × 1 | $0.56 | $0.0018 | $0.8315 |
| 199 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 24/40 | completed | 3 × 1 | $0.55 | $0.0011 | $0.8326 |
| 200 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 25/40 | completed | 3 × 1 | $0.55 | $0.0009 | $0.8335 |
| 201 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 26/40 | completed | 3 × 1 | $0.55 | $0.0041 | $0.8376 |
| 202 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 27/40 | completed | 3 × 1 | $0.55 | $0.0059 | $0.8435 |
| 203 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 28/40 | completed | 3 × 1 | $0.55 | $0.0013 | $0.8448 |
| 204 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 29/40 | completed | 3 × 1 | $0.55 | $0.0011 | $0.8460 |
| 205 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 30/40 | completed | 3 × 1 | $0.55 | $0.0222 | $0.8682 |
| 206 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 31/40 | completed | 3 × 1 | $0.55 | $0.0015 | $0.8696 |
| 207 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 32/40 | completed | 3 × 1 | $0.55 | $0.0007 | $0.8704 |
| 208 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 33/40 | completed | 3 × 1 | $0.55 | $0.0007 | $0.8711 |
| 209 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 34/40 | completed | 3 × 1 | $0.55 | $0.0008 | $0.8718 |
| 210 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 35/40 | completed | 3 × 1 | $0.55 | $0.0225 | $0.8944 |
| 211 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 36/40 | completed | 3 × 1 | $0.55 | $0.0010 | $0.8954 |
| 212 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 37/40 | completed | 3 × 1 | $0.55 | $0.0012 | $0.8966 |
| 213 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 38/40 | completed | 3 × 1 | $0.55 | $0.0008 | $0.8973 |
| 214 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 39/40 | completed | 3 × 1 | $0.55 | $0.0007 | $0.8981 |
| 215 | 2026-10-23 | P7 S30b pass^1 gpt-6-luna low / gpt-6.1-sol low part 40/40 | completed | 1 × 1 | $0.18 | $0.0004 | $0.8985 |
| 216 | 2026-10-23 | P7 S30b re-record after fixes, part 1/70 | completed | 1 × 1 | $0.19 | $0.0011 | $0.8996 |
| 217 | 2026-10-23 | P7 S30b re-record after fixes, part 2/70 | completed | 1 × 1 | $0.43 | $0.0006 | $0.9002 |
| 218 | 2026-10-23 | P7 S30b re-record after fixes, part 3/70 | completed | 3 × 1 | $0.56 | $0.0007 | $0.9009 |
| 219 | 2026-10-23 | P7 S30b re-record after fixes, part 4/70 | completed | 3 × 1 | $0.56 | $0.0032 | $0.9041 |
| 220 | 2026-10-23 | P7 S30b re-record after fixes, part 5/70 | completed | 3 × 1 | $0.56 | $0.0017 | $0.9058 |
| 221 | 2026-10-23 | P7 S30b re-record after fixes, part 6/70 | completed | 3 × 1 | $0.56 | $0.0013 | $0.9071 |
| 222 | 2026-10-23 | P7 S30b re-record after fixes, part 7/70 | completed | 1 × 1 | $0.19 | $0.0004 | $0.9075 |
| 223 | 2026-10-23 | P7 S30b re-record after fixes, part 8/70 | completed | 1 × 1 | $0.43 | $0.0005 | $0.9080 |
| 224 | 2026-10-23 | P7 S30b re-record after fixes, part 9/70 | completed | 3 × 1 | $0.56 | $0.0213 | $0.9293 |
| 225 | 2026-10-23 | P7 S30b re-record after fixes, part 10/70 | completed | 3 × 1 | $0.56 | $0.0020 | $0.9314 |
| 226 | 2026-10-23 | P7 S30b re-record after fixes, part 11/70 | completed | 3 × 1 | $0.56 | $0.0044 | $0.9358 |
| 227 | 2026-10-23 | P7 S30b re-record after fixes, part 12/70 | completed | 3 × 1 | $0.56 | $0.0011 | $0.9369 |
| 228 | 2026-10-23 | P7 S30b re-record after fixes, part 13/70 | completed | 3 × 1 | $0.56 | $0.0008 | $0.9376 |
| 229 | 2026-10-23 | P7 S30b re-record after fixes, part 14/70 | completed | 3 × 1 | $0.56 | $0.0032 | $0.9408 |
| 230 | 2026-10-23 | P7 S30b re-record after fixes, part 15/70 | completed | 3 × 1 | $0.56 | $0.0044 | $0.9452 |
| 231 | 2026-10-23 | P7 S30b re-record after fixes, part 16/70 | completed | 3 × 1 | $0.56 | $0.0023 | $0.9475 |
| 232 | 2026-10-23 | P7 S30b re-record after fixes, part 17/70 | completed | 3 × 1 | $0.56 | $0.0008 | $0.9483 |
| 233 | 2026-10-23 | P7 S30b re-record after fixes, part 18/70 | completed | 3 × 1 | $0.56 | $0.0011 | $0.9493 |
| 234 | 2026-10-23 | P7 S30b re-record after fixes, part 19/70 | completed | 3 × 1 | $0.56 | $0.0007 | $0.9501 |
| 235 | 2026-10-23 | P7 S30b re-record after fixes, part 20/70 | completed | 3 × 1 | $0.56 | $0.0016 | $0.9516 |
| 236 | 2026-10-23 | P7 S30b re-record after fixes, part 21/70 | completed | 2 × 1 | $0.37 | $0.0009 | $0.9525 |
| 237 | 2026-10-23 | P7 S30b re-record after fixes, part 22/70 | completed | 2 × 1 | $0.37 | $0.0008 | $0.9533 |
| 238 | 2026-10-23 | P7 S30b re-record after fixes, part 23/70 | completed | 1 × 1 | $0.43 | $0.0005 | $0.9538 |
| 239 | 2026-10-23 | P7 S30b re-record after fixes, part 24/70 | completed | 3 × 1 | $0.56 | $0.0007 | $0.9544 |
| 240 | 2026-10-23 | P7 S30b re-record after fixes, part 25/70 | completed | 2 × 1 | $0.37 | $0.0011 | $0.9555 |
| 241 | 2026-10-23 | P7 S30b re-record after fixes, part 26/70 | completed | 2 × 1 | $0.37 | $0.0004 | $0.9559 |
| 242 | 2026-10-23 | P7 S30b re-record after fixes, part 27/70 | completed | 2 × 1 | $0.37 | $0.0007 | $0.9566 |
| 243 | 2026-10-23 | P7 S30b re-record after fixes, part 28/70 | completed | 2 × 1 | $0.37 | $0.0012 | $0.9578 |
| 244 | 2026-10-23 | P7 S30b re-record after fixes, part 29/70 | completed | 1 × 1 | $0.43 | $0.0004 | $0.9582 |
| 245 | 2026-10-23 | P7 S30b re-record after fixes, part 30/70 | completed | 1 × 1 | $0.43 | $0.0005 | $0.9587 |
| 246 | 2026-10-23 | P7 S30b re-record after fixes, part 31/70 | completed | 1 × 1 | $0.43 | $0.0005 | $0.9592 |
| 247 | 2026-10-23 | P7 S30b re-record after fixes, part 32/70 | completed | 1 × 1 | $0.43 | $0.0003 | $0.9595 |
| 248 | 2026-10-23 | P7 S30b re-record after fixes, part 33/70 | completed | 1 × 1 | $0.43 | $0.0010 | $0.9604 |
| 249 | 2026-10-23 | P7 S30b re-record after fixes, part 34/70 | completed | 1 × 1 | $0.43 | $0.0003 | $0.9608 |
| 250 | 2026-10-23 | P7 S30b re-record after fixes, part 35/70 | completed | 1 × 1 | $0.19 | $0.0003 | $0.9611 |
| 251 | 2026-10-23 | P7 S30b re-record after fixes, part 36/70 | completed | 1 × 1 | $0.43 | $0.0006 | $0.9617 |
| 252 | 2026-10-23 | P7 S30b re-record after fixes, part 37/70 | completed | 1 × 1 | $0.19 | $0.0004 | $0.9621 |
| 253 | 2026-10-23 | P7 S30b re-record after fixes, part 38/70 | completed | 1 × 1 | $0.43 | $0.0005 | $0.9626 |
| 254 | 2026-10-23 | P7 S30b re-record after fixes, part 39/70 | completed | 2 × 1 | $0.37 | $0.0006 | $0.9632 |
| 255 | 2026-10-23 | P7 S30b re-record after fixes, part 40/70 | completed | 2 × 1 | $0.37 | $0.0012 | $0.9644 |
| 256 | 2026-10-23 | P7 S30b re-record after fixes, part 41/70 | completed | 3 × 1 | $0.56 | $0.0016 | $0.9660 |
| 257 | 2026-10-23 | P7 S30b re-record after fixes, part 42/70 | completed | 3 × 1 | $0.56 | $0.0006 | $0.9667 |
| 258 | 2026-10-23 | P7 S30b re-record after fixes, part 43/70 | completed | 3 × 1 | $0.56 | $0.0212 | $0.9878 |
| 259 | 2026-10-23 | P7 S30b re-record after fixes, part 44/70 | completed | 3 × 1 | $0.56 | $0.0005 | $0.9884 |
| 260 | 2026-10-23 | P7 S30b re-record after fixes, part 45/70 | completed | 3 × 1 | $0.56 | $0.0009 | $0.9893 |
| 261 | 2026-10-23 | P7 S30b re-record after fixes, part 46/70 | completed | 2 × 1 | $0.37 | $0.0002 | $0.9895 |
| 262 | 2026-10-23 | P7 S30b re-record after fixes, part 47/70 | completed | 3 × 1 | $0.56 | $0.0004 | $0.9898 |
| 263 | 2026-10-23 | P7 S30b re-record after fixes, part 48/70 | completed | 3 × 1 | $0.56 | $0.0009 | $0.9907 |
| 264 | 2026-10-23 | P7 S30b re-record after fixes, part 49/70 | completed | 3 × 1 | $0.56 | $0.0003 | $0.9910 |
| 265 | 2026-10-23 | P7 S30b re-record after fixes, part 50/70 | completed | 1 × 1 | $0.43 | $0.0003 | $0.9913 |
| 266 | 2026-10-23 | P7 S30b re-record after fixes, part 51/70 | completed | 3 × 1 | $0.56 | $0.0005 | $0.9918 |
| 267 | 2026-10-23 | P7 S30b re-record after fixes, part 52/70 | completed | 3 × 1 | $0.56 | $0.0008 | $0.9926 |
| 268 | 2026-10-23 | P7 S30b re-record after fixes, part 53/70 | completed | 3 × 1 | $0.56 | $0.0018 | $0.9944 |
| 269 | 2026-10-23 | P7 S30b re-record after fixes, part 54/70 | completed | 3 × 1 | $0.56 | $0.0011 | $0.9954 |
| 270 | 2026-10-23 | P7 S30b re-record after fixes, part 55/70 | completed | 3 × 1 | $0.56 | $0.0010 | $0.9964 |
| 271 | 2026-10-23 | P7 S30b re-record after fixes, part 56/70 | completed | 3 × 1 | $0.56 | $0.0041 | $1.0005 |
| 272 | 2026-10-23 | P7 S30b re-record after fixes, part 57/70 | completed | 3 × 1 | $0.56 | $0.0017 | $1.0022 |
| 273 | 2026-10-23 | P7 S30b re-record after fixes, part 58/70 | completed | 3 × 1 | $0.56 | $0.0014 | $1.0035 |
| 274 | 2026-10-23 | P7 S30b re-record after fixes, part 59/70 | completed | 3 × 1 | $0.56 | $0.0054 | $1.0089 |
| 275 | 2026-10-23 | P7 S30b re-record after fixes, part 60/70 | completed | 3 × 1 | $0.56 | $0.0026 | $1.0115 |
| 276 | 2026-10-23 | P7 S30b re-record after fixes, part 61/70 | completed | 3 × 1 | $0.56 | $0.0011 | $1.0126 |
| 277 | 2026-10-23 | P7 S30b re-record after fixes, part 62/70 | completed | 3 × 1 | $0.56 | $0.0008 | $1.0134 |
| 278 | 2026-10-23 | P7 S30b re-record after fixes, part 63/70 | completed | 3 × 1 | $0.56 | $0.0008 | $1.0141 |
| 279 | 2026-10-23 | P7 S30b re-record after fixes, part 64/70 | completed | 3 × 1 | $0.56 | $0.0008 | $1.0149 |
| 280 | 2026-10-23 | P7 S30b re-record after fixes, part 65/70 | completed | 3 × 1 | $0.56 | $0.0209 | $1.0359 |
| 281 | 2026-10-23 | P7 S30b re-record after fixes, part 66/70 | completed | 3 × 1 | $0.56 | $0.0010 | $1.0369 |
| 282 | 2026-10-23 | P7 S30b re-record after fixes, part 67/70 | completed | 3 × 1 | $0.56 | $0.0011 | $1.0379 |
| 283 | 2026-10-23 | P7 S30b re-record after fixes, part 68/70 | completed | 3 × 1 | $0.56 | $0.0008 | $1.0387 |
| 284 | 2026-10-23 | P7 S30b re-record after fixes, part 69/70 | completed | 3 × 1 | $0.56 | $0.0008 | $1.0396 |
| 285 | 2026-10-23 | P7 S30b re-record after fixes, part 70/70 | completed | 1 × 1 | $0.19 | $0.0004 | $1.0400 |
| 286 | 2026-10-23 | P7 episode_retrieval embeddings | completed | 25 × 1 | $0.01 | $0.0000 | $1.0400 |
| 287 | 2026-10-23 | P7 S31 pass^1 part 1/107 | completed | 1 × 1 | $0.21 | $0.0002 | $1.0402 |
| 288 | 2026-10-23 | P7 S31 pass^1 part 2/107 | completed | 1 × 1 | $0.48 | $0.0007 | $1.0409 |
| 289 | 2026-10-23 | P7 S31 pass^1 part 3/107 | completed | 2 × 1 | $0.42 | $0.0004 | $1.0413 |
| 290 | 2026-10-23 | P7 S31 pass^1 part 4/107 | completed | 2 × 1 | $0.42 | $0.0020 | $1.0433 |
| 291 | 2026-10-23 | P7 S31 pass^1 part 5/107 | completed | 2 × 1 | $0.42 | $0.0023 | $1.0456 |
| 292 | 2026-10-23 | P7 S31 pass^1 part 6/107 | completed | 2 × 1 | $0.42 | $0.0008 | $1.0465 |
| 293 | 2026-10-23 | P7 S31 pass^1 part 7/107 | completed | 2 × 1 | $0.42 | $0.0016 | $1.0481 |
| 294 | 2026-10-23 | P7 S31 pass^1 part 8/107 | completed | 2 × 1 | $0.42 | $0.0010 | $1.0491 |
| 295 | 2026-10-23 | P7 S31 pass^1 part 9/107 | completed | 1 × 1 | $0.21 | $0.0005 | $1.0496 |
| 296 | 2026-10-23 | P7 S31 pass^1 part 10/107 | completed | 1 × 1 | $0.48 | $0.0006 | $1.0502 |
| 297 | 2026-10-23 | P7 S31 pass^1 part 11/107 | completed | 2 × 1 | $0.42 | $0.0241 | $1.0742 |
| 298 | 2026-10-23 | P7 S31 pass^1 part 12/107 | completed | 2 × 1 | $0.42 | $0.0006 | $1.0748 |
| 299 | 2026-10-23 | P7 S31 pass^1 part 13/107 | completed | 2 × 1 | $0.42 | $0.0020 | $1.0767 |
| 300 | 2026-10-23 | P7 S31 pass^1 part 14/107 | completed | 2 × 1 | $0.42 | $0.0004 | $1.0772 |
| 301 | 2026-10-23 | P7 S31 pass^1 part 15/107 | completed | 2 × 1 | $0.42 | $0.0044 | $1.0815 |
| 302 | 2026-10-23 | P7 S31 pass^1 part 16/107 | completed | 2 × 1 | $0.42 | $0.0009 | $1.0824 |
| 303 | 2026-10-23 | P7 S31 pass^1 part 17/107 | completed | 2 × 1 | $0.42 | $0.0005 | $1.0829 |
| 304 | 2026-10-23 | P7 S31 pass^1 part 18/107 | completed | 2 × 1 | $0.42 | $0.0006 | $1.0835 |
| 305 | 2026-10-23 | P7 S31 pass^1 part 19/107 | completed | 2 × 1 | $0.42 | $0.0005 | $1.0840 |
| 306 | 2026-10-23 | P7 S31 pass^1 part 20/107 | completed | 2 × 1 | $0.42 | $0.0014 | $1.0854 |
| 307 | 2026-10-23 | P7 S31 pass^1 part 21/107 | completed | 2 × 1 | $0.42 | $0.0019 | $1.0872 |

- Run 5, gpt-6-luna: 12 calls, 67483 in (38955 cached, 28492 written), 498 out, p50 1258 ms, p95 3286 ms; 3.61 chars a token
- Run 5, gpt-6.1-sol: 4 calls, 24750 in (12287 cached, 12451 written), 224 out, p50 2023 ms, p95 2349 ms; 3.61 chars a token
- Run 6, gpt-5.4-mini-2026-03-17: 12 calls, 67892 in (52992 cached, 0 written), 585 out, p50 1021 ms, p95 1415 ms; 3.52 chars a token
- Run 7, gpt-6-luna: 18 calls, 102481 in (89419 cached, 13008 written), 599 out, p50 1069 ms, p95 2031 ms; 3.51 chars a token
- Run 7, gpt-6.1-sol: 1 calls, 6018 in (0 cached, 6015 written), 40 out, p50 2349 ms, p95 2349 ms; 3.51 chars a token
- Run 8, gpt-6-luna: 18 calls, 101269 in (87947 cached, 13268 written), 786 out, p50 1104 ms, p95 1638 ms; 3.52 chars a token
- Run 8, gpt-6.1-sol: 3 calls, 18089 in (10868 cached, 7212 written), 104 out, p50 2184 ms, p95 2564 ms; 3.52 chars a token
- Run 9, gpt-6-luna: 19 calls, 106655 in (104591 cached, 2007 written), 736 out, p50 1018 ms, p95 1708 ms; 3.55 chars a token
- Run 9, gpt-6.1-sol: 6 calls, 37839 in (34697 cached, 3124 written), 339 out, p50 2182 ms, p95 2528 ms; 3.55 chars a token
- Run 10, gpt-6-luna: 19 calls, 106644 in (104235 cached, 2352 written), 698 out, p50 1051 ms, p95 1862 ms; 3.51 chars a token
- Run 10, gpt-6.1-sol: 3 calls, 17973 in (10868 cached, 7096 written), 111 out, p50 1890 ms, p95 2266 ms; 3.51 chars a token
- Run 11, gpt-6-luna: 16 calls, 88240 in (87217 cached, 975 written), 467 out, p50 932 ms, p95 1267 ms; 3.53 chars a token
- Run 11, gpt-6.1-sol: 1 calls, 5730 in (5434 cached, 293 written), 14 out, p50 1936 ms, p95 1936 ms; 3.53 chars a token
- Run 12, gpt-6-luna: 12 calls, 67775 in (60236 cached, 7503 written), 681 out, p50 1427 ms, p95 3004 ms; 3.59 chars a token
- Run 12, gpt-6.1-sol: 4 calls, 25890 in (23392 cached, 2486 written), 205 out, p50 2151 ms, p95 2426 ms; 3.59 chars a token
- Run 13, gpt-6-luna: 14 calls, 77566 in (76481 cached, 1043 written), 464 out, p50 1137 ms, p95 1992 ms; 3.52 chars a token
- Run 13, gpt-6.1-sol: 1 calls, 5958 in (5434 cached, 521 written), 20 out, p50 1815 ms, p95 1815 ms; 3.52 chars a token
- Run 14, gpt-6-luna: 10 calls, 55656 in (54461 cached, 1165 written), 722 out, p50 1424 ms, p95 1987 ms; 3.61 chars a token
- Run 14, gpt-6.1-sol: 1 calls, 6707 in (5434 cached, 1270 written), 66 out, p50 2876 ms, p95 2876 ms; 3.61 chars a token
- Run 15, gpt-6-luna: 15 calls, 83647 in (82173 cached, 1429 written), 646 out, p50 995 ms, p95 2186 ms; 3.62 chars a token
- Run 15, gpt-6.1-sol: 1 calls, 6132 in (5434 cached, 695 written), 39 out, p50 2230 ms, p95 2230 ms; 3.62 chars a token
- Run 16, gpt-6-luna: 16 calls, 90039 in (87949 cached, 2042 written), 712 out, p50 966 ms, p95 1582 ms; 3.53 chars a token
- Run 16, gpt-6.1-sol: 5 calls, 32090 in (29522 cached, 2553 written), 212 out, p50 2014 ms, p95 2824 ms; 3.53 chars a token
- Run 17, gpt-6-luna: 19 calls, 107672 in (104351 cached, 3264 written), 719 out, p50 1212 ms, p95 2864 ms; 3.50 chars a token
- Run 17, gpt-6.1-sol: 2 calls, 12011 in (10868 cached, 1137 written), 51 out, p50 1863 ms, p95 2228 ms; 3.50 chars a token
- Run 18, gpt-6-luna: 21 calls, 120649 in (115978 cached, 4608 written), 1351 out, p50 1234 ms, p95 4883 ms; 3.50 chars a token
- Run 18, gpt-6.1-sol: 5 calls, 33506 in (24757 cached, 8734 written), 352 out, p50 2812 ms, p95 3742 ms; 3.50 chars a token
- Run 19, gpt-6-luna: 17 calls, 97027 in (88160 cached, 8816 written), 693 out, p50 1274 ms, p95 2451 ms; 3.50 chars a token
- Run 20, gpt-6-luna: 16 calls, 89184 in (87482 cached, 1654 written), 400 out, p50 1097 ms, p95 1630 ms; 3.51 chars a token
- Run 21, gpt-6-luna: 19 calls, 106805 in (104486 cached, 2262 written), 609 out, p50 1210 ms, p95 3024 ms; 3.53 chars a token
- Run 21, gpt-6.1-sol: 4 calls, 24235 in (22340 cached, 1883 written), 179 out, p50 1707 ms, p95 2173 ms; 3.53 chars a token
- Run 22, gpt-6-luna: 17 calls, 95339 in (93415 cached, 1873 written), 637 out, p50 1218 ms, p95 1584 ms; 3.54 chars a token
- Run 22, gpt-6.1-sol: 1 calls, 6132 in (5434 cached, 695 written), 25 out, p50 1892 ms, p95 1892 ms; 3.54 chars a token
- Run 23, gpt-6-luna: 5 calls, 27641 in (27307 cached, 319 written), 129 out, p50 1188 ms, p95 1739 ms; 3.53 chars a token
- Run 24, gpt-5.4-mini-2026-03-17: 15 calls, 85805 in (78336 cached, 0 written), 760 out, p50 1099 ms, p95 1554 ms; 3.51 chars a token
- Run 25, gpt-5.4-mini-2026-03-17: 19 calls, 108915 in (100480 cached, 0 written), 1052 out, p50 987 ms, p95 2102 ms; 3.50 chars a token
- Run 26, gpt-5.4-mini-2026-03-17: 19 calls, 106908 in (97280 cached, 0 written), 781 out, p50 938 ms, p95 1656 ms; 3.52 chars a token
- Run 26, gpt-6.1-sol: 5 calls, 31452 in (29117 cached, 2320 written), 244 out, p50 5216 ms, p95 11120 ms; 3.52 chars a token
- Run 27, gpt-5.4-mini-2026-03-17: 17 calls, 95783 in (88448 cached, 0 written), 763 out, p50 804 ms, p95 1083 ms; 3.51 chars a token
- Run 27, gpt-6.1-sol: 4 calls, 24959 in (23276 cached, 1671 written), 215 out, p50 3977 ms, p95 5342 ms; 3.51 chars a token
- Run 28, gpt-5.4-mini-2026-03-17: 16 calls, 88548 in (86016 cached, 0 written), 550 out, p50 755 ms, p95 1215 ms; 3.53 chars a token
- Run 28, gpt-6.1-sol: 1 calls, 5723 in (5434 cached, 286 written), 14 out, p50 1504 ms, p95 1504 ms; 3.53 chars a token
- Run 29, gpt-5.4-mini-2026-03-17: 12 calls, 67255 in (61568 cached, 0 written), 540 out, p50 882 ms, p95 1627 ms; 3.52 chars a token
- Run 29, gpt-6.1-sol: 3 calls, 18835 in (17817 cached, 1009 written), 159 out, p50 2297 ms, p95 2446 ms; 3.52 chars a token
- Run 30, gpt-5.4-mini-2026-03-17: 14 calls, 77425 in (75264 cached, 0 written), 507 out, p50 772 ms, p95 1070 ms; 3.52 chars a token
- Run 30, gpt-6.1-sol: 2 calls, 11896 in (10868 cached, 1022 written), 52 out, p50 1598 ms, p95 1763 ms; 3.52 chars a token
- Run 31, gpt-5.4-mini-2026-03-17: 10 calls, 55705 in (53760 cached, 0 written), 571 out, p50 882 ms, p95 1167 ms; 3.53 chars a token
- Run 31, gpt-6.1-sol: 1 calls, 6721 in (5434 cached, 1284 written), 46 out, p50 3252 ms, p95 3252 ms; 3.53 chars a token
- Run 32, gpt-5.4-mini-2026-03-17: 16 calls, 89518 in (80768 cached, 0 written), 754 out, p50 835 ms, p95 1139 ms; 3.52 chars a token
- Run 32, gpt-6.1-sol: 1 calls, 6522 in (5434 cached, 1085 written), 50 out, p50 2262 ms, p95 2262 ms; 3.52 chars a token
- Run 33, gpt-5.4-mini-2026-03-17: 14 calls, 78915 in (76032 cached, 0 written), 708 out, p50 841 ms, p95 1286 ms; 3.51 chars a token
- Run 33, gpt-6.1-sol: 1 calls, 5964 in (5434 cached, 527 written), 17 out, p50 6279 ms, p95 6279 ms; 3.51 chars a token
- Run 34, gpt-5.4-mini-2026-03-17: 19 calls, 107976 in (102912 cached, 0 written), 776 out, p50 862 ms, p95 1088 ms; 3.50 chars a token
- Run 34, gpt-6.1-sol: 2 calls, 12187 in (10868 cached, 1313 written), 49 out, p50 7885 ms, p95 8579 ms; 3.50 chars a token
- Run 35, gpt-5.4-mini-2026-03-17: 20 calls, 115352 in (108800 cached, 0 written), 1280 out, p50 903 ms, p95 1260 ms; 3.51 chars a token
- Run 35, gpt-6.1-sol: 1 calls, 6073 in (5434 cached, 636 written), 51 out, p50 3906 ms, p95 3906 ms; 3.51 chars a token
- Run 36, gpt-5.4-mini-2026-03-17: 17 calls, 97135 in (90624 cached, 0 written), 754 out, p50 827 ms, p95 1311 ms; 3.50 chars a token
- Run 37, gpt-5.4-mini-2026-03-17: 16 calls, 88930 in (84352 cached, 0 written), 437 out, p50 740 ms, p95 1379 ms; 3.51 chars a token
- Run 38, gpt-5.4-mini-2026-03-17: 19 calls, 107647 in (102912 cached, 0 written), 929 out, p50 807 ms, p95 1011 ms; 3.51 chars a token
- Run 38, gpt-6.1-sol: 2 calls, 12184 in (10868 cached, 1310 written), 41 out, p50 1707 ms, p95 1979 ms; 3.51 chars a token
- Run 39, gpt-5.4-mini-2026-03-17: 16 calls, 89852 in (86272 cached, 0 written), 675 out, p50 803 ms, p95 3272 ms; 3.51 chars a token
- Run 39, gpt-6.1-sol: 2 calls, 12097 in (10868 cached, 1223 written), 56 out, p50 1576 ms, p95 2114 ms; 3.51 chars a token
- Run 40, gpt-5.4-mini-2026-03-17: 5 calls, 27646 in (26880 cached, 0 written), 146 out, p50 891 ms, p95 1501 ms; 3.52 chars a token
- Run 41, gpt-6-luna: 22 calls, 124395 in (110883 cached, 13446 written), 839 out, p50 1036 ms, p95 2160 ms; 3.52 chars a token
- Run 41, gpt-6.1-sol: 1 calls, 5951 in (0 cached, 5948 written), 36 out, p50 1872 ms, p95 1872 ms; 3.52 chars a token
- Run 42, gpt-6-luna: 16 calls, 90865 in (72274 cached, 18543 written), 889 out, p50 1154 ms, p95 2060 ms; 3.63 chars a token
- Run 42, gpt-6.1-sol: 3 calls, 18904 in (5509 cached, 13386 written), 122 out, p50 1953 ms, p95 2659 ms; 3.63 chars a token
- Run 43, gpt-6-luna: 30 calls, 174317 in (164101 cached, 10126 written), 1383 out, p50 1199 ms, p95 4858 ms; 3.56 chars a token
- Run 44, gpt-6-luna: 28 calls, 161498 in (146821 cached, 14593 written), 1025 out, p50 1259 ms, p95 2291 ms; 3.54 chars a token
- Run 44, gpt-6.1-sol: 2 calls, 12704 in (0 cached, 12698 written), 45 out, p50 1692 ms, p95 2223 ms; 3.54 chars a token
- Run 45, gpt-6-luna: 19 calls, 110687 in (96759 cached, 13871 written), 737 out, p50 1468 ms, p95 2652 ms; 3.60 chars a token
- Run 46, gpt-6-luna: 21 calls, 121361 in (107330 cached, 13968 written), 910 out, p50 1289 ms, p95 1902 ms; 3.55 chars a token
- Run 47, gpt-6-luna: 23 calls, 132927 in (129965 cached, 2893 written), 1036 out, p50 1421 ms, p95 2226 ms; 3.56 chars a token
- Run 47, gpt-6.1-sol: 1 calls, 6531 in (5531 cached, 997 written), 40 out, p50 1930 ms, p95 1930 ms; 3.56 chars a token
- Run 48, gpt-6-luna: 14 calls, 80855 in (78985 cached, 1828 written), 457 out, p50 1352 ms, p95 7581 ms; 3.54 chars a token
- Run 61, gpt-6.1-sol: 1 calls, 6472 in (5531 cached, 938 written), 48 out, p50 2996 ms, p95 2996 ms; 3.53 chars a token
- Run 61, gpt-6-luna: 9 calls, 51912 in (50762 cached, 1123 written), 354 out, p50 1212 ms, p95 2239 ms; 3.53 chars a token
- Run 62, gpt-6-luna: 14 calls, 79014 in (77913 cached, 1059 written), 400 out, p50 1207 ms, p95 1798 ms; 3.54 chars a token
- Run 63, gpt-6-luna: 20 calls, 115107 in (101491 cached, 13556 written), 917 out, p50 1585 ms, p95 2815 ms; 3.60 chars a token
- Run 63, gpt-6.1-sol: 2 calls, 12637 in (5531 cached, 7100 written), 89 out, p50 2539 ms, p95 2737 ms; 3.60 chars a token
- Run 64, gpt-6-luna: 16 calls, 90831 in (89492 cached, 1291 written), 491 out, p50 1101 ms, p95 1858 ms; 3.54 chars a token
- Run 65, gpt-6-luna: 11 calls, 63362 in (61918 cached, 1411 written), 613 out, p50 1651 ms, p95 2729 ms; 3.63 chars a token
- Run 66, gpt-6-luna: 12 calls, 67360 in (66596 cached, 728 written), 519 out, p50 1355 ms, p95 2465 ms; 3.54 chars a token
- Run 67, gpt-6-luna: 19 calls, 109866 in (101395 cached, 8414 written), 946 out, p50 1354 ms, p95 2460 ms; 3.56 chars a token
- Run 68, gpt-6-luna: 13 calls, 74943 in (72603 cached, 2301 written), 504 out, p50 1330 ms, p95 2433 ms; 3.52 chars a token
- Run 69, gpt-6-luna: 25 calls, 146753 in (141520 cached, 5158 written), 1423 out, p50 1271 ms, p95 2052 ms; 3.53 chars a token
- Run 70, gpt-6-luna: 22 calls, 127743 in (112765 cached, 14912 written), 832 out, p50 1301 ms, p95 2128 ms; 3.53 chars a token
- Run 71, gpt-6-luna: 15 calls, 84359 in (83127 cached, 1187 written), 392 out, p50 1199 ms, p95 1714 ms; 3.54 chars a token
- Run 72, gpt-6-luna: 10 calls, 57907 in (56675 cached, 1202 written), 421 out, p50 1416 ms, p95 3360 ms; 3.54 chars a token
- Run 73, gpt-6-luna: 21 calls, 120743 in (118347 cached, 2333 written), 655 out, p50 1318 ms, p95 2218 ms; 3.53 chars a token
- Run 74, gpt-6-luna: 24 calls, 139312 in (136167 cached, 3073 written), 953 out, p50 1236 ms, p95 1853 ms; 3.54 chars a token
- Run 79, gpt-6-luna: 10 calls, 58385 in (57283 cached, 1072 written), 333 out, p50 1218 ms, p95 1799 ms; 3.55 chars a token
- Run 80, gpt-6-luna: 2 calls, 11094 in (11088 cached, 0 written), 198 out, p50 2107 ms, p95 2223 ms; 3.53 chars a token
- Run 81, gpt-6-luna: 8 calls, 46333 in (44837 cached, 1472 written), 470 out, p50 1507 ms, p95 1932 ms; 3.55 chars a token
- Run 81, gpt-6.1-sol: 2 calls, 13078 in (11062 cached, 2010 written), 82 out, p50 2072 ms, p95 2095 ms; 3.55 chars a token
- Run 82, gpt-6-luna: 4 calls, 22358 in (22346 cached, 0 written), 114 out, p50 1328 ms, p95 1536 ms; 3.54 chars a token
- Run 83, gpt-6-luna: 6 calls, 34617 in (33817 cached, 782 written), 212 out, p50 1257 ms, p95 1776 ms; 3.52 chars a token
- Run 84, gpt-6-luna: 8 calls, 46909 in (45740 cached, 1145 written), 421 out, p50 1423 ms, p95 2703 ms; 3.58 chars a token
- Run 85, gpt-6-luna: 8 calls, 46200 in (45210 cached, 966 written), 277 out, p50 1156 ms, p95 1543 ms; 3.55 chars a token
- Run 86, gpt-6-luna: 8 calls, 47297 in (45672 cached, 1601 written), 417 out, p50 1347 ms, p95 1724 ms; 3.51 chars a token
- Run 86, gpt-6.1-sol: 1 calls, 6774 in (5531 cached, 1240 written), 39 out, p50 2263 ms, p95 2263 ms; 3.51 chars a token
- Run 87, gpt-6-luna: 5 calls, 28703 in (27985 cached, 703 written), 150 out, p50 1145 ms, p95 1798 ms; 3.52 chars a token
- Run 88, gpt-6-luna: 8 calls, 46592 in (45212 cached, 1356 written), 337 out, p50 1338 ms, p95 1650 ms; 3.62 chars a token
- Run 89, gpt-6-luna: 4 calls, 22384 in (22372 cached, 0 written), 137 out, p50 1190 ms, p95 1469 ms; 3.54 chars a token
- Run 90, gpt-6-luna: 4 calls, 22298 in (22286 cached, 0 written), 111 out, p50 1019 ms, p95 1378 ms; 3.54 chars a token
- Run 91, gpt-6-luna: 4 calls, 22294 in (22282 cached, 0 written), 70 out, p50 1186 ms, p95 1281 ms; 3.54 chars a token
- Run 92, gpt-6-luna: 2 calls, 11094 in (11088 cached, 0 written), 105 out, p50 1302 ms, p95 1956 ms; 3.53 chars a token
- Run 93, gpt-6-luna: 8 calls, 46231 in (45226 cached, 981 written), 283 out, p50 1065 ms, p95 1230 ms; 3.54 chars a token
- Run 94, gpt-6-luna: 8 calls, 46310 in (45265 cached, 1021 written), 306 out, p50 1151 ms, p95 1568 ms; 3.54 chars a token
- Run 95, gpt-6-luna: 2 calls, 11126 in (11120 cached, 0 written), 60 out, p50 1523 ms, p95 1572 ms; 3.53 chars a token
- Run 96, gpt-6-luna: 2 calls, 11118 in (11112 cached, 0 written), 55 out, p50 1145 ms, p95 1539 ms; 3.53 chars a token
- Run 97, gpt-6-luna: 2 calls, 11104 in (11098 cached, 0 written), 59 out, p50 1492 ms, p95 1578 ms; 3.53 chars a token
- Run 98, gpt-6-luna: 2 calls, 11104 in (11098 cached, 0 written), 75 out, p50 1381 ms, p95 1698 ms; 3.53 chars a token
- Run 99, gpt-6-luna: 4 calls, 22352 in (22172 cached, 168 written), 78 out, p50 1392 ms, p95 2100 ms; 3.54 chars a token
- Run 100, gpt-6-luna: 3 calls, 16996 in (16638 cached, 349 written), 190 out, p50 1728 ms, p95 1852 ms; 3.64 chars a token
- Run 101, gpt-6-luna: 2 calls, 11100 in (11094 cached, 0 written), 61 out, p50 1595 ms, p95 1635 ms; 3.53 chars a token
- Run 102, gpt-6-luna: 8 calls, 48975 in (46617 cached, 2334 written), 801 out, p50 1646 ms, p95 2808 ms; 3.77 chars a token
- Run 103, gpt-6-luna: 2 calls, 11122 in (11116 cached, 0 written), 75 out, p50 1529 ms, p95 1640 ms; 3.53 chars a token
- Run 104, gpt-6-luna: 2 calls, 11138 in (11132 cached, 0 written), 143 out, p50 2162 ms, p95 2360 ms; 3.53 chars a token
- Run 105, gpt-6-luna: 2 calls, 11116 in (11110 cached, 0 written), 107 out, p50 1514 ms, p95 2356 ms; 3.53 chars a token
- Run 106, gpt-6-luna: 6 calls, 33682 in (33664 cached, 0 written), 224 out, p50 1417 ms, p95 2067 ms; 3.55 chars a token
- Run 107, gpt-6-luna: 3 calls, 16920 in (16641 cached, 270 written), 238 out, p50 1998 ms, p95 2402 ms; 3.52 chars a token
- Run 108, gpt-6-luna: 6 calls, 34175 in (33423 cached, 734 written), 200 out, p50 1375 ms, p95 1578 ms; 3.54 chars a token
- Run 109, gpt-6-luna: 4 calls, 22400 in (22388 cached, 0 written), 137 out, p50 1530 ms, p95 1713 ms; 3.54 chars a token
- Run 110, gpt-6-luna: 4 calls, 22294 in (22282 cached, 0 written), 75 out, p50 1273 ms, p95 1590 ms; 3.54 chars a token
- Run 111, gpt-6-luna: 8 calls, 46457 in (45402 cached, 1031 written), 329 out, p50 1344 ms, p95 1670 ms; 3.58 chars a token
- Run 112, gpt-6-luna: 4 calls, 22573 in (22200 cached, 361 written), 294 out, p50 2236 ms, p95 2907 ms; 3.76 chars a token
- Run 113, gpt-6-luna: 2 calls, 11182 in (11176 cached, 0 written), 86 out, p50 1353 ms, p95 1406 ms; 3.53 chars a token
- Run 114, gpt-6-luna: 8 calls, 46809 in (45670 cached, 1115 written), 368 out, p50 1451 ms, p95 2458 ms; 3.53 chars a token
- Run 115, gpt-6-luna: 6 calls, 35408 in (34031 cached, 1359 written), 413 out, p50 1431 ms, p95 1885 ms; 3.52 chars a token
- Run 116, gpt-6-luna: 8 calls, 46278 in (45246 cached, 1008 written), 307 out, p50 1397 ms, p95 1760 ms; 3.54 chars a token
- Run 117, gpt-6-luna: 8 calls, 46261 in (45252 cached, 985 written), 290 out, p50 1431 ms, p95 1717 ms; 3.54 chars a token
- Run 118, gpt-6-luna: 4 calls, 22809 in (22164 cached, 633 written), 142 out, p50 1378 ms, p95 1494 ms; 3.52 chars a token
- Run 119, gpt-6-luna: 6 calls, 35774 in (33820 cached, 1936 written), 256 out, p50 1173 ms, p95 1787 ms; 3.50 chars a token
- Run 120, gpt-6-luna: 6 calls, 34157 in (33418 cached, 721 written), 172 out, p50 1124 ms, p95 1800 ms; 3.54 chars a token
- Run 121, gpt-6-luna: 4 calls, 22746 in (22168 cached, 566 written), 197 out, p50 1425 ms, p95 2298 ms; 3.52 chars a token
- Run 122, gpt-6-luna: 6 calls, 34651 in (33825 cached, 808 written), 234 out, p50 1436 ms, p95 1821 ms; 3.52 chars a token
- Run 123, gpt-6-luna: 8 calls, 46563 in (45254 cached, 1285 written), 328 out, p50 1649 ms, p95 2082 ms; 3.53 chars a token
- Run 123, gpt-6.1-sol: 2 calls, 12700 in (11062 cached, 1632 written), 43 out, p50 1521 ms, p95 2345 ms; 3.53 chars a token
- Run 124, gpt-6-luna: 8 calls, 46805 in (45635 cached, 1146 written), 398 out, p50 1121 ms, p95 1808 ms; 3.58 chars a token
- Run 125, gpt-6-luna: 6 calls, 36007 in (33849 cached, 2140 written), 519 out, p50 1756 ms, p95 2518 ms; 3.50 chars a token
- Run 126, gpt-6-luna: 6 calls, 34159 in (33419 cached, 722 written), 179 out, p50 1173 ms, p95 1560 ms; 3.54 chars a token
- Run 127, gpt-6-luna: 7 calls, 42400 in (39521 cached, 2858 written), 941 out, p50 1338 ms, p95 3804 ms; 3.66 chars a token
- Run 128, gpt-6-luna: 6 calls, 35164 in (34008 cached, 1138 written), 397 out, p50 1486 ms, p95 2066 ms; 3.58 chars a token
- Run 129, gpt-6-luna: 8 calls, 46800 in (45671 cached, 1105 written), 366 out, p50 1370 ms, p95 2105 ms; 3.57 chars a token
- Run 130, gpt-6-luna: 8 calls, 46470 in (45237 cached, 1209 written), 341 out, p50 1375 ms, p95 4034 ms; 3.55 chars a token
- Run 131, gpt-6-luna: 7 calls, 42513 in (40583 cached, 1909 written), 543 out, p50 1837 ms, p95 2817 ms; 3.55 chars a token
- Run 132, gpt-6-luna: 4 calls, 22805 in (22164 cached, 629 written), 134 out, p50 1607 ms, p95 1796 ms; 3.52 chars a token
- Run 133, gpt-6-luna: 6 calls, 35778 in (33810 cached, 1950 written), 295 out, p50 1354 ms, p95 2183 ms; 3.50 chars a token
- Run 134, gpt-6-luna: 6 calls, 35669 in (33809 cached, 1842 written), 242 out, p50 1227 ms, p95 2316 ms; 3.51 chars a token
- Run 135, gpt-6-luna: 8 calls, 46698 in (45586 cached, 1088 written), 362 out, p50 1095 ms, p95 2352 ms; 3.58 chars a token
- Run 136, gpt-6-luna: 6 calls, 33820 in (33402 cached, 400 written), 165 out, p50 1232 ms, p95 1610 ms; 3.55 chars a token
- Run 137, gpt-6-luna: 6 calls, 34159 in (33418 cached, 723 written), 176 out, p50 1163 ms, p95 1639 ms; 3.54 chars a token
- Run 138, gpt-6-luna: 6 calls, 33816 in (33410 cached, 388 written), 156 out, p50 1035 ms, p95 1371 ms; 3.55 chars a token
- Run 139, gpt-6-luna: 4 calls, 22334 in (22322 cached, 0 written), 92 out, p50 1356 ms, p95 2402 ms; 3.54 chars a token
- Run 140, gpt-6-luna: 4 calls, 22346 in (22334 cached, 0 written), 94 out, p50 1222 ms, p95 1353 ms; 3.54 chars a token
- Run 141, gpt-6-luna: 4 calls, 22711 in (22156 cached, 543 written), 59 out, p50 1187 ms, p95 1561 ms; 3.52 chars a token
- Run 142, gpt-6-luna: 4 calls, 22715 in (22164 cached, 539 written), 106 out, p50 1239 ms, p95 1377 ms; 3.52 chars a token
- Run 143, gpt-6-luna: 8 calls, 46649 in (45588 cached, 1037 written), 316 out, p50 1325 ms, p95 1820 ms; 3.54 chars a token
- Run 144, gpt-6-luna: 8 calls, 47292 in (45697 cached, 1571 written), 414 out, p50 1334 ms, p95 1930 ms; 3.52 chars a token
- Run 144, gpt-6.1-sol: 1 calls, 6757 in (5531 cached, 1223 written), 42 out, p50 3306 ms, p95 3306 ms; 3.52 chars a token
- Run 145, gpt-6-luna: 8 calls, 46310 in (45268 cached, 1018 written), 307 out, p50 1090 ms, p95 1640 ms; 3.54 chars a token
- Run 146, gpt-6-luna: 8 calls, 46493 in (45241 cached, 1228 written), 323 out, p50 1223 ms, p95 1402 ms; 3.53 chars a token
- Run 146, gpt-6.1-sol: 3 calls, 20206 in (17929 cached, 2268 written), 141 out, p50 2318 ms, p95 2448 ms; 3.53 chars a token
- Run 147, gpt-6-luna: 8 calls, 46186 in (45201 cached, 961 written), 269 out, p50 1220 ms, p95 1529 ms; 3.55 chars a token
- Run 148, gpt-6-luna: 8 calls, 46311 in (45287 cached, 1000 written), 285 out, p50 1143 ms, p95 1311 ms; 3.54 chars a token
- Run 149, gpt-6-luna: 4 calls, 22358 in (22346 cached, 0 written), 146 out, p50 1286 ms, p95 1605 ms; 3.54 chars a token
- Run 150, gpt-6-luna: 6 calls, 34562 in (33785 cached, 759 written), 203 out, p50 1254 ms, p95 1520 ms; 3.52 chars a token
- Run 151, gpt-6-luna: 8 calls, 47529 in (46087 cached, 1418 written), 283 out, p50 1082 ms, p95 1341 ms; 3.51 chars a token
- Run 152, gpt-6-luna: 8 calls, 47680 in (46206 cached, 1450 written), 302 out, p50 1098 ms, p95 1519 ms; 3.63 chars a token
- Run 153, gpt-6-luna: 12 calls, 86085 in (77735 cached, 8314 written), 467 out, p50 1939 ms, p95 2798 ms; 3.69 chars a token
- Run 154, gpt-6-luna: 7 calls, 49922 in (42074 cached, 7827 written), 314 out, p50 2426 ms, p95 4249 ms; 3.71 chars a token
- Run 155, gpt-6-luna: 8 calls, 56982 in (42042 cached, 14916 written), 322 out, p50 1481 ms, p95 2024 ms; 3.66 chars a token
- Run 156, gpt-6-luna: 9 calls, 63947 in (55896 cached, 8024 written), 321 out, p50 1473 ms, p95 3323 ms; 3.66 chars a token
- Run 157, gpt-6-luna: 11 calls, 78764 in (77144 cached, 1587 written), 479 out, p50 1809 ms, p95 6870 ms; 3.67 chars a token
- Run 158, gpt-6-luna: 10 calls, 71445 in (70126 cached, 1289 written), 500 out, p50 1667 ms, p95 3694 ms; 3.67 chars a token
- Run 158, gpt-6.1-sol: 1 calls, 7888 in (0 cached, 7885 written), 35 out, p50 3450 ms, p95 3450 ms; 3.67 chars a token
- Run 159, gpt-6-luna: 9 calls, 64098 in (62849 cached, 1222 written), 471 out, p50 2262 ms, p95 3586 ms; 3.70 chars a token
- Run 160, gpt-6-luna: 9 calls, 63704 in (55869 cached, 7808 written), 281 out, p50 1467 ms, p95 2568 ms; 3.67 chars a token
- Run 161, gpt-6-luna: 10 calls, 71427 in (69969 cached, 1428 written), 410 out, p50 1378 ms, p95 6627 ms; 3.66 chars a token
- Run 162, gpt-6-luna: 8 calls, 56389 in (55526 cached, 839 written), 292 out, p50 1595 ms, p95 2277 ms; 3.67 chars a token
- Run 163, gpt-6-luna: 7 calls, 49192 in (48535 cached, 636 written), 217 out, p50 1812 ms, p95 2664 ms; 3.66 chars a token
- Run 164, gpt-6-luna: 8 calls, 56369 in (48719 cached, 7626 written), 292 out, p50 2556 ms, p95 3013 ms; 3.70 chars a token
- Run 164, gpt-6.1-sol: 1 calls, 7454 in (6888 cached, 563 written), 14 out, p50 1923 ms, p95 1923 ms; 3.70 chars a token
- Run 165, gpt-6-luna: 8 calls, 56749 in (48934 cached, 7791 written), 367 out, p50 1422 ms, p95 2809 ms; 3.67 chars a token
- Run 166, gpt-6-luna: 8 calls, 55864 in (48456 cached, 7384 written), 253 out, p50 2651 ms, p95 2970 ms; 3.68 chars a token
- Run 167, gpt-6-luna: 11 calls, 79003 in (76962 cached, 2008 written), 337 out, p50 1636 ms, p95 2628 ms; 3.67 chars a token
- Run 168, gpt-6-luna: 6 calls, 42108 in (41446 cached, 644 written), 382 out, p50 1744 ms, p95 3891 ms; 3.67 chars a token
- Run 169, gpt-6-luna: 9 calls, 62930 in (55423 cached, 7480 written), 289 out, p50 2072 ms, p95 2642 ms; 3.68 chars a token
- Run 170, gpt-6-luna: 9 calls, 65024 in (63199 cached, 1798 written), 455 out, p50 2327 ms, p95 3163 ms; 3.70 chars a token
- Run 171, gpt-6-luna: 13 calls, 92880 in (91090 cached, 1751 written), 468 out, p50 1891 ms, p95 2437 ms; 3.69 chars a token
- Run 172, gpt-6-luna: 7 calls, 49013 in (48345 cached, 647 written), 161 out, p50 1644 ms, p95 2590 ms; 3.67 chars a token
- Run 173, gpt-6-luna: 5 calls, 34993 in (27575 cached, 7403 written), 119 out, p50 1984 ms, p95 2349 ms; 3.67 chars a token
- Run 174, gpt-6-luna: 8 calls, 58079 in (56323 cached, 1732 written), 241 out, p50 1313 ms, p95 1717 ms; 3.67 chars a token
- Run 175, gpt-6-luna: 8 calls, 56393 in (48424 cached, 7945 written), 211 out, p50 1519 ms, p95 2442 ms; 3.68 chars a token
- Run 176, gpt-6-luna: 5 calls, 35696 in (34812 cached, 869 written), 199 out, p50 2507 ms, p95 3088 ms; 3.74 chars a token
- Run 177, gpt-6-luna: 5 calls, 35281 in (34568 cached, 698 written), 154 out, p50 1988 ms, p95 2321 ms; 3.67 chars a token
- Run 178, gpt-6-luna: 3 calls, 21039 in (20691 cached, 339 written), 77 out, p50 1822 ms, p95 1863 ms; 3.68 chars a token
- Run 179, gpt-6-luna: 2 calls, 13901 in (6888 cached, 7007 written), 38 out, p50 1652 ms, p95 1759 ms; 3.67 chars a token
- Run 180, gpt-6-luna: 4 calls, 28511 in (27852 cached, 647 written), 131 out, p50 2438 ms, p95 2735 ms; 3.74 chars a token
- Run 181, gpt-6-luna: 2 calls, 13885 in (13796 cached, 83 written), 69 out, p50 2187 ms, p95 2265 ms; 3.67 chars a token
- Run 182, gpt-6-luna: 4 calls, 28765 in (28180 cached, 573 written), 205 out, p50 1848 ms, p95 2382 ms; 3.66 chars a token
- Run 183, gpt-6-luna: 3 calls, 21527 in (20833 cached, 685 written), 115 out, p50 1667 ms, p95 3113 ms; 3.68 chars a token
- Run 184, gpt-6-luna: 5 calls, 35333 in (34789 cached, 529 written), 298 out, p50 2205 ms, p95 3173 ms; 3.69 chars a token
- Run 185, gpt-6-luna: 7 calls, 48966 in (48411 cached, 534 written), 165 out, p50 1987 ms, p95 4081 ms; 3.68 chars a token
- Run 186, gpt-6-luna: 8 calls, 57414 in (42340 cached, 15050 written), 271 out, p50 1637 ms, p95 2284 ms; 3.66 chars a token
- Run 187, gpt-6-luna: 7 calls, 48974 in (48457 cached, 496 written), 237 out, p50 1696 ms, p95 1824 ms; 3.68 chars a token
- Run 188, gpt-6-luna: 8 calls, 56824 in (55814 cached, 986 written), 320 out, p50 1567 ms, p95 2826 ms; 3.66 chars a token
- Run 189, gpt-6-luna: 8 calls, 56500 in (55602 cached, 874 written), 334 out, p50 1486 ms, p95 2180 ms; 3.73 chars a token
- Run 189, gpt-6.1-sol: 1 calls, 7728 in (0 cached, 7725 written), 30 out, p50 2224 ms, p95 2224 ms; 3.73 chars a token
- Run 190, gpt-6-luna: 7 calls, 49332 in (48719 cached, 592 written), 208 out, p50 1536 ms, p95 2003 ms; 3.67 chars a token
- Run 191, gpt-6-luna: 6 calls, 42406 in (41815 cached, 573 written), 311 out, p50 1484 ms, p95 2411 ms; 3.67 chars a token
- Run 192, gpt-6-luna: 4 calls, 27708 in (27564 cached, 132 written), 115 out, p50 1242 ms, p95 1845 ms; 3.67 chars a token
- Run 193, gpt-6-luna: 6 calls, 42856 in (41452 cached, 1386 written), 572 out, p50 2208 ms, p95 2912 ms; 3.76 chars a token
- Run 194, gpt-6-luna: 3 calls, 20759 in (20664 cached, 86 written), 247 out, p50 2166 ms, p95 3417 ms; 3.66 chars a token
- Run 195, gpt-6-luna: 3 calls, 20912 in (20767 cached, 136 written), 105 out, p50 1913 ms, p95 2069 ms; 3.68 chars a token
- Run 196, gpt-6-luna: 8 calls, 56822 in (55569 cached, 1229 written), 399 out, p50 2355 ms, p95 3656 ms; 3.71 chars a token
- Run 197, gpt-6-luna: 8 calls, 56740 in (55659 cached, 1057 written), 400 out, p50 1875 ms, p95 3853 ms; 3.74 chars a token
- Run 198, gpt-6-luna: 9 calls, 64826 in (56523 cached, 8276 written), 465 out, p50 2013 ms, p95 3176 ms; 3.68 chars a token
- Run 199, gpt-6-luna: 10 calls, 71244 in (69871 cached, 1343 written), 365 out, p50 1600 ms, p95 2384 ms; 3.67 chars a token
- Run 200, gpt-6-luna: 8 calls, 57252 in (55529 cached, 1699 written), 346 out, p50 1643 ms, p95 2345 ms; 3.65 chars a token
- Run 201, gpt-6-luna: 11 calls, 78870 in (77222 cached, 1615 written), 459 out, p50 1571 ms, p95 3843 ms; 3.66 chars a token
- Run 201, gpt-6.1-sol: 1 calls, 7682 in (6888 cached, 791 written), 25 out, p50 2595 ms, p95 2595 ms; 3.66 chars a token
- Run 202, gpt-6-luna: 11 calls, 79881 in (76884 cached, 2964 written), 814 out, p50 1888 ms, p95 5088 ms; 3.72 chars a token
- Run 202, gpt-6.1-sol: 1 calls, 8197 in (6888 cached, 1306 written), 37 out, p50 5955 ms, p95 5955 ms; 3.72 chars a token
- Run 203, gpt-6-luna: 12 calls, 86260 in (84469 cached, 1755 written), 531 out, p50 2375 ms, p95 3379 ms; 3.67 chars a token
- Run 204, gpt-6-luna: 9 calls, 65878 in (63707 cached, 2144 written), 448 out, p50 2004 ms, p95 2771 ms; 3.64 chars a token
- Run 205, gpt-6-luna: 9 calls, 64821 in (49193 cached, 15601 written), 444 out, p50 1603 ms, p95 3071 ms; 3.65 chars a token
- Run 205, gpt-6.1-sol: 1 calls, 7641 in (0 cached, 7638 written), 44 out, p50 2660 ms, p95 2660 ms; 3.65 chars a token
- Run 206, gpt-6-luna: 10 calls, 72515 in (69929 cached, 2556 written), 880 out, p50 1735 ms, p95 5815 ms; 3.70 chars a token
- Run 207, gpt-6-luna: 8 calls, 55990 in (55316 cached, 650 written), 211 out, p50 1761 ms, p95 2732 ms; 3.67 chars a token
- Run 208, gpt-6-luna: 7 calls, 49524 in (48536 cached, 967 written), 157 out, p50 2442 ms, p95 3058 ms; 3.65 chars a token
- Run 209, gpt-6-luna: 8 calls, 56557 in (55775 cached, 758 written), 237 out, p50 1258 ms, p95 2054 ms; 3.67 chars a token
- Run 210, gpt-6-luna: 11 calls, 78578 in (76985 cached, 1560 written), 486 out, p50 1616 ms, p95 2084 ms; 3.77 chars a token
- Run 210, gpt-6.1-sol: 2 calls, 15463 in (7651 cached, 7806 written), 104 out, p50 3672 ms, p95 3818 ms; 3.77 chars a token
- Run 211, gpt-6-luna: 10 calls, 70982 in (69864 cached, 1088 written), 350 out, p50 1673 ms, p95 2705 ms; 3.67 chars a token
- Run 212, gpt-6-luna: 11 calls, 79625 in (77813 cached, 1779 written), 356 out, p50 1382 ms, p95 2345 ms; 3.65 chars a token
- Run 213, gpt-6-luna: 8 calls, 56274 in (55646 cached, 604 written), 251 out, p50 1728 ms, p95 2720 ms; 3.67 chars a token
- Run 214, gpt-6-luna: 8 calls, 55886 in (55362 cached, 500 written), 236 out, p50 1520 ms, p95 2279 ms; 3.68 chars a token
- Run 215, gpt-6-luna: 4 calls, 28560 in (28058 cached, 490 written), 149 out, p50 2630 ms, p95 2951 ms; 3.67 chars a token
- Run 216, gpt-6-luna: 3 calls, 21575 in (14208 cached, 7358 written), 56 out, p50 2386 ms, p95 3274 ms; 3.67 chars a token
- Run 217, gpt-6-luna: 6 calls, 44164 in (43454 cached, 692 written), 202 out, p50 1917 ms, p95 2814 ms; 3.68 chars a token
- Run 218, gpt-6-luna: 7 calls, 49569 in (48827 cached, 721 written), 203 out, p50 2005 ms, p95 3061 ms; 3.67 chars a token
- Run 219, gpt-6-luna: 7 calls, 50256 in (28241 cached, 21994 written), 316 out, p50 1928 ms, p95 3206 ms; 3.66 chars a token
- Run 220, gpt-6-luna: 8 calls, 57483 in (49433 cached, 8026 written), 336 out, p50 1833 ms, p95 2705 ms; 3.66 chars a token
- Run 221, gpt-6-luna: 12 calls, 87159 in (85351 cached, 1772 written), 542 out, p50 1772 ms, p95 2247 ms; 3.69 chars a token
- Run 222, gpt-6-luna: 4 calls, 28828 in (28321 cached, 495 written), 134 out, p50 2234 ms, p95 3783 ms; 3.68 chars a token
- Run 223, gpt-6-luna: 5 calls, 36293 in (35743 cached, 535 written), 166 out, p50 1311 ms, p95 1527 ms; 3.68 chars a token
- Run 224, gpt-6-luna: 7 calls, 49898 in (48999 cached, 878 written), 445 out, p50 2331 ms, p95 7433 ms; 3.77 chars a token
- Run 224, gpt-6.1-sol: 1 calls, 8024 in (0 cached, 8021 written), 41 out, p50 2937 ms, p95 2937 ms; 3.77 chars a token
- Run 225, gpt-6-luna: 11 calls, 79621 in (71095 cached, 8493 written), 508 out, p50 1825 ms, p95 2396 ms; 3.75 chars a token
- Run 226, gpt-6-luna: 9 calls, 64774 in (63399 cached, 1348 written), 373 out, p50 1985 ms, p95 3216 ms; 3.67 chars a token
- Run 226, gpt-6.1-sol: 1 calls, 7863 in (6958 cached, 902 written), 49 out, p50 2872 ms, p95 2872 ms; 3.67 chars a token
- Run 227, gpt-6-luna: 10 calls, 72323 in (70857 cached, 1436 written), 389 out, p50 1714 ms, p95 2227 ms; 3.66 chars a token
- Run 228, gpt-6-luna: 8 calls, 56508 in (55908 cached, 576 written), 240 out, p50 1327 ms, p95 2076 ms; 3.71 chars a token
- Run 229, gpt-6-luna: 9 calls, 64461 in (63407 cached, 1027 written), 298 out, p50 1738 ms, p95 2614 ms; 3.73 chars a token
- Run 229, gpt-6.1-sol: 1 calls, 7543 in (6958 cached, 582 written), 14 out, p50 2449 ms, p95 2449 ms; 3.73 chars a token
- Run 230, gpt-6-luna: 8 calls, 57020 in (49239 cached, 7757 written), 335 out, p50 1703 ms, p95 1934 ms; 3.71 chars a token
- Run 230, gpt-6.1-sol: 1 calls, 7623 in (6958 cached, 662 written), 41 out, p50 3149 ms, p95 3149 ms; 3.71 chars a token
- Run 231, gpt-6-luna: 7 calls, 49286 in (34921 cached, 14344 written), 212 out, p50 1707 ms, p95 2235 ms; 3.68 chars a token
- Run 232, gpt-6-luna: 8 calls, 56768 in (56080 cached, 664 written), 243 out, p50 2097 ms, p95 3567 ms; 3.68 chars a token
- Run 233, gpt-6-luna: 10 calls, 72248 in (70488 cached, 1730 written), 308 out, p50 2460 ms, p95 3384 ms; 3.68 chars a token
- Run 234, gpt-6-luna: 7 calls, 49723 in (48919 cached, 783 written), 257 out, p50 2208 ms, p95 3568 ms; 3.67 chars a token
- Run 235, gpt-6-luna: 8 calls, 56514 in (48936 cached, 7554 written), 229 out, p50 2475 ms, p95 3465 ms; 3.69 chars a token
- Run 236, gpt-6-luna: 7 calls, 51677 in (50055 cached, 1601 written), 391 out, p50 1771 ms, p95 2490 ms; 3.67 chars a token
- Run 237, gpt-6-luna: 6 calls, 44104 in (42695 cached, 1391 written), 414 out, p50 2774 ms, p95 3110 ms; 3.67 chars a token
- Run 238, gpt-6-luna: 5 calls, 35278 in (34907 cached, 356 written), 117 out, p50 3141 ms, p95 3833 ms; 3.68 chars a token
- Run 239, gpt-6-luna: 7 calls, 49511 in (48835 cached, 655 written), 157 out, p50 3360 ms, p95 4710 ms; 3.68 chars a token
- Run 240, gpt-6-luna: 3 calls, 21336 in (13928 cached, 7399 written), 59 out, p50 2185 ms, p95 2350 ms; 3.67 chars a token
- Run 241, gpt-6-luna: 4 calls, 28115 in (27860 cached, 243 written), 91 out, p50 2096 ms, p95 3155 ms; 3.68 chars a token
- Run 242, gpt-6-luna: 6 calls, 44535 in (42943 cached, 1574 written), 204 out, p50 2162 ms, p95 3019 ms; 3.68 chars a token
- Run 243, gpt-6-luna: 4 calls, 28375 in (20896 cached, 7467 written), 103 out, p50 1879 ms, p95 3945 ms; 3.68 chars a token
- Run 244, gpt-6-luna: 4 calls, 28556 in (28023 cached, 521 written), 118 out, p50 3755 ms, p95 10007 ms; 3.70 chars a token
- Run 245, gpt-6-luna: 4 calls, 28758 in (27982 cached, 764 written), 176 out, p50 3315 ms, p95 3573 ms; 3.75 chars a token
- Run 246, gpt-6-luna: 5 calls, 35602 in (34915 cached, 672 written), 153 out, p50 3549 ms, p95 4137 ms; 3.67 chars a token
- Run 247, gpt-6-luna: 3 calls, 21246 in (20901 cached, 336 written), 100 out, p50 2339 ms, p95 2683 ms; 3.69 chars a token
- Run 248, gpt-6-luna: 2 calls, 14043 in (6958 cached, 7079 written), 30 out, p50 3118 ms, p95 4796 ms; 3.68 chars a token
- Run 249, gpt-6-luna: 3 calls, 21413 in (20916 cached, 488 written), 106 out, p50 3510 ms, p95 3635 ms; 3.68 chars a token
- Run 250, gpt-6-luna: 3 calls, 21509 in (20985 cached, 515 written), 97 out, p50 2643 ms, p95 2745 ms; 3.67 chars a token
- Run 251, gpt-6-luna: 5 calls, 36998 in (35906 cached, 1077 written), 225 out, p50 2497 ms, p95 2971 ms; 3.67 chars a token
- Run 252, gpt-6-luna: 3 calls, 21735 in (21045 cached, 681 written), 112 out, p50 3126 ms, p95 3664 ms; 3.68 chars a token
- Run 253, gpt-6-luna: 5 calls, 35643 in (35124 cached, 504 written), 243 out, p50 3016 ms, p95 3438 ms; 3.70 chars a token
- Run 254, gpt-6-luna: 6 calls, 42858 in (42034 cached, 806 written), 184 out, p50 2058 ms, p95 2412 ms; 3.68 chars a token
- Run 255, gpt-6-luna: 4 calls, 28509 in (20976 cached, 7521 written), 128 out, p50 3469 ms, p95 6233 ms; 3.67 chars a token
- Run 256, gpt-6-luna: 8 calls, 57552 in (49612 cached, 7916 written), 275 out, p50 1901 ms, p95 4377 ms; 3.67 chars a token
- Run 257, gpt-6-luna: 6 calls, 42620 in (41988 cached, 614 written), 235 out, p50 2420 ms, p95 3011 ms; 3.68 chars a token
- Run 258, gpt-6-luna: 10 calls, 72402 in (70771 cached, 1601 written), 516 out, p50 1944 ms, p95 3539 ms; 3.74 chars a token
- Run 258, gpt-6.1-sol: 1 calls, 7855 in (0 cached, 7852 written), 38 out, p50 3610 ms, p95 3610 ms; 3.74 chars a token
- Run 259, gpt-6-luna: 6 calls, 42050 in (41787 cached, 245 written), 153 out, p50 1104 ms, p95 1490 ms; 3.68 chars a token
- Run 260, gpt-6-luna: 9 calls, 64646 in (63590 cached, 1029 written), 318 out, p50 1291 ms, p95 1803 ms; 3.67 chars a token
- Run 261, gpt-6-luna: 2 calls, 13976 in (13916 cached, 54 written), 61 out, p50 2024 ms, p95 2451 ms; 3.67 chars a token
- Run 262, gpt-6-luna: 4 calls, 27988 in (27844 cached, 132 written), 111 out, p50 1264 ms, p95 2097 ms; 3.67 chars a token
- Run 263, gpt-6-luna: 6 calls, 44168 in (42847 cached, 1303 written), 521 out, p50 1986 ms, p95 2408 ms; 3.80 chars a token
- Run 264, gpt-6-luna: 3 calls, 20969 in (20874 cached, 86 written), 175 out, p50 1952 ms, p95 2351 ms; 3.67 chars a token
- Run 265, gpt-6-luna: 3 calls, 21122 in (20977 cached, 136 written), 122 out, p50 1821 ms, p95 1841 ms; 3.69 chars a token
- Run 266, gpt-6-luna: 5 calls, 35061 in (34817 cached, 229 written), 249 out, p50 1983 ms, p95 2759 ms; 3.67 chars a token
- Run 267, gpt-6-luna: 8 calls, 56965 in (56229 cached, 712 written), 253 out, p50 1563 ms, p95 1887 ms; 3.71 chars a token
- Run 268, gpt-6-luna: 9 calls, 65361 in (57050 cached, 8284 written), 409 out, p50 1779 ms, p95 2684 ms; 3.66 chars a token
- Run 269, gpt-6-luna: 10 calls, 71920 in (70553 cached, 1337 written), 365 out, p50 1425 ms, p95 2666 ms; 3.67 chars a token
- Run 270, gpt-6-luna: 8 calls, 57815 in (56085 cached, 1706 written), 348 out, p50 1661 ms, p95 2313 ms; 3.65 chars a token
- Run 271, gpt-6-luna: 11 calls, 79726 in (78025 cached, 1668 written), 489 out, p50 1438 ms, p95 2247 ms; 3.68 chars a token
- Run 271, gpt-6.1-sol: 1 calls, 7772 in (6958 cached, 811 written), 18 out, p50 2303 ms, p95 2303 ms; 3.68 chars a token
- Run 272, gpt-6-luna: 11 calls, 81848 in (78572 cached, 3243 written), 935 out, p50 1523 ms, p95 2936 ms; 3.72 chars a token
- Run 273, gpt-6-luna: 12 calls, 87214 in (85390 cached, 1788 written), 539 out, p50 1606 ms, p95 2190 ms; 3.67 chars a token
- Run 274, gpt-6-luna: 9 calls, 65530 in (63594 cached, 1909 written), 401 out, p50 1611 ms, p95 4159 ms; 3.68 chars a token
- Run 274, gpt-6.1-sol: 1 calls, 8237 in (6958 cached, 1276 written), 39 out, p50 2324 ms, p95 2324 ms; 3.68 chars a token
- Run 275, gpt-6-luna: 8 calls, 58337 in (42469 cached, 15844 written), 419 out, p50 2265 ms, p95 3688 ms; 3.65 chars a token
- Run 276, gpt-6-luna: 10 calls, 72382 in (70646 cached, 1706 written), 361 out, p50 2184 ms, p95 3048 ms; 3.66 chars a token
- Run 277, gpt-6-luna: 8 calls, 56577 in (55881 cached, 672 written), 210 out, p50 1653 ms, p95 2216 ms; 3.68 chars a token
- Run 278, gpt-6-luna: 7 calls, 49998 in (49025 cached, 952 written), 300 out, p50 1556 ms, p95 2876 ms; 3.66 chars a token
- Run 279, gpt-6-luna: 8 calls, 57200 in (56381 cached, 795 written), 249 out, p50 1836 ms, p95 2073 ms; 3.67 chars a token
- Run 280, gpt-6-luna: 12 calls, 86930 in (85171 cached, 1723 written), 497 out, p50 1463 ms, p95 2498 ms; 3.67 chars a token
- Run 280, gpt-6.1-sol: 1 calls, 7764 in (0 cached, 7761 written), 21 out, p50 3997 ms, p95 3997 ms; 3.67 chars a token
- Run 281, gpt-6-luna: 10 calls, 71642 in (70545 cached, 1067 written), 354 out, p50 1595 ms, p95 2600 ms; 3.68 chars a token
- Run 282, gpt-6-luna: 10 calls, 72626 in (71085 cached, 1511 written), 321 out, p50 1371 ms, p95 1723 ms; 3.66 chars a token
- Run 283, gpt-6-luna: 8 calls, 56866 in (56221 cached, 621 written), 255 out, p50 1629 ms, p95 2219 ms; 3.67 chars a token
- Run 284, gpt-6-luna: 9 calls, 63713 in (63083 cached, 603 written), 270 out, p50 1679 ms, p95 2384 ms; 3.74 chars a token
- Run 285, gpt-6-luna: 4 calls, 28853 in (28344 cached, 497 written), 147 out, p50 1646 ms, p95 1817 ms; 3.67 chars a token
- Run 286, text-embedding-3-small: 2 calls, 1122 in (0 cached, 0 written), 0 out, p50 698 ms, p95 1775 ms
- Run 287, gpt-6-luna: 2 calls, 16593 in (16458 cached, 129 written), 40 out, p50 2007 ms, p95 2103 ms; 3.72 chars a token
- Run 288, gpt-6-luna: 6 calls, 51123 in (50411 cached, 694 written), 201 out, p50 1326 ms, p95 1523 ms; 3.73 chars a token
- Run 289, gpt-6-luna: 4 calls, 33356 in (32976 cached, 368 written), 118 out, p50 1349 ms, p95 1855 ms; 3.72 chars a token
- Run 290, gpt-6-luna: 7 calls, 60868 in (50909 cached, 9938 written), 399 out, p50 2643 ms, p95 4528 ms; 3.72 chars a token
- Run 291, gpt-6-luna: 4 calls, 33433 in (16449 cached, 16972 written), 125 out, p50 1636 ms, p95 2695 ms; 3.71 chars a token
- Run 292, gpt-6-luna: 7 calls, 59336 in (58335 cached, 980 written), 281 out, p50 2170 ms, p95 4177 ms; 3.71 chars a token
- Run 293, gpt-6-luna: 6 calls, 50531 in (41563 cached, 8950 written), 216 out, p50 2004 ms, p95 2606 ms; 3.72 chars a token
- Run 294, gpt-6-luna: 8 calls, 68034 in (66916 cached, 1094 written), 349 out, p50 2528 ms, p95 2819 ms; 3.71 chars a token
- Run 295, gpt-6-luna: 4 calls, 33891 in (33371 cached, 508 written), 143 out, p50 1728 ms, p95 3919 ms; 3.72 chars a token
- Run 296, gpt-6-luna: 5 calls, 42610 in (42050 cached, 545 written), 173 out, p50 2264 ms, p95 2747 ms; 3.72 chars a token
- Run 297, gpt-6-luna: 5 calls, 42125 in (41361 cached, 749 written), 296 out, p50 1777 ms, p95 2823 ms; 3.72 chars a token
- Run 297, gpt-6.1-sol: 1 calls, 9214 in (0 cached, 9211 written), 38 out, p50 2163 ms, p95 2163 ms; 3.72 chars a token
- Run 298, gpt-6-luna: 5 calls, 41920 in (41398 cached, 507 written), 164 out, p50 2235 ms, p95 2727 ms; 3.71 chars a token
- Run 299, gpt-6-luna: 8 calls, 67901 in (58511 cached, 9366 written), 408 out, p50 2991 ms, p95 4621 ms; 3.75 chars a token
- Run 300, gpt-6-luna: 3 calls, 25045 in (24662 cached, 374 written), 242 out, p50 4237 ms, p95 5974 ms; 3.71 chars a token
- Run 301, gpt-6-luna: 7 calls, 59289 in (58269 cached, 999 written), 245 out, p50 1567 ms, p95 1957 ms; 3.72 chars a token
- Run 301, gpt-6.1-sol: 1 calls, 9101 in (8216 cached, 882 written), 49 out, p50 2230 ms, p95 2230 ms; 3.72 chars a token
- Run 302, gpt-6-luna: 7 calls, 59543 in (58485 cached, 1037 written), 307 out, p50 1677 ms, p95 2021 ms; 3.71 chars a token
- Run 303, gpt-6-luna: 5 calls, 41536 in (41194 cached, 327 written), 152 out, p50 1679 ms, p95 1990 ms; 3.72 chars a token
- Run 304, gpt-6-luna: 5 calls, 41947 in (41400 cached, 532 written), 182 out, p50 1580 ms, p95 1714 ms; 3.71 chars a token
- Run 305, gpt-6-luna: 5 calls, 41563 in (41224 cached, 324 written), 119 out, p50 1700 ms, p95 1981 ms; 3.72 chars a token
- Run 306, gpt-6-luna: 4 calls, 33153 in (24674 cached, 8467 written), 159 out, p50 1642 ms, p95 2973 ms; 3.78 chars a token
- Run 307, gpt-6-luna: 6 calls, 52413 in (42589 cached, 9806 written), 413 out, p50 1672 ms, p95 2421 ms; 3.68 chars a token
<!-- ledger:end -->

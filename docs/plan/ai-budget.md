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
Total spent: **$0.7503** of $5.00 (the runner stops at $4.50).

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
<!-- ledger:end -->

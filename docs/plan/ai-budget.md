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

## Phase 7 ($1.00 cap, raised to $1.55 in S33; [playbook §4](phase-7-playbook.md))

Runs labelled `P7`. The runner refuses a run whose worst-case estimate would take Phase 7 past its cap ($1.00 until S33, then $1.55).

- **S30b (2026-10-23): $0.2974 in 133 runs** (Phase 7 total: $0.2974; $0.70 left for S31–S33).
  - First pass of all 167 cases on `gpt-6-luna` low / `gpt-6.1-sol` low, pass^1: **$0.1560**, runs 153–215.
  - Re-record after the three fixes (ADR-0036; an instruction change makes every cassette stale): **$0.1415**, runs 216–285. 477 Luna calls and 8 Sol calls, about $0.0008 a case.
  - **Run size:** the worst-case estimate is up to $0.43 for a multi-turn memory case and about $0.19 for a one-turn case. So a 20-case run ($4.17) would break both the $1.50 run cap and the Phase 7 cap. Runs were packed to about $0.56 of estimate each (1–4 cases, `--case`). The estimate still runs 100–300× above actual spend.
  - The one refused run (estimate $1.28 with $0.05 spent) wrote no entry.

- **S31 (2026-10-23): $0.3826 in 275 runs** (Phase 7 total: $0.6800; $0.32 left for S32–S33). Over the planned $0.25 because the first recording found two problems, and the user chose to fix them and record again.
  - Embeddings for `episode_retrieval` (85 texts on `text-embedding-3-small`): **$0.00002**, run 286. Recall@5 25/25.
  - First pass, all 192 cases, pass^1: **$0.1856**, runs 287–393. memory_write missed its gate: "Note that we're closed…" went to the new `propose_rule`.
  - Re-record after the guide fix (the user's choice, ~$0.19): **$0.1967**, runs 394–559 (30 runs packed to $0.56; then, once the phase guard refused a packed run, 123 one-case runs and 13 multi-turn cases with `--phase-estimate-ok`); the `closed: null` fix, $0.0002, run 560.
  - 1,081 Luna calls, 15 Sol calls and 32 embedding calls. Prompt caching kept the input about 93% cached.
  - **The phase guard:** near the end of a phase, a multi-turn case's worst-case estimate ($0.48) is more than the room left, though it really costs about $0.001. The user chose `--phase-estimate-ok` for recordings. It skips only the pre-run estimate check; the in-run stop still refuses any call once actual Phase 7 spend reaches $1.00, and the run cap and the $4.50 stop stay. One run refused before the flag existed wrote no entry.

- **S32b (2026-10-23): $0.2195 in 143 runs** (Phase 7 total: $0.8994; $0.10 left for S33). The user allowed `--phase-estimate-ok` for this session again (the worst-case estimate, about $0.22 a case, was more than the $0.32 left).
  - Probe of the sets S32a's `remember_fact` guide touched (memory_write, learned_rules, scheduling, `mr-same-as-last-time`), 68 cases: **$0.1116**, runs 561–596. Every gate met; `mr-same-as-last-time` and `tool-block-time-2` passed.
  - Full recording, all 192 cases, pass^1 (the probe's 68 replayed free): **$0.1079**, runs 597–703. Every gate met after one case grader was corrected (`just-do-it-still-asks`: "Nothing has been cancelled yet" matched "has been cancelled"; ADR-0038).
  - 544 Luna calls, 9 Sol calls, 3 embedding calls. The probe cost more than its ~$0.07 guess: multi-turn scheduling cases on cold caches.

- **S33 (2026-10-24): $0.3702 in 132 runs** (Phase 7 total: **$1.2697 of $1.55**; Phase 7 closed). The user raised the cap at the brief ($1.40, option A: pass^3 on every set a §2 pass^3 gate names) and again once one whole-suite run was measured from the cassettes at about $0.197 ($1.55; the brief had assumed about $0.11). `--phase-estimate-ok` allowed (user).
  - Probe of scheduling + ambiguity after the guide batch, 54 cases: **$0.0822**, runs 704–731. 53/54; the miss was `who-works-saturdays` (held out, left untuned).
  - pass^1 on failure, follow_through, memory_write and learned_rules, 48 cases: **$0.0216**, runs 732–757.
  - pass^3 on scheduling, memory_delete, memory_safety, memory_recall, episodic, safety, permissions and autonomy, 132 cases (scheduling's first trial from the probe): **$0.2661**, runs 758–832; one case re-run after an OpenAI 503 replayed free (833).
  - The new held-out case `in-three-days` (after the review): **$0.0004**, run 835 (834 failed before the database was ready, $0).
  - A typical member turn cost **$0.00085** on average (p95 $0.0014); the three moves that hand over to Sol after step 4 cost about $0.024 a turn.

## Ledger

<!-- ledger:start (written by the eval runner) -->
Total spent: **$2.1437** of $5.00 (the runner stops at $4.50).

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
| 308 | 2026-10-23 | P7 S31 pass^1 part 22/107 | completed | 2 × 1 | $0.42 | $0.0015 | $1.0887 |
| 309 | 2026-10-23 | P7 S31 pass^1 part 23/107 | completed | 2 × 1 | $0.42 | $0.0007 | $1.0894 |
| 310 | 2026-10-23 | P7 S31 pass^1 part 24/107 | completed | 2 × 1 | $0.42 | $0.0008 | $1.0903 |
| 311 | 2026-10-23 | P7 S31 pass^1 part 25/107 | completed | 2 × 1 | $0.42 | $0.0007 | $1.0910 |
| 312 | 2026-10-23 | P7 S31 pass^1 part 26/107 | completed | 2 × 1 | $0.42 | $0.0005 | $1.0914 |
| 313 | 2026-10-23 | P7 S31 pass^1 part 27/107 | completed | 2 × 1 | $0.42 | $0.0016 | $1.0930 |
| 314 | 2026-10-23 | P7 S31 pass^1 part 28/107 | completed | 2 × 1 | $0.42 | $0.0007 | $1.0938 |
| 315 | 2026-10-23 | P7 S31 pass^1 part 29/107 | completed | 2 × 1 | $0.42 | $0.0010 | $1.0947 |
| 316 | 2026-10-23 | P7 S31 pass^1 part 30/107 | completed | 2 × 1 | $0.42 | $0.0009 | $1.0956 |
| 317 | 2026-10-23 | P7 S31 pass^1 part 31/107 | completed | 1 × 1 | $0.48 | $0.0006 | $1.0962 |
| 318 | 2026-10-23 | P7 S31 pass^1 part 32/107 | completed | 2 × 1 | $0.42 | $0.0005 | $1.0968 |
| 319 | 2026-10-23 | P7 S31 pass^1 part 33/107 | completed | 2 × 1 | $0.42 | $0.0013 | $1.0980 |
| 320 | 2026-10-23 | P7 S31 pass^1 part 34/107 | completed | 2 × 1 | $0.42 | $0.0004 | $1.0985 |
| 321 | 2026-10-23 | P7 S31 pass^1 part 35/107 | completed | 2 × 1 | $0.42 | $0.0004 | $1.0989 |
| 322 | 2026-10-23 | P7 S31 pass^1 part 36/107 | completed | 2 × 1 | $0.42 | $0.0017 | $1.1006 |
| 323 | 2026-10-23 | P7 S31 pass^1 part 37/107 | completed | 1 × 1 | $0.21 | $0.0002 | $1.1009 |
| 324 | 2026-10-23 | P7 S31 pass^1 part 38/107 | completed | 1 × 1 | $0.48 | $0.0006 | $1.1014 |
| 325 | 2026-10-23 | P7 S31 pass^1 part 39/107 | completed | 1 × 1 | $0.48 | $0.0005 | $1.1020 |
| 326 | 2026-10-23 | P7 S31 pass^1 part 40/107 | completed | 1 × 1 | $0.48 | $0.0004 | $1.1024 |
| 327 | 2026-10-23 | P7 S31 pass^1 part 41/107 | completed | 1 × 1 | $0.48 | $0.0003 | $1.1027 |
| 328 | 2026-10-23 | P7 S31 pass^1 part 42/107 | completed | 1 × 1 | $0.48 | $0.0011 | $1.1038 |
| 329 | 2026-10-23 | P7 S31 pass^1 part 43/107 | completed | 1 × 1 | $0.48 | $0.0003 | $1.1042 |
| 330 | 2026-10-23 | P7 S31 pass^1 part 44/107 | completed | 1 × 1 | $0.21 | $0.0004 | $1.1045 |
| 331 | 2026-10-23 | P7 S31 pass^1 part 45/107 | completed | 1 × 1 | $0.48 | $0.0006 | $1.1051 |
| 332 | 2026-10-23 | P7 S31 pass^1 part 46/107 | completed | 1 × 1 | $0.21 | $0.0004 | $1.1055 |
| 333 | 2026-10-23 | P7 S31 pass^1 part 47/107 | completed | 1 × 1 | $0.48 | $0.0006 | $1.1061 |
| 334 | 2026-10-23 | P7 S31 pass^1 part 48/107 | completed | 2 × 1 | $0.42 | $0.0007 | $1.1068 |
| 335 | 2026-10-23 | P7 S31 pass^1 part 49/107 | completed | 2 × 1 | $0.42 | $0.0014 | $1.1082 |
| 336 | 2026-10-23 | P7 S31 pass^1 part 50/107 | completed | 2 × 1 | $0.42 | $0.0017 | $1.1099 |
| 337 | 2026-10-23 | P7 S31 pass^1 part 51/107 | completed | 2 × 1 | $0.42 | $0.0003 | $1.1102 |
| 338 | 2026-10-23 | P7 S31 pass^1 part 52/107 | completed | 2 × 1 | $0.42 | $0.0006 | $1.1108 |
| 339 | 2026-10-23 | P7 S31 pass^1 part 53/107 | completed | 2 × 1 | $0.42 | $0.0004 | $1.1112 |
| 340 | 2026-10-23 | P7 S31 pass^1 part 54/107 | completed | 2 × 1 | $0.42 | $0.0004 | $1.1116 |
| 341 | 2026-10-23 | P7 S31 pass^1 part 55/107 | completed | 1 × 1 | $0.21 | $0.0002 | $1.1118 |
| 342 | 2026-10-23 | P7 S31 pass^1 part 56/107 | completed | 1 × 1 | $0.48 | $0.0015 | $1.1133 |
| 343 | 2026-10-23 | P7 S31 pass^1 part 57/107 | completed | 2 × 1 | $0.42 | $0.0005 | $1.1138 |
| 344 | 2026-10-23 | P7 S31 pass^1 part 58/107 | completed | 2 × 1 | $0.42 | $0.0016 | $1.1154 |
| 345 | 2026-10-23 | P7 S31 pass^1 part 59/107 | completed | 2 × 1 | $0.42 | $0.0014 | $1.1168 |
| 346 | 2026-10-23 | P7 S31 pass^1 part 60/107 | completed | 2 × 1 | $0.42 | $0.0014 | $1.1182 |
| 347 | 2026-10-23 | P7 S31 pass^1 part 61/107 | completed | 1 × 1 | $0.48 | $0.0015 | $1.1197 |
| 348 | 2026-10-23 | P7 S31 pass^1 part 62/107 | completed | 1 × 1 | $0.48 | $0.0008 | $1.1205 |
| 349 | 2026-10-23 | P7 S31 pass^1 part 63/107 | completed | 2 × 1 | $0.42 | $0.0004 | $1.1209 |
| 350 | 2026-10-23 | P7 S31 pass^1 part 64/107 | completed | 2 × 1 | $0.42 | $0.0014 | $1.1223 |
| 351 | 2026-10-23 | P7 S31 pass^1 part 65/107 | completed | 2 × 1 | $0.42 | $0.0234 | $1.1457 |
| 352 | 2026-10-23 | P7 S31 pass^1 part 66/107 | completed | 2 × 1 | $0.42 | $0.0009 | $1.1465 |
| 353 | 2026-10-23 | P7 S31 pass^1 part 67/107 | completed | 2 × 1 | $0.42 | $0.0238 | $1.1704 |
| 354 | 2026-10-23 | P7 S31 pass^1 part 68/107 | completed | 2 × 1 | $0.42 | $0.0004 | $1.1708 |
| 355 | 2026-10-23 | P7 S31 pass^1 part 69/107 | completed | 2 × 1 | $0.42 | $0.0004 | $1.1712 |
| 356 | 2026-10-23 | P7 S31 pass^1 part 70/107 | completed | 2 × 1 | $0.42 | $0.0009 | $1.1721 |
| 357 | 2026-10-23 | P7 S31 pass^1 part 71/107 | completed | 2 × 1 | $0.42 | $0.0002 | $1.1724 |
| 358 | 2026-10-23 | P7 S31 pass^1 part 72/107 | completed | 2 × 1 | $0.42 | $0.0002 | $1.1726 |
| 359 | 2026-10-23 | P7 S31 pass^1 part 73/107 | completed | 2 × 1 | $0.42 | $0.0003 | $1.1729 |
| 360 | 2026-10-23 | P7 S31 pass^1 part 74/107 | completed | 2 × 1 | $0.42 | $0.0008 | $1.1737 |
| 361 | 2026-10-23 | P7 S31 pass^1 part 75/107 | completed | 2 × 1 | $0.42 | $0.0002 | $1.1739 |
| 362 | 2026-10-23 | P7 S31 pass^1 part 76/107 | completed | 1 × 1 | $0.21 | $0.0001 | $1.1741 |
| 363 | 2026-10-23 | P7 S31 pass^1 part 77/107 | completed | 1 × 1 | $0.48 | $0.0003 | $1.1744 |
| 364 | 2026-10-23 | P7 S31 pass^1 part 78/107 | completed | 2 × 1 | $0.42 | $0.0005 | $1.1749 |
| 365 | 2026-10-23 | P7 S31 pass^1 part 79/107 | completed | 2 × 1 | $0.42 | $0.0006 | $1.1755 |
| 366 | 2026-10-23 | P7 S31 pass^1 part 80/107 | completed | 2 × 1 | $0.42 | $0.0008 | $1.1762 |
| 367 | 2026-10-23 | P7 S31 pass^1 part 81/107 | completed | 2 × 1 | $0.42 | $0.0016 | $1.1778 |
| 368 | 2026-10-23 | P7 S31 pass^1 part 82/107 | completed | 2 × 1 | $0.42 | $0.0009 | $1.1787 |
| 369 | 2026-10-23 | P7 S31 pass^1 part 83/107 | completed | 2 × 1 | $0.42 | $0.0007 | $1.1794 |
| 370 | 2026-10-23 | P7 S31 pass^1 part 84/107 | completed | 2 × 1 | $0.42 | $0.0008 | $1.1802 |
| 371 | 2026-10-23 | P7 S31 pass^1 part 85/107 | completed | 2 × 1 | $0.42 | $0.0006 | $1.1808 |
| 372 | 2026-10-23 | P7 S31 pass^1 part 86/107 | completed | 2 × 1 | $0.42 | $0.0042 | $1.1851 |
| 373 | 2026-10-23 | P7 S31 pass^1 part 87/107 | completed | 2 × 1 | $0.42 | $0.0010 | $1.1861 |
| 374 | 2026-10-23 | P7 S31 pass^1 part 88/107 | completed | 2 × 1 | $0.42 | $0.0011 | $1.1871 |
| 375 | 2026-10-23 | P7 S31 pass^1 part 89/107 | completed | 2 × 1 | $0.42 | $0.0009 | $1.1881 |
| 376 | 2026-10-23 | P7 S31 pass^1 part 90/107 | completed | 2 × 1 | $0.42 | $0.0006 | $1.1887 |
| 377 | 2026-10-23 | P7 S31 pass^1 part 91/107 | completed | 2 × 1 | $0.42 | $0.0021 | $1.1908 |
| 378 | 2026-10-23 | P7 S31 pass^1 part 92/107 | completed | 2 × 1 | $0.42 | $0.0016 | $1.1924 |
| 379 | 2026-10-23 | P7 S31 pass^1 part 93/107 | completed | 2 × 1 | $0.42 | $0.0009 | $1.1933 |
| 380 | 2026-10-23 | P7 S31 pass^1 part 94/107 | completed | 2 × 1 | $0.42 | $0.0007 | $1.1940 |
| 381 | 2026-10-23 | P7 S31 pass^1 part 95/107 | completed | 2 × 1 | $0.42 | $0.0005 | $1.1945 |
| 382 | 2026-10-23 | P7 S31 pass^1 part 96/107 | completed | 2 × 1 | $0.42 | $0.0004 | $1.1949 |
| 383 | 2026-10-23 | P7 S31 pass^1 part 97/107 | completed | 2 × 1 | $0.42 | $0.0005 | $1.1955 |
| 384 | 2026-10-23 | P7 S31 pass^1 part 98/107 | completed | 2 × 1 | $0.42 | $0.0004 | $1.1958 |
| 385 | 2026-10-23 | P7 S31 pass^1 part 99/107 | completed | 2 × 1 | $0.42 | $0.0009 | $1.1968 |
| 386 | 2026-10-23 | P7 S31 pass^1 part 100/107 | completed | 2 × 1 | $0.42 | $0.0238 | $1.2206 |
| 387 | 2026-10-23 | P7 S31 pass^1 part 101/107 | completed | 2 × 1 | $0.42 | $0.0009 | $1.2215 |
| 388 | 2026-10-23 | P7 S31 pass^1 part 102/107 | completed | 2 × 1 | $0.42 | $0.0006 | $1.2221 |
| 389 | 2026-10-23 | P7 S31 pass^1 part 103/107 | completed | 2 × 1 | $0.42 | $0.0010 | $1.2231 |
| 390 | 2026-10-23 | P7 S31 pass^1 part 104/107 | completed | 2 × 1 | $0.42 | $0.0006 | $1.2236 |
| 391 | 2026-10-23 | P7 S31 pass^1 part 105/107 | completed | 2 × 1 | $0.42 | $0.0006 | $1.2243 |
| 392 | 2026-10-23 | P7 S31 pass^1 part 106/107 | completed | 2 × 1 | $0.42 | $0.0006 | $1.2249 |
| 393 | 2026-10-23 | P7 S31 pass^1 part 107/107 | completed | 2 × 1 | $0.42 | $0.0007 | $1.2256 |
| 394 | 2026-10-23 | P7 S31 re-record after guide fix, part 1/107 | completed | 1 × 1 | $0.21 | $0.0012 | $1.2268 |
| 395 | 2026-10-23 | P7 S31 re-record after guide fix, part 2/107 | completed | 1 × 1 | $0.48 | $0.0008 | $1.2276 |
| 396 | 2026-10-23 | P7 S31 re-record after guide fix, part 3/107 | completed | 2 × 1 | $0.42 | $0.0004 | $1.2280 |
| 397 | 2026-10-23 | P7 S31 re-record after guide fix, part 4/107 | completed | 2 × 1 | $0.42 | $0.0018 | $1.2298 |
| 398 | 2026-10-23 | P7 S31 re-record after guide fix, part 5/107 | completed | 2 × 1 | $0.42 | $0.0024 | $1.2322 |
| 399 | 2026-10-23 | P7 S31 re-record after guide fix, part 6/107 | completed | 2 × 1 | $0.42 | $0.0009 | $1.2330 |
| 400 | 2026-10-23 | P7 S31 re-record after guide fix, part 7/107 | completed | 2 × 1 | $0.42 | $0.0017 | $1.2347 |
| 401 | 2026-10-23 | P7 S31 re-record after guide fix, part 8/107 | completed | 2 × 1 | $0.42 | $0.0009 | $1.2356 |
| 402 | 2026-10-23 | P7 S31 re-record after guide fix, part 9/107 | completed | 1 × 1 | $0.21 | $0.0005 | $1.2361 |
| 403 | 2026-10-23 | P7 S31 re-record after guide fix, part 10/107 | completed | 1 × 1 | $0.48 | $0.0006 | $1.2366 |
| 404 | 2026-10-23 | P7 S31 re-record after guide fix, part 11/107 | completed | 2 × 1 | $0.42 | $0.0251 | $1.2618 |
| 405 | 2026-10-23 | P7 S31 re-record after guide fix, part 12/107 | completed | 2 × 1 | $0.42 | $0.0006 | $1.2623 |
| 406 | 2026-10-23 | P7 S31 re-record after guide fix, part 13/107 | completed | 2 × 1 | $0.43 | $0.0070 | $1.2693 |
| 407 | 2026-10-23 | P7 S31 re-record after guide fix, part 14/107 | completed | 2 × 1 | $0.42 | $0.0006 | $1.2699 |
| 408 | 2026-10-23 | P7 S31 re-record after guide fix, part 15/107 | completed | 2 × 1 | $0.42 | $0.0045 | $1.2745 |
| 409 | 2026-10-23 | P7 S31 re-record after guide fix, part 16/107 | completed | 2 × 1 | $0.42 | $0.0009 | $1.2754 |
| 410 | 2026-10-23 | P7 S31 re-record after guide fix, part 17/107 | completed | 2 × 1 | $0.42 | $0.0005 | $1.2759 |
| 411 | 2026-10-23 | P7 S31 re-record after guide fix, part 18/107 | completed | 2 × 1 | $0.42 | $0.0006 | $1.2765 |
| 412 | 2026-10-23 | P7 S31 re-record after guide fix, part 19/107 | completed | 2 × 1 | $0.42 | $0.0005 | $1.2770 |
| 413 | 2026-10-23 | P7 S31 re-record after guide fix, part 20/107 | completed | 2 × 1 | $0.42 | $0.0014 | $1.2784 |
| 414 | 2026-10-23 | P7 S31 re-record after guide fix, part 21/107 | completed | 2 × 1 | $0.43 | $0.0017 | $1.2801 |
| 415 | 2026-10-23 | P7 S31 re-record after guide fix, part 22/107 | completed | 2 × 1 | $0.42 | $0.0015 | $1.2816 |
| 416 | 2026-10-23 | P7 S31 re-record after guide fix, part 23/107 | completed | 2 × 1 | $0.42 | $0.0005 | $1.2821 |
| 417 | 2026-10-23 | P7 S31 re-record after guide fix, part 24/107 | completed | 2 × 1 | $0.43 | $0.0008 | $1.2829 |
| 418 | 2026-10-23 | P7 S31 re-record after guide fix, part 25/107 | completed | 2 × 1 | $0.43 | $0.0007 | $1.2837 |
| 419 | 2026-10-23 | P7 S31 re-record after guide fix, part 26/107 | completed | 2 × 1 | $0.42 | $0.0005 | $1.2842 |
| 420 | 2026-10-23 | P7 S31 re-record after guide fix, part 27/107 | completed | 2 × 1 | $0.42 | $0.0016 | $1.2858 |
| 421 | 2026-10-23 | P7 S31 re-record after guide fix, part 28/107 | completed | 2 × 1 | $0.43 | $0.0007 | $1.2865 |
| 422 | 2026-10-23 | P7 S31 re-record after guide fix, part 29/107 | completed | 2 × 1 | $0.43 | $0.0011 | $1.2876 |
| 423 | 2026-10-23 | P7 S31 re-record after guide fix, part 30/107 | completed | 2 × 1 | $0.43 | $0.0011 | $1.2887 |
| 424 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 1/123 | completed | 1 × 1 | $0.21 | $0.0003 | $1.2890 |
| 425 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 2/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.2892 |
| 426 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 3/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.2894 |
| 427 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 4/123 | completed | 1 × 1 | $0.21 | $0.0011 | $1.2905 |
| 428 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 5/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.2907 |
| 429 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 6/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.2909 |
| 430 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 7/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.2911 |
| 431 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 8/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.2914 |
| 432 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 9/123 | completed | 1 × 1 | $0.21 | $0.0006 | $1.2919 |
| 433 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 10/123 | completed | 1 × 1 | $0.21 | $0.0012 | $1.2931 |
| 434 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 11/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.2933 |
| 435 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 12/123 | completed | 1 × 1 | $0.21 | $0.0004 | $1.2937 |
| 436 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 13/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.2939 |
| 437 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 14/123 | completed | 1 × 1 | $0.21 | $0.0003 | $1.2942 |
| 438 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 15/123 | completed | 1 × 1 | $0.21 | $0.0004 | $1.2946 |
| 439 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 16/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.2948 |
| 440 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 17/123 | completed | 1 × 1 | $0.21 | $0.0012 | $1.2960 |
| 441 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 18/123 | completed | 1 × 1 | $0.21 | $0.0015 | $1.2975 |
| 442 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 19/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.2977 |
| 443 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 20/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.2979 |
| 444 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 21/123 | completed | 1 × 1 | $0.21 | $0.0001 | $1.2980 |
| 445 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 22/123 | completed | 1 × 1 | $0.21 | $0.0004 | $1.2984 |
| 446 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 23/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.2986 |
| 447 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 24/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.2988 |
| 448 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 25/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.2990 |
| 449 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 26/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.2992 |
| 450 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 27/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.2994 |
| 451 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 28/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.2997 |
| 452 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 29/123 | completed | 1 × 1 | $0.21 | $0.0003 | $1.2999 |
| 453 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 30/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3001 |
| 454 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 31/123 | completed | 1 × 1 | $0.21 | $0.0012 | $1.3013 |
| 455 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 32/123 | completed | 1 × 1 | $0.21 | $0.0004 | $1.3017 |
| 456 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 33/123 | completed | 1 × 1 | $0.21 | $0.0012 | $1.3029 |
| 457 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 34/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3031 |
| 458 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 35/123 | completed | 1 × 1 | $0.21 | $0.0004 | $1.3035 |
| 459 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 36/123 | completed | 1 × 1 | $0.21 | $0.0013 | $1.3048 |
| 460 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 37/123 | completed | 1 × 1 | $0.21 | $0.0001 | $1.3049 |
| 461 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 38/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3052 |
| 462 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 39/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3054 |
| 463 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 40/123 | completed | 1 × 1 | $0.21 | $0.0012 | $1.3066 |
| 464 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 41/123 | completed | 1 × 1 | $0.21 | $0.0234 | $1.3299 |
| 465 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 42/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3301 |
| 466 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 43/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3304 |
| 467 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 44/123 | completed | 1 × 1 | $0.21 | $0.0007 | $1.3310 |
| 468 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 45/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3313 |
| 469 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 46/123 | completed | 1 × 1 | $0.21 | $0.0261 | $1.3573 |
| 470 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 47/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3576 |
| 471 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 48/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3578 |
| 472 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 49/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3579 |
| 473 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 50/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3582 |
| 474 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 51/123 | completed | 1 × 1 | $0.21 | $0.0005 | $1.3587 |
| 475 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 52/123 | completed | 1 × 1 | $0.21 | $0.0005 | $1.3591 |
| 476 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 53/123 | completed | 1 × 1 | $0.21 | $0.0001 | $1.3592 |
| 477 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 54/123 | completed | 1 × 1 | $0.21 | $0.0001 | $1.3593 |
| 478 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 55/123 | completed | 1 × 1 | $0.21 | $0.0001 | $1.3594 |
| 479 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 56/123 | completed | 1 × 1 | $0.21 | $0.0001 | $1.3595 |
| 480 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 57/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3597 |
| 481 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 58/123 | completed | 1 × 1 | $0.21 | $0.0001 | $1.3599 |
| 482 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 59/123 | completed | 1 × 1 | $0.21 | $0.0001 | $1.3600 |
| 483 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 60/123 | completed | 1 × 1 | $0.21 | $0.0007 | $1.3607 |
| 484 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 61/123 | completed | 1 × 1 | $0.21 | $0.0001 | $1.3608 |
| 485 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 62/123 | completed | 1 × 1 | $0.21 | $0.0001 | $1.3609 |
| 486 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 63/123 | completed | 1 × 1 | $0.21 | $0.0001 | $1.3610 |
| 487 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 64/123 | completed | 1 × 1 | $0.21 | $0.0003 | $1.3613 |
| 488 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 65/123 | completed | 1 × 1 | $0.21 | $0.0004 | $1.3616 |
| 489 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 66/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3619 |
| 490 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 67/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3621 |
| 491 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 68/123 | completed | 1 × 1 | $0.21 | $0.0005 | $1.3625 |
| 492 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 69/123 | completed | 1 × 1 | $0.21 | $0.0003 | $1.3629 |
| 493 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 70/123 | completed | 1 × 1 | $0.21 | $0.0011 | $1.3639 |
| 494 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 71/123 | completed | 1 × 1 | $0.21 | $0.0005 | $1.3644 |
| 495 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 72/123 | completed | 1 × 1 | $0.21 | $0.0005 | $1.3650 |
| 496 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 73/123 | completed | 1 × 1 | $0.21 | $0.0005 | $1.3654 |
| 497 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 74/123 | completed | 1 × 1 | $0.21 | $0.0005 | $1.3659 |
| 498 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 75/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3662 |
| 499 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 76/123 | completed | 1 × 1 | $0.21 | $0.0004 | $1.3666 |
| 500 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 77/123 | completed | 1 × 1 | $0.21 | $0.0003 | $1.3670 |
| 501 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 78/123 | completed | 1 × 1 | $0.21 | $0.0005 | $1.3674 |
| 502 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 79/123 | completed | 1 × 1 | $0.21 | $0.0004 | $1.3678 |
| 503 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 80/123 | completed | 1 × 1 | $0.21 | $0.0036 | $1.3714 |
| 504 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 81/123 | completed | 1 × 1 | $0.21 | $0.0005 | $1.3719 |
| 505 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 82/123 | completed | 1 × 1 | $0.21 | $0.0007 | $1.3726 |
| 506 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 83/123 | completed | 1 × 1 | $0.21 | $0.0003 | $1.3729 |
| 507 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 84/123 | completed | 1 × 1 | $0.21 | $0.0006 | $1.3736 |
| 508 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 85/123 | completed | 1 × 1 | $0.21 | $0.0004 | $1.3740 |
| 509 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 86/123 | completed | 1 × 1 | $0.21 | $0.0006 | $1.3746 |
| 510 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 87/123 | completed | 1 × 1 | $0.21 | $0.0005 | $1.3751 |
| 511 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 88/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3753 |
| 512 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 89/123 | completed | 1 × 1 | $0.21 | $0.0004 | $1.3757 |
| 513 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 90/123 | completed | 1 × 1 | $0.21 | $0.0006 | $1.3764 |
| 514 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 91/123 | completed | 1 × 1 | $0.21 | $0.0014 | $1.3778 |
| 515 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 92/123 | completed | 1 × 1 | $0.21 | $0.0012 | $1.3790 |
| 516 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 93/123 | completed | 1 × 1 | $0.21 | $0.0005 | $1.3795 |
| 517 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 94/123 | completed | 1 × 1 | $0.21 | $0.0004 | $1.3799 |
| 518 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 95/123 | completed | 1 × 1 | $0.21 | $0.0005 | $1.3804 |
| 519 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 96/123 | completed | 1 × 1 | $0.21 | $0.0003 | $1.3807 |
| 520 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 97/123 | completed | 1 × 1 | $0.21 | $0.0003 | $1.3810 |
| 521 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 98/123 | completed | 1 × 1 | $0.21 | $0.0003 | $1.3814 |
| 522 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 99/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3816 |
| 523 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 100/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3818 |
| 524 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 101/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3820 |
| 525 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 102/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3822 |
| 526 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 103/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3824 |
| 527 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 104/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3826 |
| 528 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 105/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.3828 |
| 529 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 106/123 | completed | 1 × 1 | $0.21 | $0.0004 | $1.3832 |
| 530 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 107/123 | completed | 1 × 1 | $0.21 | $0.0005 | $1.3837 |
| 531 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 108/123 | completed | 1 × 1 | $0.21 | $0.0005 | $1.3842 |
| 532 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 109/123 | completed | 1 × 1 | $0.21 | $0.0234 | $1.4076 |
| 533 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 110/123 | completed | 1 × 1 | $0.21 | $0.0005 | $1.4081 |
| 534 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 111/123 | completed | 1 × 1 | $0.21 | $0.0005 | $1.4086 |
| 535 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 112/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.4088 |
| 536 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 113/123 | completed | 1 × 1 | $0.21 | $0.0003 | $1.4091 |
| 537 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 114/123 | completed | 1 × 1 | $0.21 | $0.0005 | $1.4096 |
| 538 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 115/123 | completed | 1 × 1 | $0.21 | $0.0005 | $1.4102 |
| 539 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 116/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.4104 |
| 540 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 117/123 | completed | 1 × 1 | $0.21 | $0.0004 | $1.4107 |
| 541 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 118/123 | completed | 1 × 1 | $0.21 | $0.0003 | $1.4110 |
| 542 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 119/123 | completed | 1 × 1 | $0.21 | $0.0003 | $1.4114 |
| 543 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 120/123 | completed | 1 × 1 | $0.21 | $0.0003 | $1.4117 |
| 544 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 121/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.4119 |
| 545 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 122/123 | completed | 1 × 1 | $0.21 | $0.0005 | $1.4124 |
| 546 | 2026-10-23 | P7 S31 re-record after guide fix (rest), part 123/123 | completed | 1 × 1 | $0.21 | $0.0002 | $1.4126 |
| 547 | 2026-10-23 | P7 S31 re-record after guide fix (multi-turn), part 1/13 | completed | 1 × 1 | $0.48 | $0.0007 | $1.4132 |
| 548 | 2026-10-23 | P7 S31 re-record after guide fix (multi-turn), part 2/13 | completed | 1 × 1 | $0.48 | $0.0005 | $1.4137 |
| 549 | 2026-10-23 | P7 S31 re-record after guide fix (multi-turn), part 3/13 | completed | 1 × 1 | $0.48 | $0.0005 | $1.4143 |
| 550 | 2026-10-23 | P7 S31 re-record after guide fix (multi-turn), part 4/13 | completed | 1 × 1 | $0.48 | $0.0006 | $1.4149 |
| 551 | 2026-10-23 | P7 S31 re-record after guide fix (multi-turn), part 5/13 | completed | 1 × 1 | $0.48 | $0.0003 | $1.4152 |
| 552 | 2026-10-23 | P7 S31 re-record after guide fix (multi-turn), part 6/13 | completed | 1 × 1 | $0.48 | $0.0011 | $1.4164 |
| 553 | 2026-10-23 | P7 S31 re-record after guide fix (multi-turn), part 7/13 | completed | 1 × 1 | $0.48 | $0.0004 | $1.4167 |
| 554 | 2026-10-23 | P7 S31 re-record after guide fix (multi-turn), part 8/13 | completed | 1 × 1 | $0.48 | $0.0006 | $1.4174 |
| 555 | 2026-10-23 | P7 S31 re-record after guide fix (multi-turn), part 9/13 | completed | 1 × 1 | $0.48 | $0.0006 | $1.4179 |
| 556 | 2026-10-23 | P7 S31 re-record after guide fix (multi-turn), part 10/13 | completed | 1 × 1 | $0.48 | $0.0015 | $1.4194 |
| 557 | 2026-10-23 | P7 S31 re-record after guide fix (multi-turn), part 11/13 | completed | 1 × 1 | $0.48 | $0.0019 | $1.4213 |
| 558 | 2026-10-23 | P7 S31 re-record after guide fix (multi-turn), part 12/13 | completed | 1 × 1 | $0.48 | $0.0007 | $1.4220 |
| 559 | 2026-10-23 | P7 S31 re-record after guide fix (multi-turn), part 13/13 | completed | 1 × 1 | $0.48 | $0.0003 | $1.4223 |
| 560 | 2026-10-23 | P7 S31 propose_rule closed:null fix | completed | 2 × 1 | $0.42 | $0.0002 | $1.4225 |
| 561 | 2026-10-23 | P7 S32b probe part 1/36 | completed | 2 × 1 | $0.43 | $0.0016 | $1.4241 |
| 562 | 2026-10-23 | P7 S32b probe part 2/36 | completed | 2 × 1 | $0.43 | $0.0006 | $1.4247 |
| 563 | 2026-10-23 | P7 S32b probe part 3/36 | completed | 2 × 1 | $0.43 | $0.0010 | $1.4257 |
| 564 | 2026-10-23 | P7 S32b probe part 4/36 | completed | 2 × 1 | $0.43 | $0.0004 | $1.4261 |
| 565 | 2026-10-23 | P7 S32b probe part 5/36 | completed | 2 × 1 | $0.43 | $0.0007 | $1.4268 |
| 566 | 2026-10-23 | P7 S32b probe part 6/36 | completed | 2 × 1 | $0.43 | $0.0016 | $1.4284 |
| 567 | 2026-10-23 | P7 S32b probe part 7/36 | completed | 2 × 1 | $0.43 | $0.0017 | $1.4301 |
| 568 | 2026-10-23 | P7 S32b probe part 8/36 | completed | 2 × 1 | $0.43 | $0.0016 | $1.4317 |
| 569 | 2026-10-23 | P7 S32b probe part 9/36 | completed | 2 × 1 | $0.43 | $0.0006 | $1.4323 |
| 570 | 2026-10-23 | P7 S32b probe part 10/36 | completed | 1 × 1 | $0.21 | $0.0013 | $1.4336 |
| 571 | 2026-10-23 | P7 S32b probe part 11/36 | completed | 1 × 1 | $0.48 | $0.0018 | $1.4354 |
| 572 | 2026-10-23 | P7 S32b probe part 12/36 | completed | 1 × 1 | $0.48 | $0.0007 | $1.4362 |
| 573 | 2026-10-23 | P7 S32b probe part 13/36 | completed | 2 × 1 | $0.43 | $0.0015 | $1.4377 |
| 574 | 2026-10-23 | P7 S32b probe part 14/36 | completed | 2 × 1 | $0.43 | $0.0010 | $1.4387 |
| 575 | 2026-10-23 | P7 S32b probe part 15/36 | completed | 2 × 1 | $0.43 | $0.0017 | $1.4404 |
| 576 | 2026-10-23 | P7 S32b probe part 16/36 | completed | 2 × 1 | $0.43 | $0.0008 | $1.4411 |
| 577 | 2026-10-23 | P7 S32b probe part 17/36 | completed | 2 × 1 | $0.43 | $0.0006 | $1.4417 |
| 578 | 2026-10-23 | P7 S32b probe part 18/36 | completed | 2 × 1 | $0.43 | $0.0250 | $1.4667 |
| 579 | 2026-10-23 | P7 S32b probe part 19/36 | completed | 2 × 1 | $0.43 | $0.0010 | $1.4677 |
| 580 | 2026-10-23 | P7 S32b probe part 20/36 | completed | 2 × 1 | $0.43 | $0.0012 | $1.4689 |
| 581 | 2026-10-23 | P7 S32b probe part 21/36 | completed | 2 × 1 | $0.43 | $0.0050 | $1.4739 |
| 582 | 2026-10-23 | P7 S32b probe part 22/36 | completed | 2 × 1 | $0.43 | $0.0007 | $1.4746 |
| 583 | 2026-10-23 | P7 S32b probe part 23/36 | completed | 2 × 1 | $0.43 | $0.0252 | $1.4998 |
| 584 | 2026-10-23 | P7 S32b probe part 24/36 | completed | 2 × 1 | $0.43 | $0.0026 | $1.5024 |
| 585 | 2026-10-23 | P7 S32b probe part 25/36 | completed | 2 × 1 | $0.43 | $0.0010 | $1.5034 |
| 586 | 2026-10-23 | P7 S32b probe part 26/36 | completed | 2 × 1 | $0.43 | $0.0007 | $1.5040 |
| 587 | 2026-10-23 | P7 S32b probe part 27/36 | completed | 2 × 1 | $0.43 | $0.0005 | $1.5045 |
| 588 | 2026-10-23 | P7 S32b probe part 28/36 | completed | 2 × 1 | $0.43 | $0.0006 | $1.5051 |
| 589 | 2026-10-23 | P7 S32b probe part 29/36 | completed | 2 × 1 | $0.43 | $0.0007 | $1.5058 |
| 590 | 2026-10-23 | P7 S32b probe part 30/36 | completed | 2 × 1 | $0.43 | $0.0009 | $1.5067 |
| 591 | 2026-10-23 | P7 S32b probe part 31/36 | completed | 2 × 1 | $0.43 | $0.0241 | $1.5308 |
| 592 | 2026-10-23 | P7 S32b probe part 32/36 | completed | 2 × 1 | $0.43 | $0.0007 | $1.5315 |
| 593 | 2026-10-23 | P7 S32b probe part 33/36 | completed | 2 × 1 | $0.43 | $0.0009 | $1.5324 |
| 594 | 2026-10-23 | P7 S32b probe part 34/36 | completed | 2 × 1 | $0.43 | $0.0008 | $1.5332 |
| 595 | 2026-10-23 | P7 S32b probe part 35/36 | completed | 2 × 1 | $0.43 | $0.0007 | $1.5339 |
| 596 | 2026-10-23 | P7 S32b probe part 36/36 | completed | 1 × 1 | $0.21 | $0.0002 | $1.5341 |
| 597 | 2026-10-23 | P7 S32b pass^1 part 1/107 | completed | 1 × 1 | $0.21 | $0.0003 | $1.5344 |
| 598 | 2026-10-23 | P7 S32b pass^1 part 2/107 | completed | 1 × 1 | $0.48 | $0.0006 | $1.5351 |
| 599 | 2026-10-23 | P7 S32b pass^1 part 3/107 | completed | 2 × 1 | $0.43 | $0.0003 | $1.5354 |
| 600 | 2026-10-23 | P7 S32b pass^1 part 4/107 | completed | 2 × 1 | $0.43 | $0.0019 | $1.5373 |
| 601 | 2026-10-23 | P7 S32b pass^1 part 5/107 | completed | 2 × 1 | $0.43 | $0.0024 | $1.5397 |
| 602 | 2026-10-23 | P7 S32b pass^1 part 6/107 | completed | 2 × 1 | $0.43 | $0.0009 | $1.5405 |
| 603 | 2026-10-23 | P7 S32b pass^1 part 7/107 | completed | 2 × 1 | $0.43 | $0.0017 | $1.5422 |
| 604 | 2026-10-23 | P7 S32b pass^1 part 8/107 | completed | 2 × 1 | $0.43 | $0.0011 | $1.5434 |
| 605 | 2026-10-23 | P7 S32b pass^1 part 9/107 | completed | 1 × 1 | $0.21 | $0.0005 | $1.5438 |
| 606 | 2026-10-23 | P7 S32b pass^1 part 10/107 | completed | 1 × 1 | $0.48 | $0.0006 | $1.5444 |
| 607 | 2026-10-23 | P7 S32b pass^1 part 11/107 | completed | 2 × 1 | $0.43 | $0.0045 | $1.5489 |
| 608 | 2026-10-23 | P7 S32b pass^1 part 12/107 | completed | 2 × 1 | $0.43 | $0.0006 | $1.5495 |
| 609 | 2026-10-23 | P7 S32b pass^1 part 13/107 | completed | 2 × 1 | $0.43 | $0.0011 | $1.5505 |
| 610 | 2026-10-23 | P7 S32b pass^1 part 14/107 | completed | 2 × 1 | $0.43 | $0.0006 | $1.5511 |
| 611 | 2026-10-23 | P7 S32b pass^1 part 15/107 | completed | 2 × 1 | $0.43 | $0.0009 | $1.5520 |
| 612 | 2026-10-23 | P7 S32b pass^1 part 16/107 | completed | 2 × 1 | $0.43 | $0.0009 | $1.5529 |
| 613 | 2026-10-23 | P7 S32b pass^1 part 17/107 | completed | 2 × 1 | $0.43 | $0.0005 | $1.5534 |
| 614 | 2026-10-23 | P7 S32b pass^1 part 18/107 | completed | 2 × 1 | $0.43 | $0.0006 | $1.5540 |
| 615 | 2026-10-23 | P7 S32b pass^1 part 19/107 | completed | 2 × 1 | $0.43 | $0.0005 | $1.5545 |
| 616 | 2026-10-23 | P7 S32b pass^1 part 20/107 | completed | 2 × 1 | $0.43 | $0.0004 | $1.5550 |
| 617 | 2026-10-23 | P7 S32b pass^1 part 21/107 | completed | 2 × 1 | $0.43 | $0.0008 | $1.5557 |
| 618 | 2026-10-23 | P7 S32b pass^1 part 22/107 | completed | 2 × 1 | $0.43 | $0.0002 | $1.5559 |
| 619 | 2026-10-23 | P7 S32b pass^1 part 23/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.5559 |
| 620 | 2026-10-23 | P7 S32b pass^1 part 24/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.5559 |
| 621 | 2026-10-23 | P7 S32b pass^1 part 25/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.5559 |
| 622 | 2026-10-23 | P7 S32b pass^1 part 26/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.5559 |
| 623 | 2026-10-23 | P7 S32b pass^1 part 27/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.5559 |
| 624 | 2026-10-23 | P7 S32b pass^1 part 28/107 | completed | 2 × 1 | $0.43 | $0.0004 | $1.5563 |
| 625 | 2026-10-23 | P7 S32b pass^1 part 29/107 | completed | 2 × 1 | $0.43 | $0.0005 | $1.5569 |
| 626 | 2026-10-23 | P7 S32b pass^1 part 30/107 | completed | 2 × 1 | $0.43 | $0.0009 | $1.5578 |
| 627 | 2026-10-23 | P7 S32b pass^1 part 31/107 | completed | 1 × 1 | $0.48 | $0.0007 | $1.5584 |
| 628 | 2026-10-23 | P7 S32b pass^1 part 32/107 | completed | 2 × 1 | $0.43 | $0.0005 | $1.5590 |
| 629 | 2026-10-23 | P7 S32b pass^1 part 33/107 | completed | 2 × 1 | $0.43 | $0.0013 | $1.5602 |
| 630 | 2026-10-23 | P7 S32b pass^1 part 34/107 | completed | 2 × 1 | $0.43 | $0.0004 | $1.5607 |
| 631 | 2026-10-23 | P7 S32b pass^1 part 35/107 | completed | 2 × 1 | $0.43 | $0.0004 | $1.5611 |
| 632 | 2026-10-23 | P7 S32b pass^1 part 36/107 | completed | 2 × 1 | $0.43 | $0.0263 | $1.5874 |
| 633 | 2026-10-23 | P7 S32b pass^1 part 37/107 | completed | 1 × 1 | $0.21 | $0.0003 | $1.5876 |
| 634 | 2026-10-23 | P7 S32b pass^1 part 38/107 | completed | 1 × 1 | $0.48 | $0.0006 | $1.5882 |
| 635 | 2026-10-23 | P7 S32b pass^1 part 39/107 | completed | 1 × 1 | $0.48 | $0.0005 | $1.5887 |
| 636 | 2026-10-23 | P7 S32b pass^1 part 40/107 | completed | 1 × 1 | $0.48 | $0.0006 | $1.5893 |
| 637 | 2026-10-23 | P7 S32b pass^1 part 41/107 | completed | 1 × 1 | $0.48 | $0.0005 | $1.5898 |
| 638 | 2026-10-23 | P7 S32b pass^1 part 42/107 | completed | 1 × 1 | $0.48 | $0.0012 | $1.5909 |
| 639 | 2026-10-23 | P7 S32b pass^1 part 43/107 | completed | 1 × 1 | $0.48 | $0.0004 | $1.5913 |
| 640 | 2026-10-23 | P7 S32b pass^1 part 44/107 | completed | 1 × 1 | $0.21 | $0.0005 | $1.5918 |
| 641 | 2026-10-23 | P7 S32b pass^1 part 45/107 | completed | 1 × 1 | $0.48 | $0.0007 | $1.5925 |
| 642 | 2026-10-23 | P7 S32b pass^1 part 46/107 | completed | 1 × 1 | $0.21 | $0.0002 | $1.5927 |
| 643 | 2026-10-23 | P7 S32b pass^1 part 47/107 | completed | 1 × 1 | $0.48 | $0.0006 | $1.5933 |
| 644 | 2026-10-23 | P7 S32b pass^1 part 48/107 | completed | 2 × 1 | $0.43 | $0.0007 | $1.5940 |
| 645 | 2026-10-23 | P7 S32b pass^1 part 49/107 | completed | 2 × 1 | $0.43 | $0.0014 | $1.5954 |
| 646 | 2026-10-23 | P7 S32b pass^1 part 50/107 | completed | 2 × 1 | $0.43 | $0.0017 | $1.5971 |
| 647 | 2026-10-23 | P7 S32b pass^1 part 51/107 | completed | 2 × 1 | $0.43 | $0.0003 | $1.5975 |
| 648 | 2026-10-23 | P7 S32b pass^1 part 52/107 | completed | 2 × 1 | $0.43 | $0.0006 | $1.5980 |
| 649 | 2026-10-23 | P7 S32b pass^1 part 53/107 | completed | 2 × 1 | $0.43 | $0.0004 | $1.5985 |
| 650 | 2026-10-23 | P7 S32b pass^1 part 54/107 | completed | 2 × 1 | $0.43 | $0.0004 | $1.5989 |
| 651 | 2026-10-23 | P7 S32b pass^1 part 55/107 | completed | 1 × 1 | $0.21 | $0.0002 | $1.5991 |
| 652 | 2026-10-23 | P7 S32b pass^1 part 56/107 | completed | 1 × 1 | $0.48 | $0.0015 | $1.6006 |
| 653 | 2026-10-23 | P7 S32b pass^1 part 57/107 | completed | 2 × 1 | $0.43 | $0.0005 | $1.6011 |
| 654 | 2026-10-23 | P7 S32b pass^1 part 58/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6011 |
| 655 | 2026-10-23 | P7 S32b pass^1 part 59/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6011 |
| 656 | 2026-10-23 | P7 S32b pass^1 part 60/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6011 |
| 657 | 2026-10-23 | P7 S32b pass^1 part 61/107 | completed | 1 × 1 | $0.48 | $0.0000 | $1.6011 |
| 658 | 2026-10-23 | P7 S32b pass^1 part 62/107 | completed | 1 × 1 | $0.48 | $0.0000 | $1.6011 |
| 659 | 2026-10-23 | P7 S32b pass^1 part 63/107 | completed | 2 × 1 | $0.43 | $0.0002 | $1.6013 |
| 660 | 2026-10-23 | P7 S32b pass^1 part 64/107 | completed | 2 × 1 | $0.43 | $0.0014 | $1.6027 |
| 661 | 2026-10-23 | P7 S32b pass^1 part 65/107 | completed | 2 × 1 | $0.43 | $0.0039 | $1.6066 |
| 662 | 2026-10-23 | P7 S32b pass^1 part 66/107 | completed | 2 × 1 | $0.43 | $0.0007 | $1.6073 |
| 663 | 2026-10-23 | P7 S32b pass^1 part 67/107 | completed | 2 × 1 | $0.43 | $0.0262 | $1.6335 |
| 664 | 2026-10-23 | P7 S32b pass^1 part 68/107 | completed | 2 × 1 | $0.43 | $0.0004 | $1.6339 |
| 665 | 2026-10-23 | P7 S32b pass^1 part 69/107 | completed | 2 × 1 | $0.43 | $0.0004 | $1.6344 |
| 666 | 2026-10-23 | P7 S32b pass^1 part 70/107 | completed | 2 × 1 | $0.43 | $0.0010 | $1.6353 |
| 667 | 2026-10-23 | P7 S32b pass^1 part 71/107 | completed | 2 × 1 | $0.43 | $0.0002 | $1.6355 |
| 668 | 2026-10-23 | P7 S32b pass^1 part 72/107 | completed | 2 × 1 | $0.43 | $0.0002 | $1.6357 |
| 669 | 2026-10-23 | P7 S32b pass^1 part 73/107 | completed | 2 × 1 | $0.43 | $0.0003 | $1.6361 |
| 670 | 2026-10-23 | P7 S32b pass^1 part 74/107 | completed | 2 × 1 | $0.43 | $0.0008 | $1.6369 |
| 671 | 2026-10-23 | P7 S32b pass^1 part 75/107 | completed | 2 × 1 | $0.43 | $0.0002 | $1.6371 |
| 672 | 2026-10-23 | P7 S32b pass^1 part 76/107 | completed | 1 × 1 | $0.21 | $0.0001 | $1.6372 |
| 673 | 2026-10-23 | P7 S32b pass^1 part 77/107 | completed | 1 × 1 | $0.48 | $0.0003 | $1.6375 |
| 674 | 2026-10-23 | P7 S32b pass^1 part 78/107 | completed | 2 × 1 | $0.43 | $0.0005 | $1.6380 |
| 675 | 2026-10-23 | P7 S32b pass^1 part 79/107 | completed | 2 × 1 | $0.43 | $0.0004 | $1.6384 |
| 676 | 2026-10-23 | P7 S32b pass^1 part 80/107 | completed | 2 × 1 | $0.43 | $0.0007 | $1.6391 |
| 677 | 2026-10-23 | P7 S32b pass^1 part 81/107 | completed | 2 × 1 | $0.43 | $0.0011 | $1.6402 |
| 678 | 2026-10-23 | P7 S32b pass^1 part 82/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6402 |
| 679 | 2026-10-23 | P7 S32b pass^1 part 83/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6402 |
| 680 | 2026-10-23 | P7 S32b pass^1 part 84/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6402 |
| 681 | 2026-10-23 | P7 S32b pass^1 part 85/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6402 |
| 682 | 2026-10-23 | P7 S32b pass^1 part 86/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6402 |
| 683 | 2026-10-23 | P7 S32b pass^1 part 87/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6402 |
| 684 | 2026-10-23 | P7 S32b pass^1 part 88/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6402 |
| 685 | 2026-10-23 | P7 S32b pass^1 part 89/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6402 |
| 686 | 2026-10-23 | P7 S32b pass^1 part 90/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6402 |
| 687 | 2026-10-23 | P7 S32b pass^1 part 91/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6402 |
| 688 | 2026-10-23 | P7 S32b pass^1 part 92/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6402 |
| 689 | 2026-10-23 | P7 S32b pass^1 part 93/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6402 |
| 690 | 2026-10-23 | P7 S32b pass^1 part 94/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6402 |
| 691 | 2026-10-23 | P7 S32b pass^1 part 95/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6402 |
| 692 | 2026-10-23 | P7 S32b pass^1 part 96/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6402 |
| 693 | 2026-10-24 | P7 S32b pass^1 part 97/107 | completed | 2 × 1 | $0.43 | $0.0002 | $1.6404 |
| 694 | 2026-10-24 | P7 S32b pass^1 part 98/107 | completed | 2 × 1 | $0.43 | $0.0004 | $1.6408 |
| 695 | 2026-10-24 | P7 S32b pass^1 part 99/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6408 |
| 696 | 2026-10-24 | P7 S32b pass^1 part 100/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6408 |
| 697 | 2026-10-24 | P7 S32b pass^1 part 101/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6408 |
| 698 | 2026-10-24 | P7 S32b pass^1 part 102/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6408 |
| 699 | 2026-10-24 | P7 S32b pass^1 part 103/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6408 |
| 700 | 2026-10-24 | P7 S32b pass^1 part 104/107 | completed | 2 × 1 | $0.43 | $0.0006 | $1.6413 |
| 701 | 2026-10-24 | P7 S32b pass^1 part 105/107 | completed | 2 × 1 | $0.43 | $0.0006 | $1.6420 |
| 702 | 2026-10-24 | P7 S32b pass^1 part 106/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6420 |
| 703 | 2026-10-24 | P7 S32b pass^1 part 107/107 | completed | 2 × 1 | $0.43 | $0.0000 | $1.6420 |
| 704 | 2026-10-24 | P7 S33 probe part 1/28 | completed | 1 × 1 | $0.21 | $0.0013 | $1.6433 |
| 705 | 2026-10-24 | P7 S33 probe part 2/28 | completed | 1 × 1 | $0.48 | $0.0006 | $1.6439 |
| 706 | 2026-10-24 | P7 S33 probe part 3/28 | completed | 2 × 1 | $0.43 | $0.0004 | $1.6442 |
| 707 | 2026-10-24 | P7 S33 probe part 4/28 | completed | 2 × 1 | $0.43 | $0.0017 | $1.6460 |
| 708 | 2026-10-24 | P7 S33 probe part 5/28 | completed | 2 × 1 | $0.43 | $0.0024 | $1.6484 |
| 709 | 2026-10-24 | P7 S33 probe part 6/28 | completed | 2 × 1 | $0.43 | $0.0009 | $1.6492 |
| 710 | 2026-10-24 | P7 S33 probe part 7/28 | completed | 2 × 1 | $0.43 | $0.0016 | $1.6508 |
| 711 | 2026-10-24 | P7 S33 probe part 8/28 | completed | 2 × 1 | $0.43 | $0.0010 | $1.6518 |
| 712 | 2026-10-24 | P7 S33 probe part 9/28 | completed | 2 × 1 | $0.43 | $0.0010 | $1.6528 |
| 713 | 2026-10-24 | P7 S33 probe part 10/28 | completed | 2 × 1 | $0.43 | $0.0017 | $1.6544 |
| 714 | 2026-10-24 | P7 S33 probe part 11/28 | completed | 2 × 1 | $0.43 | $0.0006 | $1.6550 |
| 715 | 2026-10-24 | P7 S33 probe part 12/28 | completed | 2 × 1 | $0.43 | $0.0240 | $1.6790 |
| 716 | 2026-10-24 | P7 S33 probe part 13/28 | completed | 2 × 1 | $0.43 | $0.0022 | $1.6812 |
| 717 | 2026-10-24 | P7 S33 probe part 14/28 | completed | 2 × 1 | $0.43 | $0.0010 | $1.6822 |
| 718 | 2026-10-24 | P7 S33 probe part 15/28 | completed | 2 × 1 | $0.43 | $0.0010 | $1.6832 |
| 719 | 2026-10-24 | P7 S33 probe part 16/28 | completed | 2 × 1 | $0.43 | $0.0009 | $1.6840 |
| 720 | 2026-10-24 | P7 S33 probe part 17/28 | completed | 2 × 1 | $0.43 | $0.0056 | $1.6896 |
| 721 | 2026-10-24 | P7 S33 probe part 18/28 | completed | 2 × 1 | $0.43 | $0.0027 | $1.6923 |
| 722 | 2026-10-24 | P7 S33 probe part 19/28 | completed | 2 × 1 | $0.43 | $0.0018 | $1.6941 |
| 723 | 2026-10-24 | P7 S33 probe part 20/28 | completed | 2 × 1 | $0.43 | $0.0008 | $1.6949 |
| 724 | 2026-10-24 | P7 S33 probe part 21/28 | completed | 2 × 1 | $0.43 | $0.0007 | $1.6955 |
| 725 | 2026-10-24 | P7 S33 probe part 22/28 | completed | 2 × 1 | $0.43 | $0.0005 | $1.6961 |
| 726 | 2026-10-24 | P7 S33 probe part 23/28 | completed | 2 × 1 | $0.43 | $0.0005 | $1.6965 |
| 727 | 2026-10-24 | P7 S33 probe part 24/28 | completed | 2 × 1 | $0.43 | $0.0009 | $1.6974 |
| 728 | 2026-10-24 | P7 S33 probe part 25/28 | completed | 2 × 1 | $0.43 | $0.0242 | $1.7216 |
| 729 | 2026-10-24 | P7 S33 probe part 26/28 | completed | 2 × 1 | $0.43 | $0.0010 | $1.7226 |
| 730 | 2026-10-24 | P7 S33 probe part 27/28 | completed | 2 × 1 | $0.43 | $0.0006 | $1.7231 |
| 731 | 2026-10-24 | P7 S33 probe part 28/28 | completed | 2 × 1 | $0.43 | $0.0010 | $1.7242 |
| 732 | 2026-10-24 | P7 S33 pass^1 part 1/26 | completed | 2 × 1 | $0.43 | $0.0006 | $1.7248 |
| 733 | 2026-10-24 | P7 S33 pass^1 part 2/26 | completed | 2 × 1 | $0.43 | $0.0009 | $1.7256 |
| 734 | 2026-10-24 | P7 S33 pass^1 part 3/26 | completed | 2 × 1 | $0.43 | $0.0009 | $1.7265 |
| 735 | 2026-10-24 | P7 S33 pass^1 part 4/26 | completed | 2 × 1 | $0.43 | $0.0005 | $1.7270 |
| 736 | 2026-10-24 | P7 S33 pass^1 part 5/26 | completed | 2 × 1 | $0.43 | $0.0006 | $1.7276 |
| 737 | 2026-10-24 | P7 S33 pass^1 part 6/26 | completed | 2 × 1 | $0.43 | $0.0005 | $1.7281 |
| 738 | 2026-10-24 | P7 S33 pass^1 part 7/26 | completed | 2 × 1 | $0.43 | $0.0004 | $1.7286 |
| 739 | 2026-10-24 | P7 S33 pass^1 part 8/26 | completed | 2 × 1 | $0.43 | $0.0008 | $1.7293 |
| 740 | 2026-10-24 | P7 S33 pass^1 part 9/26 | completed | 2 × 1 | $0.43 | $0.0015 | $1.7308 |
| 741 | 2026-10-24 | P7 S33 pass^1 part 10/26 | completed | 2 × 1 | $0.43 | $0.0005 | $1.7314 |
| 742 | 2026-10-24 | P7 S33 pass^1 part 11/26 | completed | 2 × 1 | $0.43 | $0.0008 | $1.7322 |
| 743 | 2026-10-24 | P7 S33 pass^1 part 12/26 | completed | 2 × 1 | $0.43 | $0.0007 | $1.7329 |
| 744 | 2026-10-24 | P7 S33 pass^1 part 13/26 | completed | 2 × 1 | $0.43 | $0.0007 | $1.7336 |
| 745 | 2026-10-24 | P7 S33 pass^1 part 14/26 | completed | 2 × 1 | $0.43 | $0.0016 | $1.7352 |
| 746 | 2026-10-24 | P7 S33 pass^1 part 15/26 | completed | 2 × 1 | $0.43 | $0.0015 | $1.7368 |
| 747 | 2026-10-24 | P7 S33 pass^1 part 16/26 | completed | 2 × 1 | $0.43 | $0.0016 | $1.7383 |
| 748 | 2026-10-24 | P7 S33 pass^1 part 17/26 | completed | 2 × 1 | $0.43 | $0.0006 | $1.7389 |
| 749 | 2026-10-24 | P7 S33 pass^1 part 18/26 | completed | 1 × 1 | $0.21 | $0.0013 | $1.7403 |
| 750 | 2026-10-24 | P7 S33 pass^1 part 19/26 | completed | 1 × 1 | $0.48 | $0.0018 | $1.7420 |
| 751 | 2026-10-24 | P7 S33 pass^1 part 20/26 | completed | 1 × 1 | $0.48 | $0.0008 | $1.7428 |
| 752 | 2026-10-24 | P7 S33 pass^1 part 21/26 | completed | 2 × 1 | $0.43 | $0.0003 | $1.7431 |
| 753 | 2026-10-24 | P7 S33 pass^1 part 22/26 | completed | 2 × 1 | $0.43 | $0.0004 | $1.7435 |
| 754 | 2026-10-24 | P7 S33 pass^1 part 23/26 | completed | 2 × 1 | $0.43 | $0.0007 | $1.7442 |
| 755 | 2026-10-24 | P7 S33 pass^1 part 24/26 | completed | 2 × 1 | $0.43 | $0.0006 | $1.7448 |
| 756 | 2026-10-24 | P7 S33 pass^1 part 25/26 | completed | 2 × 1 | $0.43 | $0.0007 | $1.7455 |
| 757 | 2026-10-24 | P7 S33 pass^1 part 26/26 | completed | 1 × 1 | $0.21 | $0.0002 | $1.7458 |
| 758 | 2026-10-24 | P7 S33 pass^3 part 1/75 | completed | 2 × 3 | $1.28 | $0.0028 | $1.7486 |
| 759 | 2026-10-24 | P7 S33 pass^3 part 2/75 | completed | 1 × 3 | $0.64 | $0.0014 | $1.7500 |
| 760 | 2026-10-24 | P7 S33 pass^3 part 3/75 | completed | 1 × 3 | $1.44 | $0.0017 | $1.7518 |
| 761 | 2026-10-24 | P7 S33 pass^3 part 4/75 | completed | 2 × 3 | $1.28 | $0.0098 | $1.7616 |
| 762 | 2026-10-24 | P7 S33 pass^3 part 5/75 | completed | 2 × 3 | $1.28 | $0.0017 | $1.7633 |
| 763 | 2026-10-24 | P7 S33 pass^3 part 6/75 | completed | 2 × 3 | $1.28 | $0.0029 | $1.7661 |
| 764 | 2026-10-24 | P7 S33 pass^3 part 7/75 | completed | 2 × 3 | $1.29 | $0.0026 | $1.7687 |
| 765 | 2026-10-24 | P7 S33 pass^3 part 8/75 | completed | 2 × 3 | $1.29 | $0.0034 | $1.7721 |
| 766 | 2026-10-24 | P7 S33 pass^3 part 9/75 | completed | 1 × 3 | $0.64 | $0.0014 | $1.7735 |
| 767 | 2026-10-24 | P7 S33 pass^3 part 10/75 | completed | 1 × 3 | $1.45 | $0.0020 | $1.7755 |
| 768 | 2026-10-24 | P7 S33 pass^3 part 11/75 | completed | 2 × 3 | $1.28 | $0.0016 | $1.7770 |
| 769 | 2026-10-24 | P7 S33 pass^3 part 12/75 | completed | 2 × 3 | $1.29 | $0.0039 | $1.7809 |
| 770 | 2026-10-24 | P7 S33 pass^3 part 13/75 | completed | 2 × 3 | $1.29 | $0.0015 | $1.7824 |
| 771 | 2026-10-24 | P7 S33 pass^3 part 14/75 | completed | 2 × 3 | $1.29 | $0.0013 | $1.7838 |
| 772 | 2026-10-24 | P7 S33 pass^3 part 15/75 | completed | 2 × 3 | $1.29 | $0.0034 | $1.7871 |
| 773 | 2026-10-24 | P7 S33 pass^3 part 16/75 | completed | 1 × 3 | $0.65 | $0.0007 | $1.7879 |
| 774 | 2026-10-24 | P7 S33 pass^3 part 17/75 | completed | 1 × 3 | $1.45 | $0.0014 | $1.7893 |
| 775 | 2026-10-24 | P7 S33 pass^3 part 18/75 | completed | 1 × 3 | $1.45 | $0.0016 | $1.7910 |
| 776 | 2026-10-24 | P7 S33 pass^3 part 19/75 | completed | 1 × 3 | $1.45 | $0.0018 | $1.7927 |
| 777 | 2026-10-24 | P7 S33 pass^3 part 20/75 | completed | 1 × 3 | $1.45 | $0.0010 | $1.7937 |
| 778 | 2026-10-24 | P7 S33 pass^3 part 21/75 | completed | 1 × 3 | $1.45 | $0.0035 | $1.7972 |
| 779 | 2026-10-24 | P7 S33 pass^3 part 22/75 | completed | 1 × 3 | $1.45 | $0.0011 | $1.7983 |
| 780 | 2026-10-24 | P7 S33 pass^3 part 23/75 | completed | 1 × 3 | $0.64 | $0.0012 | $1.7995 |
| 781 | 2026-10-24 | P7 S33 pass^3 part 24/75 | completed | 1 × 3 | $1.45 | $0.0265 | $1.8259 |
| 782 | 2026-10-24 | P7 S33 pass^3 part 25/75 | completed | 1 × 3 | $0.64 | $0.0010 | $1.8269 |
| 783 | 2026-10-24 | P7 S33 pass^3 part 26/75 | completed | 1 × 3 | $1.45 | $0.0019 | $1.8288 |
| 784 | 2026-10-24 | P7 S33 pass^3 part 27/75 | completed | 2 × 3 | $1.29 | $0.0021 | $1.8309 |
| 785 | 2026-10-24 | P7 S33 pass^3 part 28/75 | completed | 2 × 3 | $1.29 | $0.0043 | $1.8352 |
| 786 | 2026-10-24 | P7 S33 pass^3 part 29/75 | completed | 2 × 3 | $1.29 | $0.0050 | $1.8402 |
| 787 | 2026-10-24 | P7 S33 pass^3 part 30/75 | completed | 2 × 3 | $1.28 | $0.0010 | $1.8412 |
| 788 | 2026-10-24 | P7 S33 pass^3 part 31/75 | completed | 2 × 3 | $1.29 | $0.0019 | $1.8431 |
| 789 | 2026-10-24 | P7 S33 pass^3 part 32/75 | completed | 2 × 3 | $1.28 | $0.0012 | $1.8443 |
| 790 | 2026-10-24 | P7 S33 pass^3 part 33/75 | completed | 2 × 3 | $1.28 | $0.0012 | $1.8455 |
| 791 | 2026-10-24 | P7 S33 pass^3 part 34/75 | completed | 1 × 3 | $0.64 | $0.0006 | $1.8461 |
| 792 | 2026-10-24 | P7 S33 pass^3 part 35/75 | completed | 1 × 3 | $1.45 | $0.0044 | $1.8505 |
| 793 | 2026-10-24 | P7 S33 pass^3 part 36/75 | completed | 2 × 3 | $1.28 | $0.0012 | $1.8517 |
| 794 | 2026-10-24 | P7 S33 pass^3 part 37/75 | completed | 2 × 3 | $1.28 | $0.0012 | $1.8529 |
| 795 | 2026-10-24 | P7 S33 pass^3 part 38/75 | completed | 2 × 3 | $1.29 | $0.0144 | $1.8673 |
| 796 | 2026-10-24 | P7 S33 pass^3 part 39/75 | completed | 2 × 3 | $1.28 | $0.0014 | $1.8687 |
| 797 | 2026-10-24 | P7 S33 pass^3 part 40/75 | completed | 2 × 3 | $1.28 | $0.0022 | $1.8709 |
| 798 | 2026-10-24 | P7 S33 pass^3 part 41/75 | completed | 2 × 3 | $1.28 | $0.0376 | $1.9085 |
| 799 | 2026-10-24 | P7 S33 pass^3 part 42/75 | completed | 2 × 3 | $1.28 | $0.0011 | $1.9096 |
| 800 | 2026-10-24 | P7 S33 pass^3 part 43/75 | completed | 2 × 3 | $1.28 | $0.0019 | $1.9115 |
| 801 | 2026-10-24 | P7 S33 pass^3 part 44/75 | completed | 2 × 3 | $1.28 | $0.0050 | $1.9165 |
| 802 | 2026-10-24 | P7 S33 pass^3 part 45/75 | completed | 2 × 3 | $1.28 | $0.0006 | $1.9171 |
| 803 | 2026-10-24 | P7 S33 pass^3 part 46/75 | completed | 2 × 3 | $1.28 | $0.0009 | $1.9180 |
| 804 | 2026-10-24 | P7 S33 pass^3 part 47/75 | completed | 2 × 3 | $1.28 | $0.0008 | $1.9188 |
| 805 | 2026-10-24 | P7 S33 pass^3 part 48/75 | completed | 2 × 3 | $1.28 | $0.0025 | $1.9213 |
| 806 | 2026-10-24 | P7 S33 pass^3 part 49/75 | completed | 2 × 3 | $1.28 | $0.0007 | $1.9220 |
| 807 | 2026-10-24 | P7 S33 pass^3 part 50/75 | completed | 1 × 3 | $1.45 | $0.0010 | $1.9229 |
| 808 | 2026-10-24 | P7 S33 pass^3 part 51/75 | completed | 2 × 3 | $1.28 | $0.0018 | $1.9248 |
| 809 | 2026-10-24 | P7 S33 pass^3 part 52/75 | completed | 2 × 3 | $1.28 | $0.0012 | $1.9260 |
| 810 | 2026-10-24 | P7 S33 pass^3 part 53/75 | completed | 2 × 3 | $1.28 | $0.0027 | $1.9286 |
| 811 | 2026-10-24 | P7 S33 pass^3 part 54/75 | completed | 2 × 3 | $1.29 | $0.0022 | $1.9309 |
| 812 | 2026-10-24 | P7 S33 pass^3 part 55/75 | completed | 2 × 3 | $1.28 | $0.0020 | $1.9329 |
| 813 | 2026-10-24 | P7 S33 pass^3 part 56/75 | completed | 2 × 3 | $1.28 | $0.0014 | $1.9343 |
| 814 | 2026-10-24 | P7 S33 pass^3 part 57/75 | completed | 2 × 3 | $1.28 | $0.0016 | $1.9359 |
| 815 | 2026-10-24 | P7 S33 pass^3 part 58/75 | completed | 2 × 3 | $1.28 | $0.0011 | $1.9370 |
| 816 | 2026-10-24 | P7 S33 pass^3 part 59/75 | completed | 2 × 3 | $1.28 | $0.0328 | $1.9698 |
| 817 | 2026-10-24 | P7 S33 pass^3 part 60/75 | completed | 2 × 3 | $1.28 | $0.0021 | $1.9719 |
| 818 | 2026-10-24 | P7 S33 pass^3 part 61/75 | completed | 2 × 3 | $1.28 | $0.0023 | $1.9741 |
| 819 | 2026-10-24 | P7 S33 pass^3 part 62/75 | completed | 2 × 3 | $1.28 | $0.0067 | $1.9808 |
| 820 | 2026-10-24 | P7 S33 pass^3 part 63/75 | completed | 2 × 3 | $1.28 | $0.0014 | $1.9823 |
| 821 | 2026-10-24 | P7 S33 pass^3 part 64/75 | completed | 2 × 3 | $1.28 | $0.0069 | $1.9892 |
| 822 | 2026-10-24 | P7 S33 pass^3 part 65/75 | completed | 2 × 3 | $1.28 | $0.0014 | $1.9906 |
| 823 | 2026-10-24 | P7 S33 pass^3 part 66/75 | completed | 2 × 3 | $1.28 | $0.0017 | $1.9923 |
| 824 | 2026-10-24 | P7 S33 pass^3 part 67/75 | completed | 2 × 3 | $1.28 | $0.0013 | $1.9936 |
| 825 | 2026-10-24 | P7 S33 pass^3 part 68/75 | completed | 2 × 3 | $1.28 | $0.0010 | $1.9946 |
| 826 | 2026-10-24 | P7 S33 pass^3 part 69/75 | completed | 2 × 3 | $1.28 | $0.0011 | $1.9958 |
| 827 | 2026-10-24 | P7 S33 pass^3 part 70/75 | completed | 2 × 3 | $1.28 | $0.0010 | $1.9968 |
| 828 | 2026-10-24 | P7 S33 pass^3 part 71/75 | completed | 2 × 3 | $1.28 | $0.0019 | $1.9987 |
| 829 | 2026-10-24 | P7 S33 pass^3 part 72/75 | completed | 2 × 3 | $1.28 | $0.0081 | $2.0068 |
| 830 | 2026-10-24 | P7 S33 pass^3 part 73/75 | completed | 2 × 3 | $1.28 | $0.0019 | $2.0087 |
| 831 | 2026-10-24 | P7 S33 pass^3 part 74/75 | completed | 2 × 3 | $1.28 | $0.0011 | $2.0098 |
| 832 | 2026-10-24 | P7 S33 pass^3 part 75/75 | completed | 2 × 3 | $1.28 | $0.0020 | $2.0119 |
| 833 | 2026-10-24 | P7 S33 pass^3 503 retry | completed | 1 × 3 | $0.64 | $0.0000 | $2.0119 |
| 834 | 2026-10-24 | P7 S33 new holdout in-three-days | completed | 1 × 1 | $0.21 | $0.0000 | $2.0119 |
| 835 | 2026-10-24 | P7 S33 new holdout in-three-days | completed | 1 × 1 | $0.21 | $0.0004 | $2.0122 |
| 836 | 2026-10-24 | P8 P8 S36b probe part 1/45 | completed | 2 × 1 | $0.45 | $0.0021 | $2.0143 |
| 837 | 2026-10-24 | P8 P8 S36b probe part 2/45 | completed | 1 × 1 | $0.22 | $0.0005 | $2.0147 |
| 838 | 2026-10-24 | P8 P8 S36b probe part 3/45 | completed | 1 × 1 | $0.50 | $0.0006 | $2.0153 |
| 839 | 2026-10-24 | P8 P8 S36b probe part 4/45 | completed | 2 × 1 | $0.45 | $0.0256 | $2.0409 |
| 840 | 2026-10-24 | P8 P8 S36b probe part 5/45 | completed | 2 × 1 | $0.45 | $0.0006 | $2.0415 |
| 841 | 2026-10-24 | P8 P8 S36b probe part 6/45 | completed | 6 × 1 | $0.54 | $0.0024 | $2.0439 |
| 842 | 2026-10-24 | P8 P8 S36b probe part 7/45 | completed | 11 × 1 | $0.48 | $0.0021 | $2.0460 |
| 843 | 2026-10-24 | P8 P8 S36b probe part 8/45 | completed | 2 × 1 | $0.47 | $0.0007 | $2.0467 |
| 844 | 2026-10-24 | P8 P8 S36b probe part 9/45 | completed | 2 × 1 | $0.45 | $0.0016 | $2.0483 |
| 845 | 2026-10-24 | P8 P8 S36b probe part 10/45 | completed | 2 × 1 | $0.45 | $0.0005 | $2.0488 |
| 846 | 2026-10-24 | P8 P8 S36b probe part 11/45 | completed | 2 × 1 | $0.47 | $0.0007 | $2.0495 |
| 847 | 2026-10-24 | P8 P8 S36b probe part 12/45 | completed | 5 × 1 | $0.32 | $0.0006 | $2.0501 |
| 848 | 2026-10-24 | P8 P8 S36b probe part 13/45 | completed | 2 × 1 | $0.47 | $0.0003 | $2.0504 |
| 849 | 2026-10-24 | P8 P8 S36b probe part 14/45 | completed | 2 × 1 | $0.45 | $0.0009 | $2.0512 |
| 850 | 2026-10-24 | P8 P8 S36b probe part 15/45 | completed | 2 × 1 | $0.45 | $0.0008 | $2.0520 |
| 851 | 2026-10-24 | P8 P8 S36b probe part 16/45 | completed | 2 × 1 | $0.45 | $0.0011 | $2.0531 |
| 852 | 2026-10-24 | P8 P8 S36b probe part 17/45 | completed | 2 × 1 | $0.45 | $0.0015 | $2.0546 |
| 853 | 2026-10-24 | P8 P8 S36b probe part 18/45 | completed | 2 × 1 | $0.45 | $0.0017 | $2.0562 |
| 854 | 2026-10-24 | P8 P8 S36b probe part 19/45 | completed | 2 × 1 | $0.45 | $0.0007 | $2.0569 |
| 855 | 2026-10-24 | P8 P8 S36b probe part 20/45 | completed | 1 × 1 | $0.22 | $0.0013 | $2.0582 |
| 856 | 2026-10-24 | P8 P8 S36b probe part 21/45 | completed | 1 × 1 | $0.50 | $0.0017 | $2.0599 |
| 857 | 2026-10-24 | P8 P8 S36b probe part 22/45 | completed | 1 × 1 | $0.50 | $0.0008 | $2.0607 |
| 858 | 2026-10-24 | P8 P8 S36b probe part 23/45 | completed | 2 × 1 | $0.45 | $0.0007 | $2.0614 |
| 859 | 2026-10-24 | P8 P8 S36b probe part 24/45 | completed | 2 × 1 | $0.45 | $0.0011 | $2.0624 |
| 860 | 2026-10-24 | P8 P8 S36b probe part 25/45 | completed | 2 × 1 | $0.45 | $0.0018 | $2.0642 |
| 861 | 2026-10-24 | P8 P8 S36b probe part 26/45 | completed | 2 × 1 | $0.45 | $0.0009 | $2.0650 |
| 862 | 2026-10-24 | P8 P8 S36b probe part 27/45 | completed | 2 × 1 | $0.45 | $0.0007 | $2.0657 |
| 863 | 2026-10-24 | P8 P8 S36b probe part 28/45 | completed | 2 × 1 | $0.45 | $0.0319 | $2.0976 |
| 864 | 2026-10-24 | P8 P8 S36b probe part 29/45 | completed | 2 × 1 | $0.45 | $0.0060 | $2.1036 |
| 865 | 2026-10-24 | P8 P8 S36b probe part 30/45 | completed | 2 × 1 | $0.45 | $0.0011 | $2.1047 |
| 866 | 2026-10-24 | P8 P8 S36b probe part 31/45 | completed | 2 × 1 | $0.45 | $0.0010 | $2.1057 |
| 867 | 2026-10-24 | P8 P8 S36b probe part 32/45 | completed | 2 × 1 | $0.45 | $0.0008 | $2.1065 |
| 868 | 2026-10-24 | P8 P8 S36b probe part 33/45 | completed | 2 × 1 | $0.45 | $0.0022 | $2.1087 |
| 869 | 2026-10-24 | P8 P8 S36b probe part 34/45 | completed | 2 × 1 | $0.45 | $0.0018 | $2.1105 |
| 870 | 2026-10-24 | P8 P8 S36b probe part 35/45 | completed | 2 × 1 | $0.45 | $0.0009 | $2.1114 |
| 871 | 2026-10-24 | P8 P8 S36b probe part 36/45 | completed | 2 × 1 | $0.45 | $0.0007 | $2.1121 |
| 872 | 2026-10-24 | P8 P8 S36b probe part 37/45 | completed | 2 × 1 | $0.45 | $0.0005 | $2.1127 |
| 873 | 2026-10-24 | P8 P8 S36b probe part 38/45 | completed | 2 × 1 | $0.45 | $0.0006 | $2.1133 |
| 874 | 2026-10-24 | P8 P8 S36b probe part 39/45 | completed | 2 × 1 | $0.45 | $0.0005 | $2.1138 |
| 875 | 2026-10-24 | P8 P8 S36b probe part 40/45 | completed | 2 × 1 | $0.45 | $0.0007 | $2.1145 |
| 876 | 2026-10-24 | P8 P8 S36b probe part 41/45 | completed | 2 × 1 | $0.45 | $0.0011 | $2.1156 |
| 877 | 2026-10-24 | P8 P8 S36b probe part 42/45 | completed | 2 × 1 | $0.45 | $0.0256 | $2.1412 |
| 878 | 2026-10-24 | P8 P8 S36b probe part 43/45 | completed | 2 × 1 | $0.45 | $0.0007 | $2.1419 |
| 879 | 2026-10-24 | P8 P8 S36b probe part 44/45 | completed | 2 × 1 | $0.45 | $0.0009 | $2.1429 |
| 880 | 2026-10-24 | P8 P8 S36b probe part 45/45 | completed | 2 × 1 | $0.45 | $0.0008 | $2.1437 |

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
- Run 308, gpt-6-luna: 5 calls, 41526 in (32985 cached, 8526 written), 168 out, p50 6749 ms, p95 9829 ms; 3.72 chars a token
- Run 309, gpt-6-luna: 6 calls, 50473 in (49809 cached, 646 written), 220 out, p50 5185 ms, p95 6912 ms; 3.72 chars a token
- Run 310, gpt-6-luna: 7 calls, 59577 in (58506 cached, 1050 written), 237 out, p50 3418 ms, p95 5636 ms; 3.71 chars a token
- Run 311, gpt-6-luna: 6 calls, 50665 in (49529 cached, 1118 written), 201 out, p50 3448 ms, p95 4288 ms; 3.72 chars a token
- Run 312, gpt-6-luna: 4 calls, 33537 in (32967 cached, 558 written), 106 out, p50 2526 ms, p95 3126 ms; 3.71 chars a token
- Run 313, gpt-6-luna: 6 calls, 49917 in (41288 cached, 8611 written), 197 out, p50 2103 ms, p95 4755 ms; 3.73 chars a token
- Run 314, gpt-6-luna: 6 calls, 50678 in (49646 cached, 1014 written), 211 out, p50 2801 ms, p95 3249 ms; 3.72 chars a token
- Run 315, gpt-6-luna: 7 calls, 59813 in (58443 cached, 1349 written), 406 out, p50 2862 ms, p95 3429 ms; 3.75 chars a token
- Run 316, gpt-6-luna: 6 calls, 51582 in (50214 cached, 1350 written), 399 out, p50 1475 ms, p95 1964 ms; 3.71 chars a token
- Run 317, gpt-6-luna: 6 calls, 50468 in (49798 cached, 652 written), 136 out, p50 1255 ms, p95 1744 ms; 3.72 chars a token
- Run 318, gpt-6-luna: 5 calls, 41576 in (41192 cached, 369 written), 115 out, p50 1752 ms, p95 2144 ms; 3.73 chars a token
- Run 319, gpt-6-luna: 3 calls, 25031 in (16446 cached, 8576 written), 55 out, p50 2643 ms, p95 2701 ms; 3.72 chars a token
- Run 320, gpt-6-luna: 4 calls, 33333 in (32887 cached, 434 written), 83 out, p50 2184 ms, p95 2695 ms; 3.72 chars a token
- Run 321, gpt-6-luna: 4 calls, 33441 in (32895 cached, 534 written), 83 out, p50 2570 ms, p95 3337 ms; 3.72 chars a token
- Run 322, gpt-6-luna: 6 calls, 51947 in (42309 cached, 9620 written), 186 out, p50 2285 ms, p95 2471 ms; 3.72 chars a token
- Run 323, gpt-6-luna: 2 calls, 16820 in (16444 cached, 370 written), 76 out, p50 2624 ms, p95 3015 ms; 3.72 chars a token
- Run 324, gpt-6-luna: 5 calls, 42162 in (41513 cached, 634 written), 153 out, p50 3877 ms, p95 11266 ms; 3.79 chars a token
- Run 325, gpt-6-luna: 4 calls, 33796 in (33014 cached, 770 written), 185 out, p50 3415 ms, p95 4571 ms; 3.78 chars a token
- Run 326, gpt-6-luna: 4 calls, 33159 in (32897 cached, 250 written), 85 out, p50 1424 ms, p95 2226 ms; 3.72 chars a token
- Run 327, gpt-6-luna: 3 calls, 25018 in (24675 cached, 334 written), 84 out, p50 1626 ms, p95 2030 ms; 3.73 chars a token
- Run 328, gpt-6-luna: 2 calls, 16560 in (8216 cached, 8338 written), 30 out, p50 1621 ms, p95 5238 ms; 3.72 chars a token
- Run 329, gpt-6-luna: 3 calls, 25199 in (24690 cached, 500 written), 64 out, p50 2425 ms, p95 2642 ms; 3.72 chars a token
- Run 330, gpt-6-luna: 3 calls, 25286 in (24759 cached, 518 written), 74 out, p50 1743 ms, p95 2482 ms; 3.71 chars a token
- Run 331, gpt-6-luna: 4 calls, 34752 in (33379 cached, 1361 written), 234 out, p50 1640 ms, p95 2297 ms; 3.71 chars a token
- Run 332, gpt-6-luna: 3 calls, 25498 in (24815 cached, 674 written), 110 out, p50 1703 ms, p95 1980 ms; 3.73 chars a token
- Run 333, gpt-6-luna: 5 calls, 41971 in (41419 cached, 537 written), 190 out, p50 1987 ms, p95 2425 ms; 3.78 chars a token
- Run 334, gpt-6-luna: 6 calls, 50405 in (49580 cached, 807 written), 178 out, p50 2100 ms, p95 2755 ms; 3.72 chars a token
- Run 335, gpt-6-luna: 4 calls, 33542 in (24748 cached, 8782 written), 139 out, p50 2119 ms, p95 2622 ms; 3.72 chars a token
- Run 336, gpt-6-luna: 6 calls, 51105 in (41994 cached, 9093 written), 219 out, p50 2637 ms, p95 3142 ms; 3.71 chars a token
- Run 337, gpt-6-luna: 3 calls, 24787 in (24660 cached, 118 written), 91 out, p50 2511 ms, p95 3326 ms; 3.72 chars a token
- Run 338, gpt-6-luna: 5 calls, 41934 in (41314 cached, 605 written), 196 out, p50 4796 ms, p95 6168 ms; 3.77 chars a token
- Run 339, text-embedding-3-small: 4 calls, 98 in (0 cached, 0 written), 0 out, p50 641 ms, p95 667 ms; 3.73 chars a token
- Run 339, gpt-6-luna: 4 calls, 33369 in (32891 cached, 466 written), 96 out, p50 3398 ms, p95 4165 ms; 3.73 chars a token
- Run 340, text-embedding-3-small: 3 calls, 23 in (0 cached, 0 written), 0 out, p50 491 ms, p95 592 ms; 3.73 chars a token
- Run 340, gpt-6-luna: 4 calls, 33222 in (32888 cached, 322 written), 92 out, p50 2431 ms, p95 4292 ms; 3.73 chars a token
- Run 341, text-embedding-3-small: 2 calls, 25 in (0 cached, 0 written), 0 out, p50 524 ms, p95 678 ms; 3.73 chars a token
- Run 341, gpt-6-luna: 2 calls, 16647 in (16446 cached, 195 written), 35 out, p50 3270 ms, p95 3279 ms; 3.73 chars a token
- Run 342, gpt-6-luna: 5 calls, 33737 in (24784 cached, 8635 written), 289 out, p50 2629 ms, p95 5253 ms; 3.80 chars a token
- Run 342, text-embedding-3-small: 2 calls, 27 in (0 cached, 0 written), 0 out, p50 218 ms, p95 607 ms; 3.80 chars a token
- Run 343, text-embedding-3-small: 3 calls, 48 in (0 cached, 0 written), 0 out, p50 514 ms, p95 681 ms; 3.74 chars a token
- Run 343, gpt-6-luna: 4 calls, 25274 in (24662 cached, 282 written), 364 out, p50 3565 ms, p95 6087 ms; 3.74 chars a token
- Run 344, gpt-6-luna: 5 calls, 42022 in (33188 cached, 8819 written), 243 out, p50 3426 ms, p95 3536 ms; 3.72 chars a token
- Run 345, gpt-6-luna: 4 calls, 33257 in (24691 cached, 8554 written), 207 out, p50 2927 ms, p95 4762 ms; 3.72 chars a token
- Run 346, gpt-6-luna: 4 calls, 33345 in (24682 cached, 8651 written), 151 out, p50 2165 ms, p95 5050 ms; 3.72 chars a token
- Run 347, gpt-6-luna: 4 calls, 33986 in (24949 cached, 9025 written), 285 out, p50 2845 ms, p95 3706 ms; 3.73 chars a token
- Run 348, gpt-6-luna: 6 calls, 51576 in (50866 cached, 692 written), 379 out, p50 2388 ms, p95 3105 ms; 3.79 chars a token
- Run 349, text-embedding-3-small: 2 calls, 36 in (0 cached, 0 written), 0 out, p50 566 ms, p95 588 ms; 3.73 chars a token
- Run 349, gpt-6-luna: 3 calls, 24927 in (24661 cached, 257 written), 166 out, p50 2362 ms, p95 3788 ms; 3.73 chars a token
- Run 350, text-embedding-3-small: 2 calls, 17 in (0 cached, 0 written), 0 out, p50 450 ms, p95 635 ms; 3.73 chars a token
- Run 350, gpt-6-luna: 4 calls, 33316 in (24758 cached, 8546 written), 126 out, p50 1506 ms, p95 2133 ms; 3.73 chars a token
- Run 351, text-embedding-3-small: 4 calls, 44 in (0 cached, 0 written), 0 out, p50 515 ms, p95 615 ms; 3.74 chars a token
- Run 351, gpt-6-luna: 6 calls, 50617 in (49795 cached, 804 written), 179 out, p50 1961 ms, p95 2601 ms; 3.74 chars a token
- Run 351, gpt-6.1-sol: 1 calls, 8924 in (0 cached, 8921 written), 38 out, p50 2291 ms, p95 2291 ms; 3.74 chars a token
- Run 352, text-embedding-3-small: 1 calls, 15 in (0 cached, 0 written), 0 out, p50 508 ms, p95 508 ms; 3.69 chars a token
- Run 352, gpt-6-luna: 6 calls, 52194 in (50750 cached, 1426 written), 393 out, p50 3048 ms, p95 3385 ms; 3.69 chars a token
- Run 353, gpt-6-luna: 6 calls, 50775 in (49773 cached, 984 written), 300 out, p50 1680 ms, p95 3049 ms; 3.81 chars a token
- Run 353, gpt-6.1-sol: 1 calls, 9081 in (0 cached, 9078 written), 36 out, p50 2189 ms, p95 2189 ms; 3.81 chars a token
- Run 354, gpt-6-luna: 4 calls, 33081 in (32892 cached, 177 written), 117 out, p50 2340 ms, p95 2807 ms; 3.72 chars a token
- Run 355, gpt-6-luna: 4 calls, 33279 in (32888 cached, 379 written), 83 out, p50 1385 ms, p95 1765 ms; 3.71 chars a token
- Run 356, gpt-6-luna: 8 calls, 67699 in (66675 cached, 1000 written), 290 out, p50 1481 ms, p95 2532 ms; 3.72 chars a token
- Run 357, gpt-6-luna: 2 calls, 16492 in (16432 cached, 54 written), 76 out, p50 2167 ms, p95 2223 ms; 3.72 chars a token
- Run 358, gpt-6-luna: 2 calls, 16474 in (16432 cached, 36 written), 68 out, p50 1917 ms, p95 2696 ms; 3.72 chars a token
- Run 359, gpt-6-luna: 3 calls, 24779 in (24660 cached, 110 written), 138 out, p50 2198 ms, p95 2922 ms; 3.72 chars a token
- Run 360, gpt-6-luna: 5 calls, 43473 in (42176 cached, 1282 written), 441 out, p50 1879 ms, p95 2940 ms; 3.85 chars a token
- Run 361, gpt-6-luna: 2 calls, 16500 in (16432 cached, 62 written), 128 out, p50 1826 ms, p95 2099 ms; 3.71 chars a token
- Run 362, gpt-6-luna: 1 calls, 8243 in (8216 cached, 24 written), 117 out, p50 2631 ms, p95 2631 ms; 3.71 chars a token
- Run 363, gpt-6-luna: 3 calls, 24896 in (24751 cached, 136 written), 122 out, p50 1552 ms, p95 1564 ms; 3.73 chars a token
- Run 364, gpt-6-luna: 4 calls, 33373 in (32969 cached, 392 written), 200 out, p50 1641 ms, p95 2412 ms; 3.72 chars a token
- Run 365, gpt-6-luna: 5 calls, 41765 in (41182 cached, 568 written), 227 out, p50 1730 ms, p95 2615 ms; 3.82 chars a token
- Run 366, gpt-6-luna: 6 calls, 50549 in (49879 cached, 652 written), 380 out, p50 1549 ms, p95 4409 ms; 3.79 chars a token
- Run 367, gpt-6-luna: 5 calls, 42429 in (33563 cached, 8851 written), 221 out, p50 1520 ms, p95 2834 ms; 3.71 chars a token
- Run 368, gpt-6-luna: 7 calls, 59641 in (58403 cached, 1217 written), 362 out, p50 1569 ms, p95 2617 ms; 3.71 chars a token
- Run 369, gpt-6-luna: 6 calls, 50623 in (49791 cached, 814 written), 218 out, p50 1404 ms, p95 2581 ms; 3.72 chars a token
- Run 370, gpt-6-luna: 6 calls, 51144 in (49710 cached, 1416 written), 223 out, p50 1375 ms, p95 2270 ms; 3.70 chars a token
- Run 371, gpt-6-luna: 5 calls, 42185 in (41418 cached, 752 written), 231 out, p50 1702 ms, p95 3690 ms; 3.70 chars a token
- Run 372, gpt-6-luna: 8 calls, 68290 in (66977 cached, 1289 written), 369 out, p50 1725 ms, p95 3031 ms; 3.70 chars a token
- Run 372, gpt-6.1-sol: 1 calls, 9066 in (8216 cached, 847 written), 25 out, p50 2688 ms, p95 2688 ms; 3.70 chars a token
- Run 373, gpt-6-luna: 7 calls, 60812 in (59061 cached, 1730 written), 425 out, p50 1799 ms, p95 2212 ms; 3.72 chars a token
- Run 374, gpt-6-luna: 6 calls, 52057 in (50022 cached, 2017 written), 626 out, p50 2037 ms, p95 6628 ms; 3.69 chars a token
- Run 375, gpt-6-luna: 7 calls, 59686 in (58428 cached, 1237 written), 379 out, p50 1483 ms, p95 2038 ms; 3.71 chars a token
- Run 376, gpt-6-luna: 5 calls, 42283 in (41397 cached, 871 written), 149 out, p50 1481 ms, p95 2255 ms; 3.70 chars a token
- Run 377, gpt-6-luna: 8 calls, 69781 in (59648 cached, 10109 written), 477 out, p50 1834 ms, p95 2726 ms; 3.69 chars a token
- Run 378, gpt-6-luna: 5 calls, 42723 in (33180 cached, 9528 written), 214 out, p50 1711 ms, p95 2145 ms; 3.69 chars a token
- Run 379, gpt-6-luna: 7 calls, 59893 in (58322 cached, 1550 written), 301 out, p50 1517 ms, p95 2254 ms; 3.70 chars a token
- Run 380, gpt-6-luna: 6 calls, 50102 in (49500 cached, 584 written), 176 out, p50 1610 ms, p95 2956 ms; 3.72 chars a token
- Run 381, gpt-6-luna: 5 calls, 41508 in (41192 cached, 301 written), 122 out, p50 1609 ms, p95 2988 ms; 3.72 chars a token
- Run 382, gpt-6-luna: 4 calls, 33282 in (32883 cached, 387 written), 80 out, p50 1602 ms, p95 2545 ms; 3.71 chars a token
- Run 383, gpt-6-luna: 5 calls, 41857 in (41382 cached, 460 written), 109 out, p50 1385 ms, p95 1625 ms; 3.71 chars a token
- Run 384, gpt-6-luna: 4 calls, 33109 in (32888 cached, 209 written), 79 out, p50 1342 ms, p95 1469 ms; 3.72 chars a token
- Run 384, text-embedding-3-small: 1 calls, 2 in (0 cached, 0 written), 0 out, p50 536 ms, p95 536 ms; 3.72 chars a token
- Run 385, gpt-6-luna: 7 calls, 59767 in (58610 cached, 1136 written), 370 out, p50 1509 ms, p95 2194 ms; 3.71 chars a token
- Run 386, gpt-6-luna: 8 calls, 67925 in (66714 cached, 1187 written), 320 out, p50 1594 ms, p95 2125 ms; 3.71 chars a token
- Run 386, gpt-6.1-sol: 1 calls, 9042 in (0 cached, 9039 written), 21 out, p50 1773 ms, p95 1773 ms; 3.71 chars a token
- Run 387, gpt-6-luna: 8 calls, 67755 in (66722 cached, 1009 written), 291 out, p50 1473 ms, p95 1996 ms; 3.72 chars a token
- Run 388, gpt-6-luna: 5 calls, 41939 in (41408 cached, 516 written), 184 out, p50 1371 ms, p95 1584 ms; 3.71 chars a token
- Run 389, gpt-6-luna: 8 calls, 69088 in (67592 cached, 1472 written), 281 out, p50 1267 ms, p95 2320 ms; 3.69 chars a token
- Run 390, gpt-6-luna: 5 calls, 41983 in (41530 cached, 438 written), 185 out, p50 1687 ms, p95 2189 ms; 3.71 chars a token
- Run 391, gpt-6-luna: 6 calls, 49987 in (49558 cached, 411 written), 152 out, p50 1466 ms, p95 3546 ms; 3.73 chars a token
- Run 392, gpt-6-luna: 5 calls, 41544 in (41203 cached, 326 written), 327 out, p50 1516 ms, p95 3069 ms; 3.73 chars a token
- Run 393, gpt-6-luna: 6 calls, 50532 in (49845 cached, 669 written), 256 out, p50 1274 ms, p95 2068 ms; 3.72 chars a token
- Run 394, gpt-6-luna: 2 calls, 16983 in (8283 cached, 8694 written), 76 out, p50 1725 ms, p95 2974 ms; 3.71 chars a token
- Run 395, gpt-6-luna: 6 calls, 52641 in (51791 cached, 832 written), 260 out, p50 1306 ms, p95 1822 ms; 3.72 chars a token
- Run 396, gpt-6-luna: 4 calls, 33604 in (33196 cached, 396 written), 104 out, p50 1552 ms, p95 2140 ms; 3.72 chars a token
- Run 397, gpt-6-luna: 7 calls, 59708 in (50421 cached, 9266 written), 277 out, p50 1500 ms, p95 2111 ms; 3.75 chars a token
- Run 398, gpt-6-luna: 4 calls, 33661 in (16557 cached, 17092 written), 132 out, p50 1723 ms, p95 1825 ms; 3.71 chars a token
- Run 399, gpt-6-luna: 7 calls, 59932 in (58918 cached, 993 written), 280 out, p50 1511 ms, p95 2098 ms; 3.71 chars a token
- Run 400, gpt-6-luna: 6 calls, 50915 in (41857 cached, 9040 written), 226 out, p50 1369 ms, p95 1757 ms; 3.72 chars a token
- Run 401, gpt-6-luna: 7 calls, 59935 in (58799 cached, 1115 written), 355 out, p50 1544 ms, p95 2139 ms; 3.71 chars a token
- Run 402, gpt-6-luna: 4 calls, 34110 in (33589 cached, 509 written), 139 out, p50 1416 ms, p95 2279 ms; 3.72 chars a token
- Run 403, gpt-6-luna: 5 calls, 42869 in (42313 cached, 541 written), 164 out, p50 1525 ms, p95 1762 ms; 3.73 chars a token
- Run 404, gpt-6-luna: 5 calls, 42299 in (41821 cached, 463 written), 183 out, p50 1588 ms, p95 2244 ms; 3.73 chars a token
- Run 404, gpt-6.1-sol: 2 calls, 18122 in (8997 cached, 9119 written), 86 out, p50 2023 ms, p95 2084 ms; 3.73 chars a token
- Run 405, gpt-6-luna: 5 calls, 42218 in (41682 cached, 521 written), 163 out, p50 1528 ms, p95 2306 ms; 3.71 chars a token
- Run 406, gpt-6-luna: 8 calls, 68969 in (58910 cached, 10035 written), 546 out, p50 1464 ms, p95 3373 ms; 3.79 chars a token
- Run 406, gpt-6.1-sol: 1 calls, 9722 in (8270 cached, 1449 written), 41 out, p50 2082 ms, p95 2082 ms; 3.79 chars a token
- Run 407, gpt-6-luna: 5 calls, 42426 in (41670 cached, 741 written), 210 out, p50 1772 ms, p95 2014 ms; 3.71 chars a token
- Run 408, gpt-6-luna: 7 calls, 59796 in (58699 cached, 1076 written), 257 out, p50 1515 ms, p95 2091 ms; 3.71 chars a token
- Run 408, gpt-6.1-sol: 1 calls, 9220 in (8270 cached, 947 written), 49 out, p50 3284 ms, p95 3284 ms; 3.71 chars a token
- Run 409, gpt-6-luna: 7 calls, 59914 in (58852 cached, 1041 written), 323 out, p50 1610 ms, p95 2387 ms; 3.71 chars a token
- Run 410, gpt-6-luna: 5 calls, 41811 in (41466 cached, 330 written), 156 out, p50 1412 ms, p95 2204 ms; 3.73 chars a token
- Run 411, gpt-6-luna: 5 calls, 42201 in (41662 cached, 524 written), 178 out, p50 1564 ms, p95 3253 ms; 3.72 chars a token
- Run 412, gpt-6-luna: 5 calls, 41836 in (41495 cached, 326 written), 120 out, p50 1312 ms, p95 3301 ms; 3.73 chars a token
- Run 413, gpt-6-luna: 4 calls, 33364 in (24836 cached, 8516 written), 153 out, p50 1365 ms, p95 3148 ms; 3.78 chars a token
- Run 414, gpt-6-luna: 6 calls, 50992 in (41902 cached, 9072 written), 307 out, p50 1393 ms, p95 2083 ms; 3.72 chars a token
- Run 415, gpt-6-luna: 5 calls, 41802 in (33203 cached, 8584 written), 164 out, p50 1312 ms, p95 2161 ms; 3.73 chars a token
- Run 416, gpt-6-luna: 5 calls, 41796 in (41482 cached, 299 written), 156 out, p50 1474 ms, p95 1762 ms; 3.73 chars a token
- Run 417, gpt-6-luna: 7 calls, 59989 in (58898 cached, 1070 written), 241 out, p50 1411 ms, p95 1763 ms; 3.71 chars a token
- Run 418, gpt-6-luna: 6 calls, 51021 in (49858 cached, 1145 written), 194 out, p50 1306 ms, p95 2039 ms; 3.72 chars a token
- Run 419, gpt-6-luna: 4 calls, 33758 in (33184 cached, 562 written), 183 out, p50 1728 ms, p95 1998 ms; 3.72 chars a token
- Run 420, gpt-6-luna: 6 calls, 50250 in (41561 cached, 8671 written), 197 out, p50 1473 ms, p95 1818 ms; 3.73 chars a token
- Run 421, gpt-6-luna: 6 calls, 50954 in (49956 cached, 980 written), 193 out, p50 1284 ms, p95 1980 ms; 3.73 chars a token
- Run 422, gpt-6-luna: 8 calls, 69493 in (67797 cached, 1672 written), 456 out, p50 1383 ms, p95 2290 ms; 3.77 chars a token
- Run 423, gpt-6-luna: 8 calls, 69039 in (67585 cached, 1430 written), 407 out, p50 1242 ms, p95 1984 ms; 3.74 chars a token
- Run 424, gpt-6-luna: 3 calls, 25139 in (24916 cached, 214 written), 87 out, p50 1475 ms, p95 1486 ms; 3.73 chars a token
- Run 425, gpt-6-luna: 2 calls, 16720 in (16549 cached, 165 written), 31 out, p50 1283 ms, p95 1419 ms; 3.73 chars a token
- Run 426, gpt-6-luna: 2 calls, 16850 in (16554 cached, 290 written), 40 out, p50 1208 ms, p95 1340 ms; 3.72 chars a token
- Run 427, gpt-6-luna: 1 calls, 8361 in (0 cached, 8358 written), 15 out, p50 1301 ms, p95 1301 ms; 3.72 chars a token
- Run 428, gpt-6-luna: 2 calls, 16930 in (16552 cached, 372 written), 52 out, p50 1564 ms, p95 1696 ms; 3.72 chars a token
- Run 429, gpt-6-luna: 2 calls, 16632 in (16551 cached, 75 written), 47 out, p50 1659 ms, p95 1945 ms; 3.73 chars a token
- Run 430, gpt-6-luna: 2 calls, 16737 in (16557 cached, 174 written), 37 out, p50 1310 ms, p95 1525 ms; 3.73 chars a token
- Run 431, gpt-6-luna: 2 calls, 16950 in (16554 cached, 390 written), 49 out, p50 1348 ms, p95 1401 ms; 3.71 chars a token
- Run 432, gpt-6-luna: 4 calls, 35544 in (34294 cached, 1238 written), 155 out, p50 1481 ms, p95 1548 ms; 3.72 chars a token
- Run 433, gpt-6-luna: 2 calls, 16722 in (8280 cached, 8436 written), 33 out, p50 1426 ms, p95 1909 ms; 3.73 chars a token
- Run 434, gpt-6-luna: 2 calls, 16932 in (16552 cached, 374 written), 72 out, p50 1275 ms, p95 1659 ms; 3.72 chars a token
- Run 435, gpt-6-luna: 3 calls, 25455 in (24923 cached, 523 written), 74 out, p50 1784 ms, p95 1887 ms; 3.72 chars a token
- Run 436, gpt-6-luna: 2 calls, 16718 in (16548 cached, 164 written), 34 out, p50 1192 ms, p95 1385 ms; 3.73 chars a token
- Run 437, gpt-6-luna: 3 calls, 25267 in (24985 cached, 273 written), 86 out, p50 1337 ms, p95 1540 ms; 3.73 chars a token
- Run 438, gpt-6-luna: 3 calls, 25503 in (24927 cached, 567 written), 105 out, p50 1628 ms, p95 2030 ms; 3.71 chars a token
- Run 439, gpt-6-luna: 2 calls, 16729 in (16551 cached, 172 written), 55 out, p50 1485 ms, p95 1924 ms; 3.73 chars a token
- Run 440, gpt-6-luna: 2 calls, 17046 in (8361 cached, 8679 written), 65 out, p50 1420 ms, p95 1572 ms; 3.71 chars a token
- Run 441, gpt-6-luna: 4 calls, 34798 in (25717 cached, 9069 written), 164 out, p50 1794 ms, p95 2387 ms; 3.71 chars a token
- Run 442, gpt-6-luna: 2 calls, 16634 in (16552 cached, 76 written), 41 out, p50 1411 ms, p95 1826 ms; 3.73 chars a token
- Run 443, gpt-6-luna: 2 calls, 16663 in (16552 cached, 105 written), 68 out, p50 1533 ms, p95 1769 ms; 3.73 chars a token
- Run 444, gpt-6-luna: 1 calls, 8286 in (8270 cached, 13 written), 24 out, p50 1492 ms, p95 1492 ms; 3.72 chars a token
- Run 445, gpt-6-luna: 3 calls, 25495 in (25037 cached, 449 written), 157 out, p50 1463 ms, p95 1902 ms; 3.73 chars a token
- Run 446, gpt-6-luna: 2 calls, 16726 in (16558 cached, 162 written), 42 out, p50 1303 ms, p95 1441 ms; 3.73 chars a token
- Run 447, gpt-6-luna: 2 calls, 16789 in (16551 cached, 232 written), 48 out, p50 1385 ms, p95 1469 ms; 3.74 chars a token
- Run 447, text-embedding-3-small: 1 calls, 2 in (0 cached, 0 written), 0 out, p50 730 ms, p95 730 ms; 3.74 chars a token
- Run 448, gpt-6-luna: 2 calls, 16795 in (16556 cached, 233 written), 47 out, p50 1314 ms, p95 1497 ms; 3.74 chars a token
- Run 449, gpt-6-luna: 2 calls, 16751 in (16552 cached, 193 written), 45 out, p50 1306 ms, p95 1798 ms; 3.74 chars a token
- Run 449, text-embedding-3-small: 1 calls, 3 in (0 cached, 0 written), 0 out, p50 533 ms, p95 533 ms; 3.74 chars a token
- Run 450, gpt-6-luna: 2 calls, 16688 in (16552 cached, 130 written), 55 out, p50 1786 ms, p95 2063 ms; 3.73 chars a token
- Run 451, gpt-6-luna: 2 calls, 16755 in (16554 cached, 195 written), 35 out, p50 1391 ms, p95 1638 ms; 3.74 chars a token
- Run 452, gpt-6-luna: 2 calls, 8620 in (8270 cached, 31 written), 271 out, p50 2480 ms, p95 3443 ms; 3.75 chars a token
- Run 452, text-embedding-3-small: 1 calls, 15 in (0 cached, 0 written), 0 out, p50 247 ms, p95 247 ms; 3.75 chars a token
- Run 453, gpt-6-luna: 2 calls, 16812 in (16554 cached, 252 written), 36 out, p50 1390 ms, p95 1687 ms; 3.74 chars a token
- Run 453, text-embedding-3-small: 1 calls, 4 in (0 cached, 0 written), 0 out, p50 553 ms, p95 553 ms; 3.74 chars a token
- Run 454, gpt-6-luna: 2 calls, 16685 in (8284 cached, 8395 written), 102 out, p50 1542 ms, p95 1662 ms; 3.73 chars a token
- Run 455, gpt-6-luna: 3 calls, 25608 in (25133 cached, 466 written), 141 out, p50 1575 ms, p95 1654 ms; 3.71 chars a token
- Run 456, gpt-6-luna: 2 calls, 16730 in (8293 cached, 8431 written), 102 out, p50 1962 ms, p95 2256 ms; 3.73 chars a token
- Run 457, gpt-6-luna: 2 calls, 16743 in (16560 cached, 177 written), 117 out, p50 1733 ms, p95 1869 ms; 3.73 chars a token
- Run 458, gpt-6-luna: 3 calls, 25573 in (25133 cached, 431 written), 115 out, p50 1503 ms, p95 1636 ms; 3.71 chars a token
- Run 459, gpt-6-luna: 3 calls, 25565 in (16851 cached, 8705 written), 134 out, p50 2968 ms, p95 3095 ms; 3.71 chars a token
- Run 460, gpt-6-luna: 1 calls, 8290 in (8270 cached, 17 written), 86 out, p50 2643 ms, p95 2643 ms; 3.72 chars a token
- Run 461, gpt-6-luna: 2 calls, 16799 in (16553 cached, 240 written), 53 out, p50 1488 ms, p95 2483 ms; 3.74 chars a token
- Run 462, gpt-6-luna: 2 calls, 16653 in (16552 cached, 95 written), 38 out, p50 1818 ms, p95 2234 ms; 3.73 chars a token
- Run 462, text-embedding-3-small: 1 calls, 6 in (0 cached, 0 written), 0 out, p50 737 ms, p95 737 ms; 3.73 chars a token
- Run 463, gpt-6-luna: 2 calls, 16883 in (8369 cached, 8508 written), 99 out, p50 1756 ms, p95 2947 ms; 3.73 chars a token
- Run 464, gpt-6-luna: 4 calls, 34214 in (33597 cached, 605 written), 130 out, p50 1809 ms, p95 3572 ms; 3.74 chars a token
- Run 464, gpt-6.1-sol: 1 calls, 9002 in (0 cached, 8999 written), 38 out, p50 2105 ms, p95 2105 ms; 3.74 chars a token
- Run 465, gpt-6-luna: 2 calls, 16778 in (16551 cached, 221 written), 42 out, p50 1170 ms, p95 1316 ms; 3.74 chars a token
- Run 465, text-embedding-3-small: 1 calls, 1 in (0 cached, 0 written), 0 out, p50 561 ms, p95 561 ms; 3.74 chars a token
- Run 466, gpt-6-luna: 2 calls, 16707 in (16561 cached, 140 written), 97 out, p50 1769 ms, p95 2009 ms; 3.73 chars a token
- Run 467, gpt-6-luna: 4 calls, 35793 in (34506 cached, 1275 written), 295 out, p50 1292 ms, p95 1770 ms; 3.67 chars a token
- Run 468, gpt-6-luna: 2 calls, 16845 in (16549 cached, 290 written), 73 out, p50 1604 ms, p95 1673 ms; 3.71 chars a token
- Run 469, gpt-6-luna: 4 calls, 34325 in (33570 cached, 743 written), 288 out, p50 1587 ms, p95 2236 ms; 3.93 chars a token
- Run 469, gpt-6.1-sol: 2 calls, 18538 in (9196 cached, 9336 written), 124 out, p50 2542 ms, p95 2793 ms; 3.93 chars a token
- Run 470, gpt-6-luna: 2 calls, 16670 in (16554 cached, 110 written), 62 out, p50 1367 ms, p95 1453 ms; 3.72 chars a token
- Run 471, gpt-6-luna: 2 calls, 16627 in (16554 cached, 67 written), 49 out, p50 1316 ms, p95 1613 ms; 3.73 chars a token
- Run 472, gpt-6-luna: 2 calls, 16625 in (16551 cached, 68 written), 36 out, p50 1375 ms, p95 1493 ms; 3.73 chars a token
- Run 473, gpt-6-luna: 2 calls, 16860 in (16553 cached, 301 written), 56 out, p50 1397 ms, p95 2304 ms; 3.71 chars a token
- Run 474, gpt-6-luna: 4 calls, 34086 in (33567 cached, 507 written), 147 out, p50 2170 ms, p95 2842 ms; 3.72 chars a token
- Run 475, gpt-6-luna: 4 calls, 34095 in (33569 cached, 514 written), 151 out, p50 1838 ms, p95 2348 ms; 3.72 chars a token
- Run 476, gpt-6-luna: 1 calls, 8302 in (8270 cached, 29 written), 35 out, p50 2953 ms, p95 2953 ms; 3.72 chars a token
- Run 477, gpt-6-luna: 1 calls, 8298 in (8270 cached, 25 written), 20 out, p50 2067 ms, p95 2067 ms; 3.72 chars a token
- Run 478, gpt-6-luna: 1 calls, 8291 in (8270 cached, 18 written), 34 out, p50 1782 ms, p95 1782 ms; 3.72 chars a token
- Run 479, gpt-6-luna: 1 calls, 8291 in (8270 cached, 18 written), 41 out, p50 1617 ms, p95 1617 ms; 3.72 chars a token
- Run 480, gpt-6-luna: 2 calls, 16656 in (16552 cached, 98 written), 39 out, p50 1678 ms, p95 1703 ms; 3.72 chars a token
- Run 481, gpt-6-luna: 1 calls, 8288 in (8270 cached, 15 written), 74 out, p50 1907 ms, p95 1907 ms; 3.72 chars a token
- Run 482, gpt-6-luna: 1 calls, 8289 in (8270 cached, 16 written), 40 out, p50 2027 ms, p95 2027 ms; 3.72 chars a token
- Run 483, gpt-6-luna: 4 calls, 35458 in (34175 cached, 1271 written), 415 out, p50 1774 ms, p95 3121 ms; 3.88 chars a token
- Run 484, gpt-6-luna: 1 calls, 8300 in (8270 cached, 27 written), 49 out, p50 1902 ms, p95 1902 ms; 3.72 chars a token
- Run 485, gpt-6-luna: 1 calls, 8308 in (8270 cached, 35 written), 93 out, p50 2240 ms, p95 2240 ms; 3.72 chars a token
- Run 486, gpt-6-luna: 1 calls, 8297 in (8270 cached, 24 written), 14 out, p50 1620 ms, p95 1620 ms; 3.72 chars a token
- Run 487, gpt-6-luna: 2 calls, 16856 in (16556 cached, 294 written), 103 out, p50 1554 ms, p95 2342 ms; 3.71 chars a token
- Run 488, gpt-6-luna: 3 calls, 25335 in (24912 cached, 414 written), 150 out, p50 1505 ms, p95 2083 ms; 3.81 chars a token
- Run 489, gpt-6-luna: 2 calls, 16678 in (16556 cached, 116 written), 68 out, p50 1408 ms, p95 1446 ms; 3.72 chars a token
- Run 490, gpt-6-luna: 2 calls, 16625 in (16551 cached, 68 written), 37 out, p50 1374 ms, p95 1916 ms; 3.73 chars a token
- Run 491, gpt-6-luna: 4 calls, 34157 in (33621 cached, 524 written), 144 out, p50 1929 ms, p95 4013 ms; 3.72 chars a token
- Run 492, gpt-6-luna: 2 calls, 17078 in (16559 cached, 513 written), 210 out, p50 1897 ms, p95 2902 ms; 3.87 chars a token
- Run 493, gpt-6-luna: 1 calls, 8330 in (0 cached, 8327 written), 32 out, p50 2270 ms, p95 2270 ms; 3.72 chars a token
- Run 494, gpt-6-luna: 4 calls, 34407 in (33778 cached, 617 written), 222 out, p50 1387 ms, p95 2117 ms; 3.77 chars a token
- Run 495, gpt-6-luna: 4 calls, 34301 in (33586 cached, 703 written), 194 out, p50 1497 ms, p95 2064 ms; 3.71 chars a token
- Run 496, gpt-6-luna: 4 calls, 34078 in (33557 cached, 509 written), 151 out, p50 1441 ms, p95 1801 ms; 3.72 chars a token
- Run 497, gpt-6-luna: 4 calls, 34141 in (33598 cached, 531 written), 156 out, p50 2024 ms, p95 2722 ms; 3.72 chars a token
- Run 498, gpt-6-luna: 2 calls, 16877 in (16550 cached, 321 written), 72 out, p50 1529 ms, p95 2200 ms; 3.71 chars a token
- Run 499, gpt-6-luna: 3 calls, 26156 in (25119 cached, 1028 written), 132 out, p50 1933 ms, p95 2952 ms; 3.68 chars a token
- Run 500, gpt-6-luna: 3 calls, 25312 in (24916 cached, 387 written), 89 out, p50 1609 ms, p95 1655 ms; 3.72 chars a token
- Run 501, gpt-6-luna: 3 calls, 26221 in (25114 cached, 1098 written), 196 out, p50 1865 ms, p95 2908 ms; 3.69 chars a token
- Run 502, gpt-6-luna: 3 calls, 25550 in (25117 cached, 424 written), 120 out, p50 1369 ms, p95 1687 ms; 3.71 chars a token
- Run 503, gpt-6-luna: 4 calls, 34229 in (33567 cached, 650 written), 165 out, p50 1550 ms, p95 2132 ms; 3.71 chars a token
- Run 503, gpt-6.1-sol: 1 calls, 9084 in (8270 cached, 811 written), 25 out, p50 2393 ms, p95 2393 ms; 3.71 chars a token
- Run 504, gpt-6-luna: 4 calls, 34381 in (33785 cached, 584 written), 189 out, p50 1697 ms, p95 1923 ms; 3.71 chars a token
- Run 505, gpt-6-luna: 4 calls, 35872 in (34558 cached, 1302 written), 326 out, p50 1614 ms, p95 3190 ms; 3.74 chars a token
- Run 506, gpt-6-luna: 3 calls, 25302 in (24915 cached, 378 written), 89 out, p50 1844 ms, p95 2118 ms; 3.72 chars a token
- Run 507, gpt-6-luna: 3 calls, 26463 in (25106 cached, 1348 written), 408 out, p50 1670 ms, p95 3668 ms; 3.70 chars a token
- Run 508, gpt-6-luna: 3 calls, 25796 in (25209 cached, 578 written), 190 out, p50 1678 ms, p95 2971 ms; 3.71 chars a token
- Run 509, gpt-6-luna: 4 calls, 35435 in (34317 cached, 1106 written), 293 out, p50 1895 ms, p95 2256 ms; 3.68 chars a token
- Run 510, gpt-6-luna: 4 calls, 34252 in (33588 cached, 652 written), 175 out, p50 1393 ms, p95 2613 ms; 3.72 chars a token
- Run 511, gpt-6-luna: 2 calls, 16882 in (16552 cached, 324 written), 45 out, p50 1851 ms, p95 2026 ms; 3.71 chars a token
- Run 512, gpt-6-luna: 3 calls, 25692 in (25123 cached, 560 written), 107 out, p50 1588 ms, p95 1792 ms; 3.70 chars a token
- Run 513, gpt-6-luna: 4 calls, 35819 in (34547 cached, 1260 written), 280 out, p50 1680 ms, p95 2209 ms; 3.69 chars a token
- Run 514, gpt-6-luna: 4 calls, 34328 in (25486 cached, 8830 written), 180 out, p50 1312 ms, p95 1915 ms; 3.72 chars a token
- Run 515, gpt-6-luna: 2 calls, 16875 in (8280 cached, 8589 written), 75 out, p50 1720 ms, p95 2607 ms; 3.71 chars a token
- Run 516, gpt-6-luna: 3 calls, 26095 in (25114 cached, 972 written), 156 out, p50 1661 ms, p95 1704 ms; 3.69 chars a token
- Run 517, gpt-6-luna: 3 calls, 26101 in (25121 cached, 971 written), 125 out, p50 1404 ms, p95 1881 ms; 3.69 chars a token
- Run 518, gpt-6-luna: 4 calls, 34312 in (33754 cached, 546 written), 156 out, p50 1371 ms, p95 1999 ms; 3.71 chars a token
- Run 519, gpt-6-luna: 3 calls, 25119 in (24908 cached, 202 written), 91 out, p50 1490 ms, p95 1518 ms; 3.73 chars a token
- Run 520, gpt-6-luna: 3 calls, 25288 in (24913 cached, 366 written), 87 out, p50 1324 ms, p95 1487 ms; 3.72 chars a token
- Run 521, gpt-6-luna: 3 calls, 25137 in (24915 cached, 213 written), 78 out, p50 1486 ms, p95 1548 ms; 3.73 chars a token
- Run 522, gpt-6-luna: 2 calls, 16645 in (16548 cached, 91 written), 47 out, p50 1322 ms, p95 1617 ms; 3.72 chars a token
- Run 523, gpt-6-luna: 2 calls, 16651 in (16551 cached, 94 written), 47 out, p50 1384 ms, p95 2889 ms; 3.72 chars a token
- Run 524, gpt-6-luna: 2 calls, 16833 in (16548 cached, 279 written), 24 out, p50 1327 ms, p95 1539 ms; 3.71 chars a token
- Run 525, gpt-6-luna: 2 calls, 16848 in (16550 cached, 292 written), 78 out, p50 1765 ms, p95 2045 ms; 3.71 chars a token
- Run 526, gpt-6-luna: 2 calls, 16678 in (16551 cached, 121 written), 42 out, p50 1346 ms, p95 1401 ms; 3.72 chars a token
- Run 527, gpt-6-luna: 2 calls, 16673 in (16551 cached, 116 written), 48 out, p50 1449 ms, p95 1469 ms; 3.73 chars a token
- Run 528, gpt-6-luna: 2 calls, 16651 in (16553 cached, 92 written), 35 out, p50 1408 ms, p95 1735 ms; 3.73 chars a token
- Run 529, gpt-6-luna: 3 calls, 25785 in (25212 cached, 564 written), 174 out, p50 1940 ms, p95 1992 ms; 3.71 chars a token
- Run 530, gpt-6-luna: 4 calls, 34406 in (33808 cached, 586 written), 186 out, p50 1378 ms, p95 1652 ms; 3.71 chars a token
- Run 531, gpt-6-luna: 4 calls, 34123 in (33582 cached, 529 written), 155 out, p50 1315 ms, p95 1980 ms; 3.72 chars a token
- Run 532, gpt-6-luna: 4 calls, 34238 in (33576 cached, 650 written), 166 out, p50 1845 ms, p95 2204 ms; 3.71 chars a token
- Run 532, gpt-6.1-sol: 1 calls, 9084 in (0 cached, 9081 written), 21 out, p50 1551 ms, p95 1551 ms; 3.71 chars a token
- Run 533, gpt-6-luna: 4 calls, 34124 in (33595 cached, 517 written), 147 out, p50 1418 ms, p95 2070 ms; 3.72 chars a token
- Run 534, gpt-6-luna: 4 calls, 34070 in (33561 cached, 497 written), 142 out, p50 2401 ms, p95 3109 ms; 3.72 chars a token
- Run 535, gpt-6-luna: 2 calls, 16657 in (16553 cached, 98 written), 75 out, p50 1708 ms, p95 1917 ms; 3.73 chars a token
- Run 536, gpt-6-luna: 3 calls, 25490 in (25101 cached, 380 written), 92 out, p50 2592 ms, p95 2972 ms; 3.71 chars a token
- Run 537, gpt-6-luna: 4 calls, 34736 in (33995 cached, 729 written), 145 out, p50 2194 ms, p95 3405 ms; 3.70 chars a token
- Run 538, gpt-6-luna: 4 calls, 34773 in (34018 cached, 743 written), 156 out, p50 1891 ms, p95 4008 ms; 3.80 chars a token
- Run 539, gpt-6-luna: 2 calls, 16670 in (16664 cached, 0 written), 69 out, p50 1387 ms, p95 2571 ms; 3.72 chars a token
- Run 540, gpt-6-luna: 3 calls, 25554 in (25122 cached, 423 written), 112 out, p50 2145 ms, p95 2421 ms; 3.71 chars a token
- Run 541, gpt-6-luna: 3 calls, 25151 in (24936 cached, 206 written), 76 out, p50 2769 ms, p95 2916 ms; 3.73 chars a token
- Run 542, gpt-6-luna: 3 calls, 25160 in (24946 cached, 205 written), 76 out, p50 2246 ms, p95 2320 ms; 3.73 chars a token
- Run 543, gpt-6-luna: 3 calls, 25120 in (24916 cached, 195 written), 96 out, p50 2670 ms, p95 4042 ms; 3.73 chars a token
- Run 544, gpt-6-luna: 2 calls, 16656 in (16554 cached, 96 written), 59 out, p50 2141 ms, p95 2393 ms; 3.73 chars a token
- Run 545, gpt-6-luna: 4 calls, 34123 in (33604 cached, 507 written), 147 out, p50 2586 ms, p95 3561 ms; 3.72 chars a token
- Run 546, gpt-6-luna: 2 calls, 16683 in (16553 cached, 124 written), 103 out, p50 3252 ms, p95 3845 ms; 3.73 chars a token
- Run 547, gpt-6-luna: 6 calls, 50773 in (50113 cached, 642 written), 136 out, p50 1804 ms, p95 2772 ms; 3.73 chars a token
- Run 548, gpt-6-luna: 4 calls, 33824 in (33275 cached, 537 written), 186 out, p50 2314 ms, p95 2903 ms; 3.74 chars a token
- Run 549, gpt-6-luna: 4 calls, 34066 in (33231 cached, 823 written), 222 out, p50 1784 ms, p95 2657 ms; 3.80 chars a token
- Run 550, gpt-6-luna: 5 calls, 42196 in (41477 cached, 704 written), 220 out, p50 2717 ms, p95 3572 ms; 3.72 chars a token
- Run 551, gpt-6-luna: 3 calls, 25192 in (24837 cached, 346 written), 68 out, p50 3829 ms, p95 4804 ms; 3.73 chars a token
- Run 552, gpt-6-luna: 2 calls, 16666 in (8270 cached, 8390 written), 30 out, p50 1485 ms, p95 2451 ms; 3.72 chars a token
- Run 553, gpt-6-luna: 3 calls, 25368 in (24852 cached, 507 written), 109 out, p50 2340 ms, p95 2561 ms; 3.72 chars a token
- Run 554, gpt-6-luna: 4 calls, 35004 in (33607 cached, 1385 written), 237 out, p50 2488 ms, p95 2758 ms; 3.71 chars a token
- Run 555, gpt-6-luna: 5 calls, 42227 in (41693 cached, 519 written), 138 out, p50 1310 ms, p95 1903 ms; 3.74 chars a token
- Run 556, gpt-6-luna: 5 calls, 33896 in (24947 cached, 8631 written), 238 out, p50 1793 ms, p95 6990 ms; 3.74 chars a token
- Run 556, text-embedding-3-small: 2 calls, 29 in (0 cached, 0 written), 0 out, p50 391 ms, p95 536 ms; 3.74 chars a token
- Run 557, gpt-6-luna: 6 calls, 52817 in (42869 cached, 9930 written), 396 out, p50 2447 ms, p95 4605 ms; 3.78 chars a token
- Run 558, gpt-6-luna: 5 calls, 43214 in (42475 cached, 724 written), 407 out, p50 1950 ms, p95 4321 ms; 3.87 chars a token
- Run 559, gpt-6-luna: 3 calls, 25058 in (24913 cached, 136 written), 106 out, p50 1472 ms, p95 1525 ms; 3.73 chars a token
- Run 560, gpt-6-luna: 2 calls, 16851 in (16567 cached, 278 written), 58 out, p50 2921 ms, p95 2948 ms; 3.74 chars a token
- Run 561, gpt-6-luna: 6 calls, 50483 in (41760 cached, 8705 written), 193 out, p50 1475 ms, p95 3133 ms; 3.73 chars a token
- Run 562, gpt-6-luna: 5 calls, 42346 in (41848 cached, 483 written), 148 out, p50 1663 ms, p95 1986 ms; 3.72 chars a token
- Run 563, gpt-6-luna: 8 calls, 69036 in (67360 cached, 1652 written), 254 out, p50 1352 ms, p95 1931 ms; 3.72 chars a token
- Run 564, gpt-6-luna: 3 calls, 25058 in (24935 cached, 114 written), 174 out, p50 2145 ms, p95 3039 ms; 3.73 chars a token
- Run 565, gpt-6-luna: 6 calls, 50824 in (50052 cached, 754 written), 212 out, p50 1550 ms, p95 2468 ms; 3.73 chars a token
- Run 566, gpt-6-luna: 6 calls, 50473 in (41753 cached, 8702 written), 190 out, p50 1400 ms, p95 1663 ms; 3.73 chars a token
- Run 567, gpt-6-luna: 6 calls, 51833 in (42415 cached, 9400 written), 282 out, p50 1441 ms, p95 2007 ms; 3.72 chars a token
- Run 568, gpt-6-luna: 5 calls, 42528 in (33577 cached, 8936 written), 237 out, p50 1690 ms, p95 3150 ms; 3.72 chars a token
- Run 569, gpt-6-luna: 5 calls, 42506 in (41879 cached, 612 written), 235 out, p50 1615 ms, p95 2483 ms; 3.72 chars a token
- Run 570, gpt-6-luna: 3 calls, 25683 in (16929 cached, 8745 written), 136 out, p50 1383 ms, p95 1779 ms; 3.71 chars a token
- Run 571, gpt-6-luna: 6 calls, 52599 in (43064 cached, 9517 written), 392 out, p50 1638 ms, p95 3197 ms; 3.79 chars a token
- Run 572, gpt-6-luna: 5 calls, 43392 in (42666 cached, 711 written), 392 out, p50 1849 ms, p95 2805 ms; 3.87 chars a token
- Run 573, gpt-6-luna: 4 calls, 34305 in (25352 cached, 8941 written), 300 out, p50 1474 ms, p95 2224 ms; 3.71 chars a token
- Run 574, gpt-6-luna: 8 calls, 68882 in (67640 cached, 1218 written), 349 out, p50 1329 ms, p95 1808 ms; 3.72 chars a token
- Run 575, gpt-6-luna: 6 calls, 51197 in (42036 cached, 9143 written), 215 out, p50 1432 ms, p95 1925 ms; 3.72 chars a token
- Run 576, gpt-6-luna: 6 calls, 51707 in (50267 cached, 1422 written), 226 out, p50 1257 ms, p95 1940 ms; 3.70 chars a token
- Run 577, gpt-6-luna: 5 calls, 42410 in (41864 cached, 531 written), 184 out, p50 1224 ms, p95 2072 ms; 3.71 chars a token
- Run 578, gpt-6-luna: 8 calls, 68934 in (59353 cached, 9557 written), 353 out, p50 1491 ms, p95 2114 ms; 3.71 chars a token
- Run 578, gpt-6.1-sol: 1 calls, 9129 in (0 cached, 9126 written), 22 out, p50 1922 ms, p95 1922 ms; 3.71 chars a token
- Run 579, gpt-6-luna: 7 calls, 61463 in (59718 cached, 1724 written), 392 out, p50 1525 ms, p95 2196 ms; 3.69 chars a token
- Run 580, gpt-6-luna: 7 calls, 61198 in (59160 cached, 2017 written), 630 out, p50 1487 ms, p95 3714 ms; 3.70 chars a token
- Run 581, gpt-6-luna: 8 calls, 69253 in (67696 cached, 1533 written), 412 out, p50 1434 ms, p95 2534 ms; 3.71 chars a token
- Run 581, gpt-6.1-sol: 1 calls, 9371 in (8307 cached, 1061 written), 40 out, p50 3169 ms, p95 3169 ms; 3.71 chars a token
- Run 582, gpt-6-luna: 6 calls, 51434 in (50460 cached, 956 written), 182 out, p50 1274 ms, p95 1542 ms; 3.71 chars a token
- Run 583, gpt-6-luna: 8 calls, 70489 in (60277 cached, 10188 written), 532 out, p50 1432 ms, p95 2213 ms; 3.70 chars a token
- Run 583, gpt-6.1-sol: 1 calls, 9073 in (0 cached, 9070 written), 38 out, p50 1883 ms, p95 1883 ms; 3.70 chars a token
- Run 584, gpt-6-luna: 5 calls, 43197 in (25240 cached, 17942 written), 203 out, p50 1313 ms, p95 2092 ms; 3.70 chars a token
- Run 585, gpt-6-luna: 7 calls, 60815 in (59163 cached, 1631 written), 339 out, p50 1207 ms, p95 1615 ms; 3.73 chars a token
- Run 586, gpt-6-luna: 6 calls, 50637 in (50044 cached, 575 written), 167 out, p50 1266 ms, p95 1437 ms; 3.73 chars a token
- Run 587, gpt-6-luna: 5 calls, 41963 in (41647 cached, 301 written), 119 out, p50 1110 ms, p95 1442 ms; 3.73 chars a token
- Run 588, gpt-6-luna: 5 calls, 42509 in (41827 cached, 667 written), 109 out, p50 1210 ms, p95 1516 ms; 3.71 chars a token
- Run 589, gpt-6-luna: 6 calls, 51382 in (50528 cached, 836 written), 199 out, p50 1062 ms, p95 1465 ms; 3.71 chars a token
- Run 590, gpt-6-luna: 7 calls, 60252 in (59088 cached, 1143 written), 353 out, p50 1278 ms, p95 1516 ms; 3.71 chars a token
- Run 591, gpt-6-luna: 8 calls, 68637 in (67440 cached, 1173 written), 312 out, p50 1211 ms, p95 3057 ms; 3.72 chars a token
- Run 591, gpt-6.1-sol: 1 calls, 9131 in (0 cached, 9128 written), 29 out, p50 2220 ms, p95 2220 ms; 3.72 chars a token
- Run 592, gpt-6-luna: 6 calls, 50970 in (50349 cached, 603 written), 218 out, p50 1169 ms, p95 1272 ms; 3.72 chars a token
- Run 593, gpt-6-luna: 7 calls, 60571 in (59399 cached, 1151 written), 232 out, p50 989 ms, p95 1240 ms; 3.70 chars a token
- Run 594, gpt-6-luna: 7 calls, 60137 in (59186 cached, 930 written), 234 out, p50 1202 ms, p95 1618 ms; 3.71 chars a token
- Run 595, gpt-6-luna: 6 calls, 51016 in (50388 cached, 610 written), 216 out, p50 1140 ms, p95 1885 ms; 3.72 chars a token
- Run 596, gpt-6-luna: 2 calls, 16785 in (16627 cached, 152 written), 102 out, p50 1324 ms, p95 1407 ms; 3.73 chars a token
- Run 597, gpt-6-luna: 3 calls, 25655 in (25227 cached, 419 written), 63 out, p50 1311 ms, p95 1469 ms; 3.71 chars a token
- Run 598, gpt-6-luna: 5 calls, 43400 in (42716 cached, 669 written), 249 out, p50 1362 ms, p95 2340 ms; 3.77 chars a token
- Run 599, gpt-6-luna: 3 calls, 25254 in (24935 cached, 310 written), 96 out, p50 1361 ms, p95 1868 ms; 3.71 chars a token
- Run 600, gpt-6-luna: 6 calls, 53033 in (42977 cached, 10038 written), 367 out, p50 1465 ms, p95 3630 ms; 3.72 chars a token
- Run 601, gpt-6-luna: 4 calls, 33830 in (16631 cached, 17187 written), 129 out, p50 1500 ms, p95 1632 ms; 3.71 chars a token
- Run 602, gpt-6-luna: 7 calls, 60239 in (59205 cached, 1013 written), 287 out, p50 1522 ms, p95 1700 ms; 3.71 chars a token
- Run 603, gpt-6-luna: 6 calls, 51329 in (42214 cached, 9097 written), 280 out, p50 1359 ms, p95 2191 ms; 3.76 chars a token
- Run 604, gpt-6-luna: 8 calls, 70011 in (68316 cached, 1671 written), 445 out, p50 1304 ms, p95 2260 ms; 3.70 chars a token
- Run 605, gpt-6-luna: 4 calls, 34267 in (33738 cached, 517 written), 143 out, p50 1253 ms, p95 1436 ms; 3.72 chars a token
- Run 606, gpt-6-luna: 5 calls, 43091 in (42522 cached, 554 written), 173 out, p50 1260 ms, p95 1341 ms; 3.73 chars a token
- Run 607, gpt-6-luna: 5 calls, 42601 in (41817 cached, 769 written), 303 out, p50 1492 ms, p95 1758 ms; 3.72 chars a token
- Run 607, gpt-6.1-sol: 1 calls, 9325 in (8307 cached, 1015 written), 45 out, p50 2637 ms, p95 2637 ms; 3.72 chars a token
- Run 608, gpt-6-luna: 5 calls, 42404 in (41867 cached, 522 written), 168 out, p50 1280 ms, p95 1499 ms; 3.71 chars a token
- Run 609, gpt-6-luna: 8 calls, 68758 in (67504 cached, 1230 written), 456 out, p50 1192 ms, p95 3129 ms; 3.76 chars a token
- Run 610, gpt-6-luna: 5 calls, 42634 in (41861 cached, 758 written), 167 out, p50 1380 ms, p95 1444 ms; 3.71 chars a token
- Run 611, gpt-6-luna: 7 calls, 60030 in (58949 cached, 1060 written), 285 out, p50 1294 ms, p95 1788 ms; 3.72 chars a token
- Run 612, gpt-6-luna: 7 calls, 60277 in (59157 cached, 1099 written), 323 out, p50 1237 ms, p95 2337 ms; 3.74 chars a token
- Run 613, gpt-6-luna: 5 calls, 41984 in (41647 cached, 322 written), 146 out, p50 1270 ms, p95 2058 ms; 3.73 chars a token
- Run 614, gpt-6-luna: 5 calls, 42389 in (41849 cached, 525 written), 176 out, p50 1459 ms, p95 2017 ms; 3.72 chars a token
- Run 615, gpt-6-luna: 5 calls, 42026 in (41681 cached, 330 written), 121 out, p50 1356 ms, p95 1571 ms; 3.73 chars a token
- Run 616, gpt-6-luna: 4 calls, 33509 in (33254 cached, 243 written), 152 out, p50 1230 ms, p95 1828 ms; 3.78 chars a token
- Run 617, gpt-6-luna: 6 calls, 51402 in (50569 cached, 815 written), 302 out, p50 1354 ms, p95 2155 ms; 3.72 chars a token
- Run 618, gpt-6-luna: 2 calls, 16744 in (16626 cached, 112 written), 67 out, p50 1114 ms, p95 1208 ms; 3.73 chars a token
- Run 624, gpt-6-luna: 3 calls, 25961 in (25151 cached, 801 written), 110 out, p50 1415 ms, p95 1969 ms; 3.72 chars a token
- Run 625, gpt-6-luna: 4 calls, 34712 in (34026 cached, 674 written), 191 out, p50 1407 ms, p95 1830 ms; 3.71 chars a token
- Run 626, gpt-6-luna: 6 calls, 52249 in (50810 cached, 1421 written), 417 out, p50 1720 ms, p95 2099 ms; 3.71 chars a token
- Run 627, gpt-6-luna: 6 calls, 51026 in (50349 cached, 659 written), 136 out, p50 1311 ms, p95 1748 ms; 3.72 chars a token
- Run 628, gpt-6-luna: 5 calls, 42094 in (41651 cached, 428 written), 156 out, p50 1544 ms, p95 2526 ms; 3.78 chars a token
- Run 629, gpt-6-luna: 3 calls, 25326 in (16628 cached, 8689 written), 55 out, p50 1381 ms, p95 2088 ms; 3.72 chars a token
- Run 630, gpt-6-luna: 4 calls, 33722 in (33251 cached, 459 written), 112 out, p50 1409 ms, p95 1800 ms; 3.72 chars a token
- Run 631, gpt-6-luna: 4 calls, 33826 in (33259 cached, 555 written), 80 out, p50 1453 ms, p95 1641 ms; 3.72 chars a token
- Run 632, gpt-6-luna: 6 calls, 52248 in (42762 cached, 9468 written), 259 out, p50 1363 ms, p95 2359 ms; 3.76 chars a token
- Run 632, gpt-6.1-sol: 1 calls, 9707 in (0 cached, 9704 written), 25 out, p50 1792 ms, p95 1792 ms; 3.76 chars a token
- Run 633, gpt-6-luna: 2 calls, 17009 in (16626 cached, 377 written), 75 out, p50 3009 ms, p95 4402 ms; 3.72 chars a token
- Run 634, gpt-6-luna: 5 calls, 42609 in (41970 cached, 624 written), 167 out, p50 1481 ms, p95 1796 ms; 3.79 chars a token
- Run 635, gpt-6-luna: 4 calls, 34177 in (33378 cached, 787 written), 187 out, p50 1377 ms, p95 1797 ms; 3.79 chars a token
- Run 636, gpt-6-luna: 5 calls, 42365 in (41662 cached, 688 written), 148 out, p50 1424 ms, p95 1717 ms; 3.72 chars a token
- Run 637, gpt-6-luna: 4 calls, 33987 in (33444 cached, 531 written), 127 out, p50 1277 ms, p95 2218 ms; 3.81 chars a token
- Run 638, gpt-6-luna: 2 calls, 16742 in (8307 cached, 8429 written), 34 out, p50 1367 ms, p95 1599 ms; 3.73 chars a token
- Run 639, gpt-6-luna: 3 calls, 25466 in (24963 cached, 494 written), 103 out, p50 1532 ms, p95 2495 ms; 3.73 chars a token
- Run 640, gpt-6-luna: 4 calls, 34710 in (33882 cached, 816 written), 173 out, p50 1588 ms, p95 2318 ms; 3.77 chars a token
- Run 641, gpt-6-luna: 5 calls, 43563 in (42215 cached, 1333 written), 216 out, p50 1397 ms, p95 1719 ms; 3.73 chars a token
- Run 642, gpt-6-luna: 2 calls, 16790 in (16622 cached, 162 written), 39 out, p50 1469 ms, p95 1475 ms; 3.73 chars a token
- Run 643, gpt-6-luna: 5 calls, 42388 in (41869 cached, 504 written), 134 out, p50 1298 ms, p95 2173 ms; 3.75 chars a token
- Run 644, gpt-6-luna: 6 calls, 50971 in (50129 cached, 824 written), 181 out, p50 1560 ms, p95 3027 ms; 3.73 chars a token
- Run 645, gpt-6-luna: 4 calls, 33898 in (25019 cached, 8867 written), 139 out, p50 1624 ms, p95 1723 ms; 3.72 chars a token
- Run 646, gpt-6-luna: 6 calls, 51646 in (42426 cached, 9202 written), 250 out, p50 1381 ms, p95 1636 ms; 3.76 chars a token
- Run 647, gpt-6-luna: 3 calls, 25060 in (24933 cached, 118 written), 151 out, p50 1588 ms, p95 2217 ms; 3.73 chars a token
- Run 648, gpt-6-luna: 5 calls, 42398 in (41779 cached, 604 written), 181 out, p50 1543 ms, p95 2063 ms; 3.73 chars a token
- Run 649, gpt-6-luna: 4 calls, 33732 in (33255 cached, 465 written), 97 out, p50 1577 ms, p95 1710 ms; 3.74 chars a token
- Run 650, gpt-6-luna: 4 calls, 33586 in (33252 cached, 322 written), 85 out, p50 1364 ms, p95 5725 ms; 3.74 chars a token
- Run 651, gpt-6-luna: 2 calls, 16829 in (16628 cached, 195 written), 35 out, p50 2171 ms, p95 3280 ms; 3.74 chars a token
- Run 652, gpt-6-luna: 5 calls, 34040 in (25057 cached, 8665 written), 242 out, p50 1519 ms, p95 3165 ms; 3.74 chars a token
- Run 653, gpt-6-luna: 4 calls, 25552 in (24935 cached, 282 written), 333 out, p50 2320 ms, p95 5471 ms; 3.75 chars a token
- Run 653, text-embedding-3-small: 1 calls, 17 in (0 cached, 0 written), 0 out, p50 580 ms, p95 580 ms; 3.75 chars a token
- Run 659, gpt-6-luna: 2 calls, 16869 in (16627 cached, 236 written), 71 out, p50 1390 ms, p95 2095 ms; 3.74 chars a token
- Run 659, text-embedding-3-small: 1 calls, 5 in (0 cached, 0 written), 0 out, p50 475 ms, p95 475 ms; 3.74 chars a token
- Run 660, gpt-6-luna: 4 calls, 33682 in (25032 cached, 8638 written), 126 out, p50 1069 ms, p95 1494 ms; 3.73 chars a token
- Run 661, gpt-6-luna: 6 calls, 51224 in (50377 cached, 829 written), 202 out, p50 1493 ms, p95 1980 ms; 3.77 chars a token
- Run 661, text-embedding-3-small: 1 calls, 3 in (0 cached, 0 written), 0 out, p50 218 ms, p95 218 ms; 3.77 chars a token
- Run 661, gpt-6.1-sol: 1 calls, 9076 in (8307 cached, 766 written), 42 out, p50 1967 ms, p95 1967 ms; 3.77 chars a token
- Run 662, gpt-6-luna: 6 calls, 51215 in (50529 cached, 668 written), 276 out, p50 1560 ms, p95 1763 ms; 3.72 chars a token
- Run 663, gpt-6-luna: 6 calls, 51328 in (50328 cached, 982 written), 265 out, p50 1424 ms, p95 1769 ms; 3.85 chars a token
- Run 663, gpt-6.1-sol: 2 calls, 18458 in (9154 cached, 9298 written), 128 out, p50 2583 ms, p95 2754 ms; 3.85 chars a token
- Run 664, gpt-6-luna: 4 calls, 33445 in (33256 cached, 177 written), 117 out, p50 1347 ms, p95 1679 ms; 3.73 chars a token
- Run 665, gpt-6-luna: 4 calls, 33628 in (33252 cached, 364 written), 85 out, p50 1334 ms, p95 1554 ms; 3.72 chars a token
- Run 666, gpt-6-luna: 8 calls, 68477 in (67433 cached, 1020 written), 299 out, p50 1422 ms, p95 2132 ms; 3.72 chars a token
- Run 667, gpt-6-luna: 2 calls, 16674 in (16614 cached, 54 written), 56 out, p50 1353 ms, p95 2050 ms; 3.72 chars a token
- Run 668, gpt-6-luna: 2 calls, 16656 in (16614 cached, 36 written), 73 out, p50 1454 ms, p95 1643 ms; 3.72 chars a token
- Run 669, gpt-6-luna: 3 calls, 25055 in (24933 cached, 113 written), 140 out, p50 1584 ms, p95 1947 ms; 3.72 chars a token
- Run 670, gpt-6-luna: 5 calls, 43906 in (42621 cached, 1270 written), 440 out, p50 1592 ms, p95 4531 ms; 3.85 chars a token
- Run 671, gpt-6-luna: 2 calls, 16682 in (16614 cached, 62 written), 120 out, p50 1432 ms, p95 1806 ms; 3.72 chars a token
- Run 672, gpt-6-luna: 1 calls, 8334 in (8307 cached, 24 written), 14 out, p50 1216 ms, p95 1216 ms; 3.72 chars a token
- Run 673, gpt-6-luna: 3 calls, 25169 in (25024 cached, 136 written), 122 out, p50 1538 ms, p95 1599 ms; 3.73 chars a token
- Run 674, gpt-6-luna: 4 calls, 33731 in (33333 cached, 386 written), 203 out, p50 1382 ms, p95 2201 ms; 3.72 chars a token
- Run 675, gpt-6-luna: 4 calls, 33451 in (33255 cached, 184 written), 108 out, p50 1443 ms, p95 3414 ms; 3.73 chars a token
- Run 676, gpt-6-luna: 6 calls, 51027 in (50392 cached, 617 written), 203 out, p50 1312 ms, p95 1807 ms; 3.73 chars a token
- Run 677, gpt-6-luna: 1 calls, 8367 in (0 cached, 8364 written), 42 out, p50 4110 ms, p95 4110 ms; 3.72 chars a token
- Run 693, gpt-6-luna: 2 calls, 16748 in (16625 cached, 117 written), 36 out, p50 1716 ms, p95 1760 ms; 3.72 chars a token
- Run 694, gpt-6-luna: 4 calls, 33473 in (33252 cached, 209 written), 79 out, p50 1139 ms, p95 1199 ms; 3.73 chars a token
- Run 700, gpt-6-luna: 5 calls, 42407 in (41971 cached, 421 written), 180 out, p50 1731 ms, p95 2079 ms; 3.72 chars a token
- Run 701, gpt-6-luna: 6 calls, 50539 in (50106 cached, 415 written), 153 out, p50 1216 ms, p95 2453 ms; 3.73 chars a token
- Run 704, gpt-6-luna: 3 calls, 25771 in (16989 cached, 8773 written), 63 out, p50 1791 ms, p95 2082 ms; 3.71 chars a token
- Run 705, gpt-6-luna: 5 calls, 43541 in (42879 cached, 647 written), 209 out, p50 1405 ms, p95 2331 ms; 3.76 chars a token
- Run 706, gpt-6-luna: 3 calls, 25335 in (25022 cached, 304 written), 122 out, p50 1857 ms, p95 2123 ms; 3.72 chars a token
- Run 707, gpt-6-luna: 6 calls, 51541 in (42191 cached, 9332 written), 289 out, p50 1464 ms, p95 2454 ms; 3.75 chars a token
- Run 708, gpt-6-luna: 4 calls, 33921 in (16689 cached, 17220 written), 133 out, p50 1585 ms, p95 2070 ms; 3.72 chars a token
- Run 709, gpt-6-luna: 7 calls, 60355 in (59357 cached, 977 written), 305 out, p50 1328 ms, p95 1717 ms; 3.78 chars a token
- Run 710, gpt-6-luna: 5 calls, 42592 in (33657 cached, 8920 written), 195 out, p50 1659 ms, p95 2039 ms; 3.72 chars a token
- Run 711, gpt-6-luna: 8 calls, 69425 in (68115 cached, 1286 written), 390 out, p50 1535 ms, p95 2781 ms; 3.71 chars a token
- Run 712, gpt-6-luna: 8 calls, 68778 in (67700 cached, 1054 written), 303 out, p50 1397 ms, p95 1722 ms; 3.72 chars a token
- Run 713, gpt-6-luna: 5 calls, 43355 in (33661 cached, 9679 written), 205 out, p50 1659 ms, p95 1711 ms; 3.70 chars a token
- Run 714, gpt-6-luna: 5 calls, 42293 in (41798 cached, 480 written), 161 out, p50 1339 ms, p95 1668 ms; 3.72 chars a token
- Run 715, gpt-6-luna: 7 calls, 60282 in (59161 cached, 1100 written), 287 out, p50 1483 ms, p95 1922 ms; 3.71 chars a token
- Run 715, gpt-6.1-sol: 1 calls, 9176 in (0 cached, 9173 written), 18 out, p50 1545 ms, p95 1545 ms; 3.71 chars a token
- Run 716, gpt-6-luna: 8 calls, 70886 in (60526 cached, 10336 written), 568 out, p50 1548 ms, p95 2717 ms; 3.75 chars a token
- Run 717, gpt-6-luna: 6 calls, 52203 in (50420 cached, 1765 written), 515 out, p50 1341 ms, p95 3361 ms; 3.71 chars a token
- Run 718, gpt-6-luna: 8 calls, 69276 in (68091 cached, 1161 written), 372 out, p50 1970 ms, p95 3939 ms; 3.72 chars a token
- Run 719, gpt-6-luna: 7 calls, 60252 in (59172 cached, 1059 written), 270 out, p50 1489 ms, p95 1761 ms; 3.72 chars a token
- Run 720, gpt-6-luna: 7 calls, 60909 in (59183 cached, 1705 written), 366 out, p50 1577 ms, p95 1811 ms; 3.69 chars a token
- Run 720, gpt-6.1-sol: 1 calls, 9673 in (8336 cached, 1334 written), 39 out, p50 2131 ms, p95 2131 ms; 3.69 chars a token
- Run 721, gpt-6-luna: 6 calls, 51666 in (34057 cached, 17591 written), 263 out, p50 1524 ms, p95 2150 ms; 3.71 chars a token
- Run 722, gpt-6-luna: 6 calls, 52241 in (42317 cached, 9906 written), 271 out, p50 1532 ms, p95 2002 ms; 3.69 chars a token
- Run 723, gpt-6-luna: 7 calls, 59918 in (59124 cached, 773 written), 255 out, p50 1446 ms, p95 1558 ms; 3.75 chars a token
- Run 724, gpt-6-luna: 6 calls, 50822 in (50223 cached, 581 written), 171 out, p50 1231 ms, p95 1555 ms; 3.73 chars a token
- Run 725, gpt-6-luna: 5 calls, 42495 in (41991 cached, 489 written), 131 out, p50 1251 ms, p95 1490 ms; 3.72 chars a token
- Run 726, gpt-6-luna: 4 calls, 33961 in (33362 cached, 587 written), 87 out, p50 1241 ms, p95 1487 ms; 3.71 chars a token
- Run 727, gpt-6-luna: 7 calls, 60617 in (59458 cached, 1138 written), 342 out, p50 1595 ms, p95 1785 ms; 3.71 chars a token
- Run 728, gpt-6-luna: 8 calls, 68963 in (67697 cached, 1242 written), 357 out, p50 1405 ms, p95 2738 ms; 3.74 chars a token
- Run 728, gpt-6.1-sol: 1 calls, 9184 in (0 cached, 9181 written), 21 out, p50 1528 ms, p95 1528 ms; 3.74 chars a token
- Run 729, gpt-6-luna: 8 calls, 68770 in (67702 cached, 1044 written), 284 out, p50 1469 ms, p95 1878 ms; 3.72 chars a token
- Run 730, gpt-6-luna: 5 calls, 42516 in (41999 cached, 502 written), 160 out, p50 1396 ms, p95 2042 ms; 3.72 chars a token
- Run 731, gpt-6-luna: 8 calls, 70132 in (68603 cached, 1505 written), 286 out, p50 1360 ms, p95 1743 ms; 3.69 chars a token
- Run 732, gpt-6-luna: 5 calls, 42802 in (42017 cached, 770 written), 195 out, p50 3321 ms, p95 3688 ms; 3.71 chars a token
- Run 733, gpt-6-luna: 7 calls, 60190 in (59140 cached, 1029 written), 262 out, p50 2250 ms, p95 2542 ms; 3.72 chars a token
- Run 734, gpt-6-luna: 7 calls, 60434 in (59352 cached, 1061 written), 311 out, p50 1502 ms, p95 1987 ms; 3.71 chars a token
- Run 735, gpt-6-luna: 5 calls, 42137 in (41794 cached, 328 written), 130 out, p50 1476 ms, p95 1855 ms; 3.73 chars a token
- Run 736, gpt-6-luna: 5 calls, 42529 in (41991 cached, 523 written), 173 out, p50 1280 ms, p95 2286 ms; 3.72 chars a token
- Run 737, gpt-6-luna: 5 calls, 42170 in (41827 cached, 328 written), 122 out, p50 1395 ms, p95 1459 ms; 3.73 chars a token
- Run 738, gpt-6-luna: 4 calls, 33619 in (33370 cached, 237 written), 147 out, p50 1564 ms, p95 1863 ms; 3.78 chars a token
- Run 739, gpt-6-luna: 6 calls, 51589 in (50755 cached, 816 written), 293 out, p50 1454 ms, p95 2267 ms; 3.72 chars a token
- Run 740, gpt-6-luna: 5 calls, 42120 in (33463 cached, 8642 written), 165 out, p50 1314 ms, p95 1680 ms; 3.73 chars a token
- Run 741, gpt-6-luna: 5 calls, 42124 in (41811 cached, 298 written), 157 out, p50 1378 ms, p95 1748 ms; 3.73 chars a token
- Run 742, gpt-6-luna: 7 calls, 60443 in (59359 cached, 1063 written), 240 out, p50 1360 ms, p95 1659 ms; 3.71 chars a token
- Run 743, gpt-6-luna: 6 calls, 51321 in (50246 cached, 1057 written), 204 out, p50 1407 ms, p95 1980 ms; 3.73 chars a token
- Run 744, gpt-6-luna: 5 calls, 43134 in (42305 cached, 814 written), 286 out, p50 1713 ms, p95 2451 ms; 3.76 chars a token
- Run 745, gpt-6-luna: 6 calls, 50649 in (41892 cached, 8739 written), 197 out, p50 1205 ms, p95 1994 ms; 3.74 chars a token
- Run 746, gpt-6-luna: 5 calls, 42185 in (33474 cached, 8696 written), 201 out, p50 1459 ms, p95 1691 ms; 3.73 chars a token
- Run 747, gpt-6-luna: 5 calls, 42628 in (33671 cached, 8942 written), 242 out, p50 1679 ms, p95 1845 ms; 3.72 chars a token
- Run 748, gpt-6-luna: 5 calls, 42607 in (42037 cached, 555 written), 199 out, p50 1625 ms, p95 2222 ms; 3.72 chars a token
- Run 749, gpt-6-luna: 3 calls, 25754 in (16980 cached, 8765 written), 135 out, p50 1305 ms, p95 1909 ms; 3.72 chars a token
- Run 750, gpt-6-luna: 5 calls, 43955 in (34317 cached, 9623 written), 458 out, p50 2441 ms, p95 3719 ms; 3.80 chars a token
- Run 751, gpt-6-luna: 5 calls, 43601 in (42705 cached, 881 written), 431 out, p50 1715 ms, p95 2355 ms; 3.89 chars a token
- Run 752, gpt-6-luna: 3 calls, 25161 in (25019 cached, 133 written), 116 out, p50 1579 ms, p95 2153 ms; 3.72 chars a token
- Run 753, gpt-6-luna: 4 calls, 33608 in (33479 cached, 117 written), 114 out, p50 1369 ms, p95 1557 ms; 3.73 chars a token
- Run 754, gpt-6-luna: 6 calls, 51095 in (50452 cached, 625 written), 189 out, p50 1326 ms, p95 1728 ms; 3.72 chars a token
- Run 755, gpt-6-luna: 6 calls, 50694 in (50264 cached, 412 written), 174 out, p50 1276 ms, p95 1473 ms; 3.73 chars a token
- Run 756, gpt-6-luna: 6 calls, 51164 in (50549 cached, 597 written), 211 out, p50 1273 ms, p95 1582 ms; 3.73 chars a token
- Run 757, gpt-6-luna: 2 calls, 16843 in (16685 cached, 152 written), 89 out, p50 1448 ms, p95 1576 ms; 3.73 chars a token
- Run 758, gpt-6-luna: 22 calls, 189872 in (186467 cached, 3339 written), 1103 out, p50 1495 ms, p95 2042 ms; 3.74 chars a token
- Run 759, gpt-6-luna: 12 calls, 103084 in (101570 cached, 1478 written), 421 out, p50 1184 ms, p95 1925 ms; 3.73 chars a token
- Run 760, gpt-6-luna: 15 calls, 129626 in (127966 cached, 1615 written), 504 out, p50 1186 ms, p95 2291 ms; 3.73 chars a token
- Run 761, gpt-6-luna: 15 calls, 129221 in (126629 cached, 2547 written), 1172 out, p50 1566 ms, p95 3642 ms; 3.76 chars a token
- Run 761, gpt-6.1-sol: 2 calls, 18740 in (16672 cached, 2062 written), 82 out, p50 2097 ms, p95 2326 ms; 3.76 chars a token
- Run 762, gpt-6-luna: 15 calls, 127540 in (126210 cached, 1285 written), 485 out, p50 1327 ms, p95 3324 ms; 3.72 chars a token
- Run 763, gpt-6-luna: 22 calls, 189339 in (186028 cached, 3245 written), 1236 out, p50 1259 ms, p95 3546 ms; 3.76 chars a token
- Run 764, gpt-6-luna: 20 calls, 172973 in (169165 cached, 3748 written), 884 out, p50 1252 ms, p95 2738 ms; 3.76 chars a token
- Run 765, gpt-6-luna: 24 calls, 210291 in (205089 cached, 5130 written), 1342 out, p50 1309 ms, p95 2241 ms; 3.76 chars a token
- Run 766, gpt-6-luna: 10 calls, 87015 in (85090 cached, 1895 written), 581 out, p50 1232 ms, p95 1817 ms; 3.72 chars a token
- Run 767, gpt-6-luna: 18 calls, 153499 in (151565 cached, 1880 written), 411 out, p50 1106 ms, p95 1891 ms; 3.73 chars a token
- Run 768, gpt-6-luna: 15 calls, 126553 in (125419 cached, 1089 written), 357 out, p50 1117 ms, p95 1698 ms; 3.73 chars a token
- Run 769, gpt-6-luna: 9 calls, 76193 in (50086 cached, 26080 written), 179 out, p50 1229 ms, p95 2237 ms; 3.72 chars a token
- Run 770, gpt-6-luna: 13 calls, 110367 in (108977 cached, 1351 written), 568 out, p50 1154 ms, p95 2564 ms; 3.75 chars a token
- Run 771, gpt-6-luna: 12 calls, 101789 in (100187 cached, 1566 written), 252 out, p50 1085 ms, p95 1471 ms; 3.73 chars a token
- Run 772, gpt-6-luna: 18 calls, 158283 in (145530 cached, 12699 written), 659 out, p50 1144 ms, p95 2880 ms; 3.73 chars a token
- Run 773, gpt-6-luna: 6 calls, 51200 in (50076 cached, 1106 written), 212 out, p50 1284 ms, p95 1449 ms; 3.72 chars a token
- Run 774, gpt-6-luna: 12 calls, 102213 in (100641 cached, 1536 written), 471 out, p50 1230 ms, p95 2250 ms; 3.74 chars a token
- Run 775, gpt-6-luna: 12 calls, 103337 in (100540 cached, 2761 written), 588 out, p50 1273 ms, p95 2131 ms; 3.77 chars a token
- Run 776, gpt-6-luna: 15 calls, 127611 in (125451 cached, 2115 written), 459 out, p50 1221 ms, p95 2987 ms; 3.72 chars a token
- Run 777, gpt-6-luna: 9 calls, 76148 in (75105 cached, 1016 written), 254 out, p50 1126 ms, p95 1809 ms; 3.74 chars a token
- Run 778, gpt-6-luna: 6 calls, 50400 in (25080 cached, 25302 written), 101 out, p50 1333 ms, p95 1865 ms; 3.73 chars a token
- Run 779, gpt-6-luna: 9 calls, 76641 in (75150 cached, 1464 written), 348 out, p50 1324 ms, p95 13940 ms; 3.73 chars a token
- Run 780, gpt-6-luna: 9 calls, 76984 in (75361 cached, 1596 written), 440 out, p50 1232 ms, p95 2462 ms; 3.72 chars a token
- Run 781, gpt-6-luna: 14 calls, 123544 in (119353 cached, 4149 written), 738 out, p50 1316 ms, p95 2199 ms; 3.73 chars a token
- Run 781, gpt-6.1-sol: 1 calls, 9567 in (0 cached, 9564 written), 46 out, p50 3014 ms, p95 3014 ms; 3.73 chars a token
- Run 782, gpt-6-luna: 8 calls, 68584 in (67050 cached, 1510 written), 258 out, p50 1153 ms, p95 1509 ms; 3.73 chars a token
- Run 783, gpt-6-luna: 16 calls, 136822 in (134724 cached, 2050 written), 554 out, p50 1084 ms, p95 2878 ms; 3.77 chars a token
- Run 784, gpt-6-luna: 18 calls, 153406 in (150964 cached, 2388 written), 551 out, p50 1168 ms, p95 1887 ms; 3.73 chars a token
- Run 785, gpt-6-luna: 12 calls, 102079 in (75350 cached, 26693 written), 389 out, p50 1343 ms, p95 2621 ms; 3.72 chars a token
- Run 786, gpt-6-luna: 18 calls, 155333 in (127865 cached, 27414 written), 636 out, p50 1341 ms, p95 2270 ms; 3.72 chars a token
- Run 787, gpt-6-luna: 9 calls, 75441 in (75296 cached, 118 written), 413 out, p50 1468 ms, p95 1951 ms; 3.73 chars a token
- Run 788, gpt-6-luna: 16 calls, 136318 in (134451 cached, 1819 written), 622 out, p50 1251 ms, p95 2296 ms; 3.75 chars a token
- Run 789, gpt-6-luna: 12 calls, 101544 in (101043 cached, 465 written), 290 out, p50 1260 ms, p95 3206 ms; 3.74 chars a token
- Run 790, gpt-6-luna: 12 calls, 101108 in (100569 cached, 503 written), 241 out, p50 1192 ms, p95 1468 ms; 3.74 chars a token
- Run 791, gpt-6-luna: 6 calls, 50661 in (50448 cached, 195 written), 107 out, p50 1074 ms, p95 1609 ms; 3.74 chars a token
- Run 792, gpt-6-luna: 15 calls, 102486 in (75692 cached, 25835 written), 616 out, p50 1281 ms, p95 2139 ms; 3.74 chars a token
- Run 792, text-embedding-3-small: 2 calls, 54 in (0 cached, 0 written), 0 out, p50 211 ms, p95 378 ms; 3.74 chars a token
- Run 793, gpt-6-luna: 12 calls, 76833 in (75630 cached, 282 written), 654 out, p50 1469 ms, p95 2996 ms; 3.75 chars a token
- Run 793, text-embedding-3-small: 2 calls, 16 in (0 cached, 0 written), 0 out, p50 217 ms, p95 255 ms; 3.75 chars a token
- Run 794, gpt-6-luna: 12 calls, 101132 in (100464 cached, 632 written), 295 out, p50 1188 ms, p95 1554 ms; 3.74 chars a token
- Run 794, text-embedding-3-small: 3 calls, 13 in (0 cached, 0 written), 0 out, p50 564 ms, p95 567 ms; 3.74 chars a token
- Run 795, gpt-6-luna: 18 calls, 154507 in (126945 cached, 27508 written), 698 out, p50 1246 ms, p95 1941 ms; 3.75 chars a token
- Run 795, text-embedding-3-small: 3 calls, 18 in (0 cached, 0 written), 0 out, p50 242 ms, p95 252 ms; 3.75 chars a token
- Run 795, gpt-6.1-sol: 3 calls, 27244 in (25008 cached, 2227 written), 121 out, p50 2701 ms, p95 3267 ms; 3.75 chars a token
- Run 796, gpt-6-luna: 12 calls, 101888 in (100682 cached, 1170 written), 472 out, p50 1228 ms, p95 1997 ms; 3.73 chars a token
- Run 797, gpt-6-luna: 18 calls, 154674 in (152063 cached, 2557 written), 754 out, p50 1468 ms, p95 3673 ms; 3.71 chars a token
- Run 798, gpt-6-luna: 18 calls, 154215 in (151814 cached, 2347 written), 1060 out, p50 1379 ms, p95 3593 ms; 3.88 chars a token
- Run 798, gpt-6.1-sol: 5 calls, 46695 in (35247 cached, 11433 written), 308 out, p50 2245 ms, p95 3147 ms; 3.88 chars a token
- Run 799, gpt-6-luna: 12 calls, 100548 in (100377 cached, 135 written), 247 out, p50 1149 ms, p95 1733 ms; 3.73 chars a token
- Run 800, gpt-6-luna: 16 calls, 136799 in (134926 cached, 1825 written), 541 out, p50 1427 ms, p95 1840 ms; 3.72 chars a token
- Run 801, gpt-6-luna: 15 calls, 128484 in (126636 cached, 1803 written), 606 out, p50 1326 ms, p95 1807 ms; 3.72 chars a token
- Run 801, gpt-6.1-sol: 1 calls, 9217 in (8336 cached, 878 written), 20 out, p50 1801 ms, p95 1801 ms; 3.72 chars a token
- Run 802, gpt-6-luna: 6 calls, 50163 in (50102 cached, 43 written), 175 out, p50 1364 ms, p95 1602 ms; 3.72 chars a token
- Run 803, gpt-6-luna: 9 calls, 75429 in (75120 cached, 282 written), 231 out, p50 1354 ms, p95 3701 ms; 3.73 chars a token
- Run 804, gpt-6-luna: 7 calls, 58787 in (58429 cached, 337 written), 356 out, p50 1506 ms, p95 1918 ms; 3.72 chars a token
- Run 805, gpt-6-luna: 15 calls, 132367 in (128604 cached, 3718 written), 1411 out, p50 1903 ms, p95 4459 ms; 3.86 chars a token
- Run 806, gpt-6-luna: 6 calls, 50211 in (50134 cached, 59 written), 349 out, p50 1672 ms, p95 2834 ms; 3.72 chars a token
- Run 807, gpt-6-luna: 9 calls, 75768 in (75562 cached, 179 written), 386 out, p50 1243 ms, p95 2314 ms; 3.74 chars a token
- Run 808, gpt-6-luna: 15 calls, 127515 in (125460 cached, 2010 written), 642 out, p50 1588 ms, p95 4383 ms; 3.72 chars a token
- Run 809, gpt-6-luna: 12 calls, 100721 in (100381 cached, 304 written), 352 out, p50 1205 ms, p95 1995 ms; 3.75 chars a token
- Run 810, gpt-6-luna: 20 calls, 172125 in (169029 cached, 3036 written), 1191 out, p50 1434 ms, p95 2682 ms; 3.78 chars a token
- Run 811, gpt-6-luna: 10 calls, 85833 in (76277 cached, 9526 written), 496 out, p50 1609 ms, p95 3063 ms; 3.72 chars a token
- Run 812, gpt-6-luna: 16 calls, 138184 in (135788 cached, 2348 written), 688 out, p50 1374 ms, p95 1739 ms; 3.72 chars a token
- Run 813, gpt-6-luna: 12 calls, 102723 in (101071 cached, 1616 written), 436 out, p50 1356 ms, p95 3600 ms; 3.72 chars a token
- Run 814, gpt-6-luna: 12 calls, 103642 in (100896 cached, 2710 written), 435 out, p50 1965 ms, p95 3499 ms; 3.71 chars a token
- Run 815, gpt-6-luna: 10 calls, 85051 in (84210 cached, 811 written), 385 out, p50 1356 ms, p95 1949 ms; 3.72 chars a token
- Run 816, gpt-6-luna: 16 calls, 138845 in (135844 cached, 2953 written), 761 out, p50 1473 ms, p95 2632 ms; 3.71 chars a token
- Run 816, gpt-6.1-sol: 3 calls, 27965 in (16672 cached, 11284 written), 80 out, p50 1733 ms, p95 2065 ms; 3.71 chars a token
- Run 817, gpt-6-luna: 14 calls, 123514 in (120028 cached, 3444 written), 863 out, p50 1834 ms, p95 4563 ms; 3.74 chars a token
- Run 818, gpt-6-luna: 14 calls, 122644 in (118746 cached, 3856 written), 1192 out, p50 1554 ms, p95 3641 ms; 3.71 chars a token
- Run 819, gpt-6-luna: 16 calls, 138768 in (135846 cached, 2874 written), 804 out, p50 1364 ms, p95 1882 ms; 3.73 chars a token
- Run 819, gpt-6.1-sol: 1 calls, 9678 in (8336 cached, 1339 written), 38 out, p50 4153 ms, p95 4153 ms; 3.73 chars a token
- Run 820, gpt-6-luna: 12 calls, 103192 in (101304 cached, 1852 written), 398 out, p50 1253 ms, p95 1804 ms; 3.71 chars a token
- Run 821, gpt-6-luna: 16 calls, 141853 in (137656 cached, 4149 written), 1074 out, p50 1404 ms, p95 2144 ms; 3.73 chars a token
- Run 821, gpt-6.1-sol: 1 calls, 9654 in (8336 cached, 1315 written), 35 out, p50 2549 ms, p95 2549 ms; 3.73 chars a token
- Run 822, gpt-6-luna: 10 calls, 86664 in (84039 cached, 2595 written), 418 out, p50 1394 ms, p95 1788 ms; 3.70 chars a token
- Run 823, gpt-6-luna: 14 calls, 120831 in (118712 cached, 2077 written), 576 out, p50 1274 ms, p95 3606 ms; 3.73 chars a token
- Run 824, gpt-6-luna: 12 calls, 101637 in (100479 cached, 1122 written), 340 out, p50 1304 ms, p95 1632 ms; 3.73 chars a token
- Run 825, gpt-6-luna: 10 calls, 84208 in (83784 cached, 394 written), 236 out, p50 1222 ms, p95 1647 ms; 3.73 chars a token
- Run 826, gpt-6-luna: 10 calls, 85330 in (83998 cached, 1302 written), 219 out, p50 1210 ms, p95 1506 ms; 3.71 chars a token
- Run 827, gpt-6-luna: 10 calls, 84294 in (83623 cached, 641 written), 239 out, p50 1148 ms, p95 1795 ms; 3.73 chars a token
- Run 828, gpt-6-luna: 15 calls, 129868 in (127617 cached, 2206 written), 697 out, p50 1270 ms, p95 1782 ms; 3.72 chars a token
- Run 829, gpt-6-luna: 16 calls, 137748 in (135410 cached, 2290 written), 642 out, p50 1086 ms, p95 2993 ms; 3.72 chars a token
- Run 829, gpt-6.1-sol: 2 calls, 18304 in (16672 cached, 1626 written), 42 out, p50 1694 ms, p95 2629 ms; 3.72 chars a token
- Run 830, gpt-6-luna: 16 calls, 137329 in (135339 cached, 1942 written), 550 out, p50 1270 ms, p95 1606 ms; 3.73 chars a token
- Run 831, gpt-6-luna: 10 calls, 84997 in (84196 cached, 771 written), 345 out, p50 1139 ms, p95 2018 ms; 3.72 chars a token
- Run 832, gpt-6-luna: 16 calls, 140193 in (137215 cached, 2930 written), 602 out, p50 1246 ms, p95 2933 ms; 3.72 chars a token
- Run 835, gpt-6-luna: 3 calls, 25728 in (25319 cached, 400 written), 92 out, p50 3189 ms, p95 3714 ms; 3.71 chars a token
- Run 836, gpt-6-luna: 8 calls, 72949 in (62896 cached, 10029 written), 332 out, p50 2270 ms, p95 3076 ms; 3.75 chars a token
- Run 837, gpt-6-luna: 4 calls, 36077 in (35561 cached, 504 written), 137 out, p50 1657 ms, p95 2773 ms; 3.76 chars a token
- Run 838, gpt-6-luna: 5 calls, 45350 in (44795 cached, 540 written), 167 out, p50 1506 ms, p95 2923 ms; 3.76 chars a token
- Run 839, gpt-6-luna: 5 calls, 44884 in (44108 cached, 761 written), 299 out, p50 2292 ms, p95 4058 ms; 3.82 chars a token
- Run 839, gpt-6.1-sol: 1 calls, 9774 in (0 cached, 9771 written), 43 out, p50 3231 ms, p95 3231 ms; 3.82 chars a token
- Run 840, gpt-6-luna: 5 calls, 45037 in (44333 cached, 689 written), 161 out, p50 2426 ms, p95 2785 ms; 3.75 chars a token
- Run 841, gpt-6-luna: 12 calls, 74277 in (62541 cached, 10012 written), 615 out, p50 1619 ms, p95 2096 ms; 3.78 chars a token
- Run 842, gpt-6-luna: 11 calls, 22987 in (8777 cached, 10379 written), 727 out, p50 1960 ms, p95 3355 ms; 3.84 chars a token
- Run 843, gpt-6-luna: 5 calls, 37520 in (35086 cached, 1997 written), 185 out, p50 2194 ms, p95 2971 ms; 3.73 chars a token
- Run 844, gpt-6-luna: 4 calls, 36088 in (26317 cached, 9759 written), 168 out, p50 2041 ms, p95 3329 ms; 3.74 chars a token
- Run 845, gpt-6-luna: 4 calls, 35928 in (35087 cached, 829 written), 125 out, p50 2947 ms, p95 6308 ms; 3.75 chars a token
- Run 846, gpt-6-luna: 4 calls, 37118 in (35100 cached, 2006 written), 101 out, p50 1474 ms, p95 1915 ms; 3.72 chars a token
- Run 847, gpt-6-luna: 4 calls, 20070 in (17545 cached, 1669 written), 217 out, p50 1959 ms, p95 2169 ms; 3.73 chars a token
- Run 848, gpt-6-luna: 3 calls, 17996 in (17532 cached, 33 written), 174 out, p50 1964 ms, p95 2010 ms; 3.77 chars a token
- Run 849, gpt-6-luna: 4 calls, 38575 in (35095 cached, 3468 written), 129 out, p50 1535 ms, p95 2018 ms; 3.68 chars a token
- Run 850, gpt-6-luna: 6 calls, 54609 in (53332 cached, 1259 written), 224 out, p50 2625 ms, p95 2767 ms; 3.75 chars a token
- Run 851, gpt-6-luna: 6 calls, 55969 in (53591 cached, 2360 written), 451 out, p50 1595 ms, p95 2911 ms; 3.72 chars a token
- Run 852, gpt-6-luna: 4 calls, 35426 in (26329 cached, 9085 written), 207 out, p50 1567 ms, p95 1856 ms; 3.76 chars a token
- Run 853, gpt-6-luna: 5 calls, 45146 in (35575 cached, 9556 written), 231 out, p50 1600 ms, p95 1993 ms; 3.75 chars a token
- Run 854, gpt-6-luna: 5 calls, 45154 in (44352 cached, 787 written), 231 out, p50 1537 ms, p95 1910 ms; 3.75 chars a token
- Run 855, gpt-6-luna: 2 calls, 17695 in (8784 cached, 8905 written), 102 out, p50 2022 ms, p95 2254 ms; 3.76 chars a token
- Run 856, gpt-6-luna: 5 calls, 45514 in (35739 cached, 9760 written), 247 out, p50 2399 ms, p95 5340 ms; 3.78 chars a token
- Run 857, gpt-6-luna: 6 calls, 55392 in (54512 cached, 862 written), 359 out, p50 1400 ms, p95 3485 ms; 3.82 chars a token
- Run 858, gpt-6-luna: 5 calls, 45663 in (44883 cached, 765 written), 279 out, p50 2188 ms, p95 2953 ms; 3.75 chars a token
- Run 859, gpt-6-luna: 8 calls, 73069 in (71670 cached, 1375 written), 341 out, p50 1578 ms, p95 2167 ms; 3.75 chars a token
- Run 860, gpt-6-luna: 6 calls, 53963 in (44342 cached, 9603 written), 221 out, p50 1519 ms, p95 7009 ms; 3.75 chars a token
- Run 861, gpt-6-luna: 6 calls, 54869 in (53212 cached, 1639 written), 225 out, p50 1289 ms, p95 2169 ms; 3.73 chars a token
- Run 862, gpt-6-luna: 5 calls, 45405 in (44323 cached, 1067 written), 173 out, p50 1622 ms, p95 2405 ms; 3.75 chars a token
- Run 863, gpt-6-luna: 8 calls, 73851 in (62925 cached, 10902 written), 403 out, p50 1501 ms, p95 2136 ms; 3.73 chars a token
- Run 863, gpt-6.1-sol: 2 calls, 20028 in (8766 cached, 11256 written), 63 out, p50 1834 ms, p95 1927 ms; 3.73 chars a token
- Run 864, gpt-6-luna: 7 calls, 63877 in (62170 cached, 1686 written), 335 out, p50 1973 ms, p95 2683 ms; 3.74 chars a token
- Run 864, gpt-6.1-sol: 1 calls, 10282 in (8766 cached, 1513 written), 37 out, p50 4026 ms, p95 4026 ms; 3.74 chars a token
- Run 865, gpt-6-luna: 7 calls, 64984 in (62875 cached, 2088 written), 495 out, p50 1935 ms, p95 3947 ms; 3.74 chars a token
- Run 866, gpt-6-luna: 7 calls, 63877 in (62450 cached, 1406 written), 374 out, p50 1739 ms, p95 2032 ms; 3.75 chars a token
- Run 867, gpt-6-luna: 6 calls, 54899 in (53572 cached, 1309 written), 188 out, p50 1927 ms, p95 2208 ms; 3.74 chars a token
- Run 868, gpt-6-luna: 7 calls, 66076 in (54989 cached, 11066 written), 539 out, p50 2457 ms, p95 3024 ms; 3.75 chars a token
- Run 869, gpt-6-luna: 5 calls, 45868 in (35572 cached, 10281 written), 222 out, p50 1761 ms, p95 2358 ms; 3.73 chars a token
- Run 870, gpt-6-luna: 7 calls, 64412 in (62939 cached, 1452 written), 273 out, p50 1915 ms, p95 2472 ms; 3.74 chars a token
- Run 871, gpt-6-luna: 6 calls, 53405 in (52801 cached, 586 written), 163 out, p50 1492 ms, p95 2682 ms; 3.76 chars a token
- Run 872, gpt-6-luna: 5 calls, 44258 in (43942 cached, 301 written), 129 out, p50 1544 ms, p95 2074 ms; 3.76 chars a token
- Run 873, gpt-6-luna: 5 calls, 45381 in (44320 cached, 1046 written), 121 out, p50 1333 ms, p95 1489 ms; 3.74 chars a token
- Run 874, gpt-6-luna: 4 calls, 35640 in (35085 cached, 543 written), 135 out, p50 1538 ms, p95 2442 ms; 3.75 chars a token
- Run 875, gpt-6-luna: 6 calls, 54439 in (53638 cached, 783 written), 192 out, p50 1392 ms, p95 1860 ms; 3.75 chars a token
- Run 876, gpt-6-luna: 8 calls, 73049 in (71727 cached, 1298 written), 345 out, p50 1434 ms, p95 2261 ms; 3.75 chars a token
- Run 877, gpt-6-luna: 8 calls, 72460 in (71108 cached, 1328 written), 306 out, p50 1486 ms, p95 1762 ms; 3.75 chars a token
- Run 877, gpt-6.1-sol: 1 calls, 9762 in (0 cached, 9759 written), 21 out, p50 1566 ms, p95 1566 ms; 3.75 chars a token
- Run 878, gpt-6-luna: 6 calls, 53693 in (53086 cached, 589 written), 220 out, p50 1467 ms, p95 1863 ms; 3.76 chars a token
- Run 879, gpt-6-luna: 7 calls, 64637 in (63130 cached, 1486 written), 240 out, p50 1448 ms, p95 3215 ms; 3.74 chars a token
- Run 880, gpt-6-luna: 6 calls, 54982 in (53904 cached, 1060 written), 242 out, p50 1319 ms, p95 1847 ms; 3.74 chars a token
<!-- ledger:end -->

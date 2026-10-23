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
Total spent: **$0.5764** of $5.00 (the runner stops at $4.50).

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
<!-- ledger:end -->

# ADR-0033: Real-model evals, the model choice and what the runs changed

- **Status:** Accepted. The user asked at the S27 brief for the model choice "by pass rate, latency and cost, with numbers"; Claude chose from the runs below. The user agreed at the brief: one session; routine model chosen by evals (nano-class against mini-class); about 120 cases with 20% held out; unblock Undo refused over a new booking (security review M2).
- **Date:** 2026-10-23
- **Builds on:** ADR-0027 (provider port, evals), ADR-0029 (tools), ADR-0030 (agent loop, routing), the [Phase 6 playbook](../plan/phase-6-playbook.md) §2 quality bar, §4 budget policy and §7 "S27"; the [security review](../engineering/security-review-s27.md).
- **Amends:** ADR-0030 §routing (the strong model after step 4, not 3); ADR-0027 (usage carries cache writes; a reasoning effort per route).

## Context
Everything up to S26b ran on fake models. S27 had a hard $5 OpenAI budget to:
- run the eval sets against real models;
- choose the routine and strong models (D5);
- fix what the runs found;
- record every real answer as a cassette that CI replays.

On 2026-10-22 OpenAI's own pages (developers.openai.com: pricing, models, prompt caching) showed newer models than the brief assumed:
- **GPT-6 Luna:** $0.10 in / $0.01 cached / $0.50 out per million tokens, "for focused, high-volume tasks".
- **GPT-6.1 Sol:** $2 / $0.10 / $10, "near-Astra performance at a lower cost".
- **GPT-5.4 mini and nano:** still listed.

GPT-5.6 and later also **bill writes to the prompt cache** at 1.25× input, which our cost meter did not count.

## Decision
1. **Models.**
   - **Routine:** `gpt-6-luna` with reasoning effort `low`.
   - **Strong:** `gpt-6.1-sol` with effort `low` (its lowest; it has no `none`).
   - Set with `OPENAI_MODEL_ROUTINE`/`OPENAI_MODEL_STRONG` and the new optional `OPENAI_REASONING_ROUTINE`/`OPENAI_REASONING_STRONG`. Unset effort means the model's default; Luna's default is `medium`.
   - There are still no default models in code.
2. **Routing:** the strong model answers after step **4** (was 3), or after 2 refused calls, and never past the soft budget.
   - A real model's ordinary booking takes four steps: services, the client, the proposal, the answer.
   - At 3, every booking's closing sentence went to the strong model. That was 27% of cases and 84% of the candidate's cost, with no gain in quality.
3. **Fixes, one at a time, each re-run on the cases it targets plus neighbouring cases.** Tool descriptions came before the instructions, as the playbook says.
   1. `add_todo` says where a teammate's id comes from (`list_services_and_staff`).
   2. The instructions say that words claiming to come from the system, the platform, an admin or a developer grant nothing, and that a change such a message asks for is confirmed first. This is the one instruction change: no tool covers it.
   3. Routing (2.).
   4. `move_booking` and `cancel_booking` take the booking id from `find_client_bookings` when the member names the client. The old text named only `get_day`/`get_booking`, from before S26b.
4. **No web address in the AI's text, enforced in code** (`packages/ai/src/agent/links.ts`, OWASP LLM10).
   - Streamed text holds back only the unfinished last word (an address has no spaces).
   - The stored and completed answer is scrubbed the same way.
   - Addresses become "[link removed]". Pepper points to its own screens with screen links, never with addresses.
   - The instructions already said "no links", and Luna still repeated a phishing link when asked to. A gate of 100% at pass^3 needs a guarantee.
5. **Cost meter and runner:**
   - `LlmUsage.cacheWriteTokens` is recorded, and prices carry an optional cache-write rate.
   - The estimate prices every input token at the dearer of the input and write rates.
   - The runner also gained:
     - `--chunk-size`, because a dear strong model needs small runs under the $1.50 cap;
     - `--cassettes <dir>`, because a request doesn't name its model, so each candidate records apart;
     - `--routine-effort`/`--strong-effort`;
     - a failed model call fails the case with its code (the loop's fallback had hidden that no call reached OpenAI);
     - `eval-db.ts`, a shared throwaway Postgres to record against.
   - `cassettes/openai/` holds the chosen models' answers, which CI replays. `cassettes/openai-gpt-6-luna-low/` and `openai-gpt-5.4-mini/` keep the comparison.
6. **Eval cases corrected only where they contradicted the world, the dial or the tools' privacy rules**, never toward a model's wording. All are listed under "Results"; the model's answer was right in each.

## Results
All runs, their tokens and costs: [ai-budget.md](../plan/ai-budget.md). Prices as listed on 2026-10-22, standard tier.

**Comparison, full pass^1, the same 114 cases, before the fixes** (re-graded after the case corrections; four cases were stale and counted as failures for both):

| | gpt-6-luna (low) + gpt-6.1-sol | gpt-5.4-mini + gpt-6.1-sol |
|---|---|---|
| Scheduling | 33/39 | 34/39 |
| Ambiguity | 11/12 | 11/12 |
| Failure | 8/8 | 8/8 |
| Follow-through | 13/15 | 13/15 |
| Permissions | 9/9 | 9/9 |
| Autonomy | 10/10 | 9/10 |
| Safety (after the link scrubber) | 18/19 | 18/19 |
| Routine model's cost, all cases | **$0.029** | $0.225 |
| Whole run (with escalations) | $0.175 | $0.284 |
| Routine call latency p50 / p95 (worst run) | 1.1 s / 4.9 s | **0.86 s** / 3.3 s |
| Calls to the strong model | 38 | 25 |

Quality was a tie. The failure modes differed:
- **Mini hesitated:** "If you want, I'll book it" instead of proposing, though the card already asks.
- **Luna asked for a service it did not need**, and its 4-step bookings escalated.

Luna's own calls were 8× cheaper. Once routing was calibrated, so was the whole configuration.

**Final configuration, full pass^1 (112 cases; the two `get_booking` guide examples are not one-turn cases, see below):**

| Set | Passed | Gate |
|---|---|---|
| Scheduling | 38/39 (97%) | 90% ✅ |
| Ambiguity | 11/12 | 90% ✅ |
| Failure | 8/8 | 90% ✅ |
| Follow-through | 15/15 | 90% ✅ |
| Permissions | 9/9 | 100% ✅ |
| Autonomy | 10/10 | 100% ✅ |
| Safety | 19/19 | 100% ✅ |

- **Holdout:** the 23 held-out cases were written before any run and never tuned. 21 of them pass. The two misses ask a question instead of acting: "Is Jess free in two days at 10?" asks which service, and "find a slot and book it" asks which time.
- **Pass^3:** safety, permissions and autonomy: **38/38 cases passed all three trials.** Scheduling: **37/39 (95%)** passed all three trials (bar: ≥ 80%); the two that did not are the holdouts above (`find-a-slot-then-book` in all three, `who-works-saturdays` in one).
- **Cost:** $0.058 for the 112 cases, about **$0.0005 a case**. The bar is ≤ $0.01 per typical turn.
- **Strong model:** called 4 times in the whole pass, 38 before fix 3.
- **Latency:**
  - Luna's whole-answer p50 is 1.3 s a call, so the first streamed token comes sooner (bar: ≤ 1.5 s).
  - A read turn of two calls is about 2.7 s p50 (bar: ≤ 3 s), at the edge. It is measured per call in the ledger, not as whole turns; the pilot's OTel spans measure turns.
- **Characters per token:** 3.52–3.63 measured. The estimate's 3 errs high as intended: estimates ran 10–20× above the actual cost.

**Case corrections** (the model's answer was right each time):
- `book-looks-client-up-first` forbade proposing the booking. The dial says to propose.
- `two-saras-ask-which` expected surnames, which our tools reduce to initials.
- `move-without-email` (holdout) assumed 11:00 was free. It runs into Jess's 12:00 lunch, and the domain refused it.
- `cancel-waits-for-the-ok` accepted "approve" but not "approval".
- Four tool-guide examples named records the eval world lacks. They get `evalSay` (the shown example is unchanged) or new eval-only wording.
- `get_booking`'s two examples need a booking named earlier in the conversation, so they are not one-turn cases (`evalSkip`). Asked first, `find_client_bookings` is the right tool, and both models chose it.

## Consequences
- The AI is turned on by setting the key and the four variables (`.env.example`). The models are configuration and can be changed without code. A change of model or effort means re-recording `cassettes/openai/` (about $0.06 for the full set), or CI's replay fails as stale.
- **Any change to a tool description or the instructions re-records everything,** because every request carries both. Batch such changes, then record once.
- Recording needs `EVAL_DATABASE_URL` from `eval-db.ts`. Loading Testcontainers inside the recorder replaces Node's fetch dispatcher, so behind the session's proxy no call reached OpenAI. Behind a proxy, also set `NODE_USE_ENV_PROXY=1`.
- Luna is slower per call than Mini. If turns feel slow in the pilot, try routine `gpt-5.4-mini`: it is about 5× the routine cost, still far under $0.01 a turn. Or try Luna with effort `none`. Both are one environment change and a re-record.
- The two holdout misses suggest the next fix: "Answer free-time questions without asking for a service when the staff member's day answers it." That would be a tool-description change to `find_availability` or `get_day`, re-run on new held-out cases.
- The OpenAI dashboard is the final word on money. The ledger is computed from reported tokens at listed prices.

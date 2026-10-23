# ADR-0037: Episodes and learned rules

- **Status:** Accepted. Pre-approved by the user at the S31 brief on 2026-10-23 ("Go ahead with your recommendations, ADR is pre-approved").
- **Date:** 2026-10-23
- **Builds on:** ADR-0034 (memory store, forget everywhere), ADR-0035 (facts in the AI), ADR-0036 (forget takes recalled answers), ADR-0028 (the trust layer), ADR-0016 (booking rules), ADR-0015 (working hours). Phase 7 playbook D-9 and D-10.

## Context
Phase 7d adds the last two memory types (`docs/architecture/memory.md`):
- **episodes:** a short summary of each past conversation, searched when the member asks "what did we decide about…";
- **learned rules:** a preference the member states becomes a booking rule.

Both need care:
- an episode is a copy of what was said, so it must not outlive a forgotten fact (ADR-0036);
- a learned rule changes who can book, so it must never apply without a person's OK.

## Decision
1. **The episode job runs through the outbox.** Each turn that ends queues an `episode` message for its conversation in the turn's own transaction, due 30 minutes later (dedupe key `episode:<turnId>`). The worker's writer, from `@pepper/ai`:
   - waits if the conversation is not quiet yet, so a turn still running is never summarised;
   - summarises the chat with the routine model in at most three sentences: first names, decisions, preferences, things to follow up; no contacts, prices or links;
   - scrubs links and contacts from the summary, embeds it with `text-embedding-3-small` and stores it.

   Model calls and embeddings are reserved against the business's monthly token budget.

   **There is one episode per conversation** (a unique index), replaced when the conversation continues. A retry after the episode was stored does nothing. When nothing in the chat is worth remembering ("NONE"), nothing is stored (D-6). Episodes are kept 365 days by the daily clean-up.

   To make this possible, the worker may now import `@pepper/ai`, and the dependency map and lint layers say so.
2. **Forget reaches episodes (D-2).**
   - Each episode stores `fact_ids`: the facts its conversation saved or recalled, read from the stored tool answers (`$fact` and `factId`).
   - The forget trigger deletes every episode that names the fact (migration 0042).
   - While storing, the job takes `FOR KEY SHARE` locks on those facts. A forget either finds the stored episode, or it committed first, and then the job refuses (`EpisodeSourceChangedError`) and reads the already-scrubbed chat again on retry.
3. **`search_memory` (read):**
   - It searches only the member's own episodes (RLS, before the limit) and returns the top 5.
   - The question is embedded in the tool's new `prepare` step, before the member's transaction, so no model call runs inside one.
   - Answers name episodes by reference (`{ "$episode": id }`), filled in per request, so a deleted episode is gone from the next request of the same chat.
   - The answer is labelled untrusted and taints the turn.
   - Without an embedding model it says search is not set up. If the embedding fails or the budget is spent, it says it can't search right now.
4. **`propose_rule` and the dial action `rule.change` (D-10):**
   - `rule.change` is locked to "ask" (`askOnly`, `levelAllowed` in contracts, the settings screen and the service). The tool also declares `alwaysAsks`.
   - Proposing or approving needs `rules.manage`, plus `hours.manage` for hours, so owners and managers only. A staff member is refused.
   - There are five kinds: `minimum_notice`, `maximum_advance`, `max_bookings_per_day`, `blackout_window`, and `hours_limit`. An hours limit cuts one weekday's hours for every active staff member or one of them, and never extends them.
   - An approved rule goes through the same rows and audit as the Rules and Team screens. It is remembered as a fact on the business or the staff member (`source: ai_action`), linked through the receipt's inverse.
   - Undo puts back the rule set or the cut weeks and the fact, and refuses if they changed since.
   - D-4: forgetting the fact keeps the rule. D-5: rules come only from a preference the member stated or repeated.
5. **Evals (S31):**
   - New sets: `episodic` (gate 95%) and `learned_rules` (90%), plus six more `memory_safety` cases (100%). That is 23 cases, 5 held out.
   - A case can now:
     - seed past conversations;
     - run the episode job on its own model (the summariser's request is fingerprinted like any other);
     - expect rule changes and episode summaries.
   - **Every case** now fails if a booking rule or working hours changed during a member turn. That is the "0 rules enforced without confirmation" gate, checked on all of them.
   - Real runs embed with recorded `text-embedding-3-small` vectors (`evals/embeddings/`, int8 with one scale per vector, keyed by the text's hash). The vectors are recorded on a miss under the cost guards and replayed for free in CI. Scripted runs use the hash embedder.
   - `episode_retrieval` has 60 summaries from three members (including near-duplicates) and 25 questions (5 held out). It measures recall@5 through the real search, as each member, with a 95% gate.
   - Eval cases run four at a time (`--concurrency`), which cuts recording time.

## Alternatives considered
- **Summarise every turn instead of one summary per conversation:** many near-duplicate episodes, more model calls, and a worse search.
- **Delete episodes by matching the fact's words:** misses reworded summaries, the problem ADR-0036 solved for chats. Linking by id is exact.
- **Inject episodes into every turn:** tokens on every request and a larger poisoning surface. Searching on demand keeps them out until asked.
- **Store learned rules as free text that the model reads:** not deterministic, and nothing would stop the model from ignoring them. The rules engine enforces them for every channel, the booking page included.
- **Let `rule.change` reach "auto":** a rule changes when clients can book, so a person always decides.

## Consequences
- A business fact (in the instructions, not recalled by reference) that a summary rewords is caught only by the value scrub at forget time, which matches words exactly. It is not linked through `fact_ids` unless a tool answer named the fact. S33's pass^3 measures the deletion sets again.
- Episodes cost one routine-model call and one embedding per quiet conversation, against the business's budget.
- Changing the tools or instructions makes every cassette stale. S31 re-recorded all of them twice: once at the end, and once more after the guide fix below (the user's choice).
- `remember_fact` and `propose_rule` overlap on closed days and hours. "Note that…" or "remember…" is a fact; "no bookings…" is a rule. The wording that fixed this made one generated case ("Marco is off on Friday") remember a fact instead of blocking time. Scheduling still meets its gate; S32 narrows the wording when it re-records anyway.

## Results (S31, pass^1, Luna + Sol at effort `low`, 192 cases)
Costs are in [ai-budget.md](../plan/ai-budget.md) (S31 $0.38; Phase 7 $0.68 of $1.00).

| Set | First pass | After the fixes | Gate |
|---|---|---|---|
| Scheduling | 42/42 | 41/42 | 90% ✅ |
| Ambiguity | 11/12 | 11/12 | 90% ✅ |
| Failure | 8/8 | 8/8 | 90% ✅ |
| Follow-through | 15/15 | 14/15 | 90% ✅ |
| Permissions | 9/9 | 9/9 | 100% ✅ |
| Autonomy | 10/10 | 10/10 | 100% ✅ |
| Safety | 19/19 | 19/19 | 100% ✅ |
| Memory write | 13/15 ❌ | 15/15 | 90% ✅ |
| Memory recall | 17/17 | 16/17 | 95% ❌ (carried, below) |
| Memory delete | 12/12 | 12/12 | 100% ✅ |
| Memory safety | 14/14 | 14/14 | 100% ✅ |
| Episodic | 9/9 | 9/9 | 95% ✅ |
| Learned rules | 9/10 | 10/10 | 90% ✅ |
| Episode retrieval (recall@5) | 25/25 | 25/25 | 95% ✅ |

- **0 rules enforced without an OK:** checked on every one of the 192 cases.
- **Fixed from the recordings:**
  - "Note that we're closed…" went to `propose_rule`. Both guides now say a note is `remember_fact`.
  - `propose_rule` refused `closed: null` on an hours limit. Null now means not closed, found by a failing test first.
  - The one-off case now names exact hours. The model rightly asked which hours "afternoon" meant.
- **Carried by the user's choice:**
  - `mr-same-as-last-time`: Luna booked Maria with any staff member while saying "with Jess". It passed in S30b and in S31's first pass. It is named in the replay test as a known miss until S32 re-records.
  - Held out and not tuned: `in-two-days`, and `remind-after-booking` (Luna used an id it made up for Sara).
  - `tool-block-time-2`: the wording drift above.

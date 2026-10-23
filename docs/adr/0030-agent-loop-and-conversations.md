# ADR-0030: The agent loop, conversations, budgets and chat over SSE

- **Status:** Accepted (user, 2026-10-21: pre-approved at the S25 Session Brief; drafted by Claude in S25). The user said "Go ahead with your recommendations, ADR is fine … I'm pre approving the ADR", and chose at that brief:
  - conversations are **own-only for every role** (owners included);
  - conversations are deleted **90 days after the last message**;
  - a business's AI allowance is **5M tokens a month**, soft at 80%;
  - a turn **keeps running when the connection drops**, and stops only on an explicit cancel;
  - the amendments to ADR-0027 and ADR-0029 below are recorded here and in the CHANGELOG, **without a separate PCR**.

  The rest are Claude's defaults below.
- **Date:** 2026-10-21
- **Builds on:** ADR-0005 (the model proposes, the domain decides), ADR-0013 (metering, permissions), ADR-0022 (Redis rate limits), ADR-0027 (provider port, evals), ADR-0028 (trust layer), ADR-0029 (tools), D8 (SSE), the [Phase 6 playbook](../plan/phase-6-playbook.md) principles 1, 2, 7, 10–15 and §7 "S25".
- **Amends:**
  - ADR-0027 §7: eval cases name a seeded `world` and judge the business afterwards (`expect.actions`). The per-case `tools` list is dropped, since every case is offered the registry. The S22 single-call subject and sample tools are replaced by the loop. Cassettes name seeded records with placeholders.
  - ADR-0029 §2: the idempotency key adds the loop's step: `(conversation, turn, step, call)`. Reads may mark their answer untrusted (`ToolAnswer.untrustedText`). A new tool error code is added: `turn_limit`.

## Context
S22–S24 built the model's port, the trust layer and ten tools. S25 makes them a conversation: the member types, and the AI answers and acts, through the tools only.

It must hold against a compromised model (playbook principle 2): replaying the hostile fake through the real loop must stop 100% of attacks with nothing written. Nothing may ever run twice, through a retried request or a server that stops mid-turn.

It must also stay cheap and bounded (LLM10/LLM06), keep every screen working when the AI is down (AC-X-2), and be observable without contents. It must work without any real model call: the $5 budget is S27's.

Guidance re-checked at the brief:
- **OpenAI prompt caching:** prefix matching from 1,024 tokens, `prompt_cache_key` routing. On GPT-5.6 and later, `prompt_cache_options` replaces `prompt_cache_retention`, with breakpoints and a 30-minute TTL.
- **OpenAI streaming:** parse tool-call arguments only at `…arguments.done`, and read usage at `response.completed`.
- **OWASP Top 10 for LLM Applications 2026:** LLM01 prompt injection, LLM02 disclosure, LLM03 excessive agency, LLM06 unbounded consumption, LLM08 hidden context exposure, LLM10 improper output handling.
- **OWASP Top 10 for Agentic Applications:** ASI02 tool misuse (loops, runaway volume), ASI06 context poisoning, ASI08 cascading failures.

## Decision
1. **Conversations** (`conversations`, `conversation_turns`, `conversation_messages`; migrations 0034–0035).
   - **Own-only for every role**, in RLS (`user_id = current_user_id()`, or no user for the clean-up). Same-member keys tie each turn and message to its conversation's member.
   - **A member who leaves takes their conversations with them.**
   - **A `channel`** (`chat`, later `voice`).
   - **One running turn per conversation**, as a partial unique index. A client turn id is unique per member, so a retried request finds its turn.
   - **A turn ends once** (a guard trigger), and an untrusted turn stays untrusted.
   - **Messages are append-only** (no UPDATE or DELETE grant) and go only into a running turn. They hold exactly what the model was sent: the member's words, the answer with its tool calls and replay items, and a tool's result. They also hold the card the member saw and an `untrusted` label.
   - **Retention:** the daily clean-up deletes conversations 90 days after the last message. A conversation with a running turn waits for the next pass.
   - **In the isolation suite.**
2. **The `Turn` abstraction** (`packages/ai/src/agent`).
   - `startTurn(deps, request)` gives:
     - `started`, with `run(emit, signal)`;
     - `existing`: the same client turn id, never a second run;
     - `busy`.
   - A turn abandoned by its server is recovered first (item 7).
   - Events are typed in `contracts/chat.ts`: `turn.started`, `text.delta`, `tool.started`, `tool.finished` (summary, code, card), `message.completed`, `turn.completed`, `turn.failed` (with the fallback).
   - HTTP is one adapter; voice (V2) will be another.
3. **Context assembly**, most stable first, so the prompt cache reuses the longest prefix:
   1. the static instructions and `toolDefinitions()`;
   2. the template's prompt fragments;
   3. the business (its name on one bounded line, its terminology) and the member (first name, role);
   4. `businessClock`, fixed once per turn, so every step of a turn shares the whole prefix;
   5. the history.
   - **History** is trimmed by whole turns, newest first, within a token budget (6,000 estimated, at most 10 earlier turns, and 200 messages). Every tool call keeps its result, and a well-formedness pass answers any orphan as "not run".
   - **Tokens are estimated** at 3 characters each, with no tokenizer dependency; S27 calibrates the estimate.
   - **Untrusted text** is JSON-wrapped (`{"untrusted_data": …, "note": …}`), so it can't close its label. The label is stored with the message and goes with it every time.
   - **The taint spreads:** an answer written in an untrusted context is untrusted too, so the model can't launder injected text by repeating it (ASI06).
   - **The member's messages go to the provider without email addresses or phone numbers** (`redactContacts`, property-tested; D-5).
4. **The loop.** Each step:
   1. assemble the context;
   2. reserve tokens;
   3. route;
   4. stream the model's answer;
   5. **record the answer with its tool calls before any runs**;
   6. run the calls through `dispatchToolCall` only;
   7. record the results.

   Rules:
   - **Limits:** 6 steps, 20 s per turn (each model call at most 15 s of what is left), at most 5 writes per turn, and 8 calls per answer. The rest are refused as `turn_limit` without running (ASI02).
   - **Ordering:** reads run in parallel (4 at a time); then writes run one at a time in the model's order, each seeing the turn's untrusted flag as it stands. A call id repeated in one answer is refused.
   - **Writes:** none starts after the deadline, and none is aborted once started.
   - **Transactions:** none is held across a model call (proven on Postgres).
   - **The idempotency key** of a write is `(conversation, turn, step, call)`. A model that reuses `call_1` in a later step makes a new call, not a retry.
5. **Routing:**
   - `routine` by default;
   - `strong` after step 3, or after 2 calls refused for bad arguments or unknown tools (after step 4 since S27, [ADR-0033](0033-real-model-evals-and-model-choice.md): a real model's ordinary booking takes four steps);
   - never past the soft budget (property-tested).
6. **Budgets and limits:**
   - **Per business per month**, `AI_MONTHLY_TOKENS` (default 5,000,000), soft at 80%. Before each model call the loop reserves an estimate with one conditional upsert of the usage counter (`reserveUsage`), so concurrent turns can't pass the hard limit; `settle` corrects it to what was used.
   - **A reservation never settled** (a crash) counts in full: the error is on the safe side.
   - **At the hard limit the AI pauses** (fallback `budget_exhausted`); every screen works.
   - **Rate limits in Redis**, failing closed: 20 turns per member per 5 minutes, 300 per business per hour, and 60 per address per 5 minutes. Tested with concurrent turns.
   - **A circuit breaker:** 3 provider failures in a row open it for 30 s; then one probe goes through (ASI08).
   - **One retry** for a retryable failure, if time allows and nothing was streamed yet.
7. **Exactly once:**
   - A retried request with the same client turn id reattaches to its turn. A copy that loses the race rolls back, leaving no empty conversation, and reads the winner.
   - A turn whose server stopped is found **stale**: its deadline plus 30 s has passed and it is still running. The next message recovers it:
     - for each recorded call without a result, it reads what the trust layer did with that call's key (`findToolCallResult`) and records `done`, `awaiting_approval` or "not run";
     - it never calls a tool or the model again, so a write never runs twice or late;
     - the turn ends `interrupted`, and the model sees what was done with the next message.
8. **The deterministic fallback:** a fixed sentence per stop reason, what the turn already did (from the recorded outcomes), and a link to the matching screen (`/calendar`, `/clients`, `/team`, `/services`, To-dos on `/`). No model is involved.
9. **Chat over HTTP** (`apps/api/src/chat`, D8: SSE).
   - **`POST /v1/chat/turns`** (permission `ai.chat`, every role, own conversations) starts the turn and streams its events as server-sent events. The `id:` is the event's sequence, the `event:` its type, and the data is one line of JSON. A heartbeat goes every 15 s.
   - **The turn runs in the background.** Its events go to a Redis stream (`<seq>-0` ids, kept 1 h) that every reader follows, so **`GET /v1/chat/turns/:id/events` with `Last-Event-ID` resumes on any instance**. An expired log is rebuilt from the conversation.
   - **`POST …/cancel`** asks, through Redis, whichever instance runs the turn to stop it.
   - **History** comes from `GET /v1/chat/conversations` and `GET /v1/chat/conversations/:id`.
   - **New error codes:** `turn_in_progress` (409) and `conversation_not_found` (404).
   - **Configuration:** the OpenAI settings come from `@pepper/ai/config` (zod only, so the tracing preload stays clean). No key means the AI is off and chat answers `ai_off`.
   - **The web forwarder** passes `Last-Event-ID` on and times out only until the api answers. Before this change it cut every stream at 10 s.
10. **Observability:**
    - A `chat.turn` span, with `chat <model>` and `execute_tool <tool>` spans under it, after the GenAI semantic conventions: model, tokens including cache reads, finish reason, route, step and error type.
    - **No prompt, completion, arguments, answers or people's ids**, tested with an in-memory exporter.
    - The prompt-cache key and the provider's safety id are hashes, never ids.
11. **Evals on the loop:**
    - **The subject:** every case runs through `startTurn` with the real tools and trust layer, in a freshly seeded world on Postgres ("juniper"). It is judged on its calls (against the registry's schemas), its replies, and the business afterwards.
    - **Cassettes name seeded records with placeholders** (`{{client:maria}}`). They are filled in on replay and put back before fingerprinting, with created ids numbered, so a recording stays valid in a fresh world.
    - **Failures surface:** a cassette miss or a stale entry fails the run, rather than becoming a fallback reply.
    - **The CLI** runs on a throwaway Postgres in Docker, or on `EVAL_DATABASE_URL`.
    - **Cost:** the run estimate counts every step of every turn (the most a run can cost).

## Consequences
- **Gains:**
  - **The hostile fake through the real loop: 100% stopped, nothing written, as owner and as staff.** This holds turn after turn in one conversation, and with all attacks in one answer.
  - An injection through untrusted data that would email a client waits for a person, even on "just do it".
  - Nothing runs twice, through a retry, a concurrent copy, or a server that stopped after a write; each is proven on Postgres.
  - AC-X-2 is proven through HTTP: with the model down, chat answers with the fallback and a link, the breaker stops calling, and every other screen works.
  - Every eval set runs end to end on the fakes in CI (25 cases, all gates met, $0). S27 only swaps the model.
  - The prefix layout puts everything per-business after the shared part, and fixes the clock per turn, so steps within a turn share the cache.
- **Costs and risks:**
  - **The token estimate is a heuristic** (±20% expected). The reservation errs high, and S27 calibrates it against the provider's reported input tokens.
  - **Chat depends on Redis** for limits, events and cancel. Without Redis, chat answers 503 and the other screens are unaffected.
  - **A turn whose instance dies loses its live stream.** The reader then gets `interrupted` after the deadline, and the next message recovers the records.
  - **The full eval run estimate** (every case at every step) exceeds the $1.50 per-run cap, so S27 runs the sets separately or raises the cap explicitly.
  - **Recorded cassettes** whose later steps reference ids created in the run need those ids mapped. Numbering keeps fingerprints stable; a response naming a created id is S27's to handle if it occurs.
  - **The adapter sends `prompt_cache_key` only.** The newer models' `prompt_cache_options` and breakpoints are for S27, once the model is chosen.
  - **Receipts refer to the request message by id;** after 90 days *Why?* shows "message no longer kept".

## Alternatives considered
- **WebSocket instead of SSE:** two-way, but more moving parts and less proxy-friendly. Chat's actions (approve, undo, cancel) are plain REST (D8).
- **Running the turn inside the HTTP request and cancelling it when the client leaves:** simpler, but a dropped mobile connection would abandon a half-done plan. Chosen instead: the turn finishes within its bounds, the events stay readable, and only an explicit stop cancels it.
- **Re-dispatching an abandoned turn's calls on recovery:** the trust layer is idempotent, so a write already done is found again, but a write never started would then run late. Recovery only reads.
- **A tokenizer dependency for trimming:** exact counts, but a large native or WASM package for a heuristic that only bounds history. S27 calibrates instead.
- **Owners reading staff chats:** oversight, but chats are personal. Leads already see every proposal and receipt the AI made for staff.
- **Reserving tokens in a separate table or in Redis:** more parts. One conditional upsert of the existing counter is atomic and already tenant-isolated.

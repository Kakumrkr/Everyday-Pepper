# Phase 6 Playbook — AI agent + trust layer

> **Status: Confirmed by the user (S22, 2026-10-20).** Every Phase 6 session (S22–S27) reads this file with `CLAUDE.md` and `STATUS.md`: the cross-cutting parts (1–6 and 9) always, and its own section in 7. Changes to it after confirmation follow the PCR process.
>
> Builds on [ai-agent-and-trust-layer.md](../architecture/ai-agent-and-trust-layer.md), [ADR-0004](../adr/0004-llm-provider-adapter.md), [ADR-0005](../adr/0005-model-proposes-domain-decides.md), [voice-readiness.md](../architecture/voice-readiness.md) and the acceptance criteria W2, W7 and X. References are in section 9.

## 1. What we are building and why it wins

**The market in October 2026** (desk research, S22; most sources are competitors' blogs and contradict each other, so details are indicative): salon and wellness tools added AI in three shapes:
- **Paid add-on receptionists** that answer clients by phone or text: Boulevard "Beau" (reported ~$125/mo per location, beta), Fresha AI Concierge (reported, availability unclear), Vagaro and GlossGenius add-ons.
- **"Ask your data" assistants** that answer but do not act: Vagaro "Vera", GlossGenius "Growth Analyst".
- **Marketing copy writers.**

**The gap:** nobody ships an AI that *does the owner's and team's work inside the business* with permissions, an exact preview, a reason for every action, undo, and a per-action trust setting. That is Pepper's Phase 6. We deliberately do **not** build a client-facing receptionist in V1 (V3 scope; commoditising; telephony cost).

**Five differentiators Phase 6 must make obvious** (each has a test hook):

| # | Differentiator | What the user sees | Proven by |
|---|---|---|---|
| D-1 | **Exact previews** | The confirm card shows exactly what will change and which emails would go out, computed by the real domain service in a rolled-back dry run, never the model's guess | Preview = execution contract test for every write tool |
| D-2 | **Receipts: Why + Undo on everything** | Every AI action has one record: what I did, *Why?* (built from facts, not model prose), Undo; Undo also cancels unsent emails | AC-W2-3, AC-W7-1 |
| D-3 | **Follow-through** | "Remind me to call Maria Friday" becomes a to-do with a push (S21 tasks) | Eval cases + task integration test |
| D-4 | **Team-aware** | Staff get the same AI, limited to their own permissions; it explains a refusal | AC-W2-4, role-matrix tests through tools |
| D-5 | **Private and dependable** | Clients' emails and phone numbers never go to the AI provider; every screen works when the AI is down; AI included in the price | Prompt-content test, AC-X-2 |

## 2. Quality bar (measured, not hoped for)

| Metric | Target | How |
|---|---|---|
| Scheduling eval set | ≥ 90% pass (pass^1), ≥ 80% pass^3 | Section 5 |
| Safety + injection + permission set | **100%**, pass^3 on the real model **and** 100% against the hostile fake model | Section 5 |
| Writes without approval when the dial says "ask" | 0 | Trust-layer tests, evals |
| Wrong-action rate in the pilot | < 1% of AI actions undone as wrong (vision metric) | Metering of undo reasons |
| Latency | First streamed token ≤ 1.5 s p50; common read turn ≤ 3 s p50; a single tool ≤ 300 ms p95 (voice needs < 1 s reads later) | OTel spans, recorded in eval reports |
| Cost | ≤ $0.01 per typical turn on the routine model; per-business monthly cap | Metering, eval reports |
| Provider down | All non-AI screens fully work; chat shows a clear fallback | AC-X-2 test with a failing provider |

## 3. Design principles (decided once for the whole phase)

1. **The model proposes, the domain decides** (ADR-0005). Tools are thin adapters over the same services as the UI. The model never sees or picks a tenant id, user id or role; they come from the session.
2. **Assume the model is compromised.** Safety comes from the domain, the risk tiers and the autonomy dial, not from the prompt. Prove it with a **hostile fake model** that tries everything bad (section 5). The real model only has to be *useful*; it never has to be trusted.
3. **Few, excellent tools.** About 10 tools in V1, named `verb_noun`, each with a precise description (descriptions are prompts). No generic "update anything" tool. Quality of six core tools beats twenty mediocre ones.
4. **Strict schemas, validated twice.** Tool argument JSON Schemas are generated from the Zod schemas in `packages/contracts` (strict mode: every field required, optional ones nullable, no extra properties), and the arguments are parsed again with Zod before any handler runs. An invalid call is returned to the model as a tool error, never executed.
5. **The model never does date math or id lookup in its head.** The prompt carries "now" and a 14-day date table in the business time zone; tools take local date/time strings in the business zone and the domain converts (existing `fromZoned`). Names are resolved by a lookup tool; **ambiguity returns a choice card, never a guess** ("Two Sarahs — which one?").
6. **Preview, then commit with a fingerprint.** A write first runs as a dry run (transaction rolled back) producing a typed diff and the would-be outbox messages. A proposal stores the exact payload plus a fingerprint of the state it was previewed on; approving a stale proposal re-runs the preview and asks again instead of writing something the user never saw.
7. **Idempotent by construction.** Each tool execution carries an idempotency key derived from (conversation, turn, tool call); retries of a turn or a double tap on Approve never double-book or double-send.
8. **Undo is a domain operation.** The inverse runs through the same services (rules still apply), within an undo window, cancels unsent outbox messages, and refuses with an explanation when the world has moved on (the slot was rebooked, the email already left).
9. **Explanations are assembled, not generated.** *Why?* is built deterministically from the recorded trace: the user's words, the tools called with their inputs, the rules and facts used, alternatives offered. A model-written sentence may summarise it but is labelled and never the only source. No hidden prompts, no other tenant's data.
10. **Untrusted text is data.** Client notes, booking-page messages, imported files, calendar text and (Phase 9) web pages are wrapped and labelled as untrusted in tool results ("spotlighting"); they can never raise autonomy. A turn whose context contains untrusted text cannot run an `external_or_irreversible` action without a confirmation card, whatever the dial says.
11. **Minimum data to the provider.** The model sees client ids, first names and the facts needed for the task; never emails, phone numbers, manage tokens or secrets. Requests go with `store: false` and data-sharing off; zero-retention eligibility checked before the pilot.
12. **Cheap by layout.** Static prefix first (system prompt, tool definitions, template fragment), variable content last, so the provider's prompt cache hits; routine turns on the small model; escalate to the stronger model only by rule (multi-step plan, repeated invalid arguments, onboarding extraction).
13. **Bounded loop, graceful exit.** Max steps per turn (start at 6), wall-clock limit (20 s), per-tool timeouts; reads may run in parallel, writes run one at a time. When a limit or the provider fails: a deterministic fallback message with a link to the matching screen.
14. **Transport-agnostic core** (voice readiness). The agent works on a `Turn` (input, events out); HTTP/SSE is an adapter. Every tool result has a short spoken-friendly `summary`. Conversations have a `channel`.
15. **Observable without PII.** OpenTelemetry spans per turn, model call and tool, following the GenAI semantic conventions (model, tokens, cache hits, latency, finish reason); prompt and completion contents are never logged.

## 4. OpenAI budget policy — $5 total (user, 2026-10-20)

- **$5 of credit, hard monthly limit set on the OpenAI account by the user. That is the whole budget for Phase 6.**
- **S22–S26 spend $0.** All development, tests and evals run on the fake provider, scripted cases and recorded fixtures shaped like OpenAI's documented responses. No API key is needed or present until S27.
- **Real calls only at the final stage (S27)**, in this order, each step only if the previous one is green:

  | Step | What | Estimated spend |
  |---|---|---|
  | 1 | Smoke: 5 cases on the routine model, to confirm the adapter against the live API | ≤ $0.10 |
  | 2 | Full eval run, pass^1, routine model (~120 cases) | ~$1.50 |
  | 3 | Safety set pass^3 + re-run only the failed cases after fixes | ~$1.50 |
  | 4 | Reserve (stronger-model comparison on the hardest 20 cases, or one more fix round) | ~$1.50 |

  (Assumes ~12k input / ~1k output tokens per case at small-model prices of roughly $0.20–0.75 per million input and $1.25–4.50 per million output; third-party price figures conflict, so S27 re-checks OpenAI's official pricing page first.)
- **Guards in code, not just discipline:** the eval runner estimates a run's cost before starting and refuses above a per-run cap (default $1.50) unless told otherwise; it records actual tokens and cost per run in a ledger (`docs/plan/ai-budget.md`, created in S27) and stops at $4.50 cumulative. Every real response is **recorded as a cassette** so later runs, CI and regression checks replay it for free.
- CI never calls OpenAI (testing-strategy rule).

## 5. Evaluation strategy (the eval runner is a product feature)

- **Case format** (Zod, in `packages/ai/evals`): a seeded **world** (fixture business from a template: staff, services, rules, bookings, clients, facts), the **actor** (role), one or more user messages, and **expectations**: tool calls and argument matchers, the final database state (τ-bench style: judge the outcome, not the wording), the card types shown, and `mustNot` (no write, no email, no other client's data in the reply).
- **Deterministic graders first.** Tool, arguments, state and card checks are code. LLM-as-judge is not used in Phase 6 (it costs budget and adds noise); reply tone is reviewed by hand on samples.
- **Sets:** `scheduling` (book, move, cancel, conflicts → 3 nearest slots AC-W2-1, multi-step), `ambiguity` (two Sarahs, "next Friday" near month ends, DST weeks, unknown service), `permissions` (staff vs others' bookings AC-W2-4, roles), `autonomy` (ask/notify/auto per action, AC-W2-2, bulk lock AC-W7-3), `safety` (injection in client notes and booking messages, requests for other businesses, "ignore your rules", secrets, PII exfiltration), `failure` (tool errors, provider timeout, partial results), `follow_through` (to-dos and reminders).
- **Three providers run the same cases:**
  1. **Scripted fake** — replays the expected model behaviour; tests the runner, tools, trust layer and cards end to end. Free, in CI.
  2. **Hostile fake** — a scripted adversary that calls tools with other tenants' ids, out-of-schema arguments, bulk sends, raised autonomy, writes after "ask". **Every attack must be stopped by the domain.** Free, in CI, 100% gate. This is our strongest safety proof and does not depend on any model.
  3. **OpenAI** — S27 only, under the budget policy, recorded to cassettes; afterwards CI replays the cassettes.
- **Reliability metric:** pass^k (the same case k times must pass every time), k = 3 for safety in S27.
- **Report:** pass rates per set, failing cases with a diff, tokens, estimated cost, latency per tool; written as a file and summarised in the session log.
- **Eval gate:** any change to a prompt, tool description, tool schema or model id must pass the free sets in CI; real-model re-runs happen only on cassette misses and are budgeted.

## 6. Security checklist (OWASP Top 10 for LLM Applications 2025 mapping)

| Risk | Our control | Session |
|---|---|---|
| LLM01 Prompt injection | Untrusted-data labelling; injection can't raise autonomy; external actions after untrusted context need a card; hostile-fake and injection evals | S24, S25, S27 |
| LLM02 Sensitive information disclosure | Minimum data to the provider; no contacts or tokens in prompts; RLS on every new table; replies checked for other clients' data in evals | S23–S25 |
| LLM03 Supply chain | Pinned `openai` SDK only in `packages/ai`; `pnpm audit --prod` | S22 |
| LLM05 Improper output handling | Model text rendered as plain text (no HTML/Markdown links executed); cards are typed payloads validated by Zod | S26 |
| LLM06 Excessive agency | Risk tiers, autonomy dial bounded by tier, bulk lock, permissions via `can()`, few narrow tools | S23, S24 |
| LLM07 System prompt leakage | No secrets in prompts; leakage is harmless by design; eval checks refusals | S25, S27 |
| LLM09 Misinformation | Answers about the business come from tools, not memory; "I don't know" over guessing; facts cited in *Why?* | S24, S25 |
| LLM10 Unbounded consumption | Per-business monthly token budget (soft 80%, hard 100% → AI paused, screens work), per-user rate limit, step/time limits | S22, S25 |

(LLM04 data poisoning and LLM08 vector weaknesses belong to Phase 7 memory.)

## 7. Session guides

### S22 (6a) — Provider adapter, fake providers, metering, eval skeleton
- **Build:** `contracts/ai.ts` (messages, tool definitions, tool calls, usage, provider errors); `packages/ai` with the `LlmProvider` port (`respond`, `stream`; `embed` declared for Phase 7), the scripted `FakeProvider`, the OpenAI adapter (official `openai` SDK, pinned; Responses API, `store: false`; model ids from validated env), a shared provider contract-test suite, a metering wrapper that records `llm_tokens` per business, the eval case format, runner and report with 3 sample cases on the fake. ADR-0027.
- **Think hard about:** a provider-neutral message model that maps cleanly onto both OpenAI's Responses API and a future provider; mapping every provider failure (timeout, 429, 5xx, refusal, malformed arguments, content filter) to our own error codes; streaming events (`text_delta`, `tool_call`, `done`, `error`) as a discriminated union.
- **Pitfalls:** letting SDK types leak out of `packages/ai`; counting tokens only on success (failed calls cost money too); a test that needs a key.
- **Tests:** the contract suite runs against the fake and against the OpenAI adapter through the recording HTTP server with fixtures shaped like OpenAI's documented responses; metering integration test on Postgres; runner unit tests.

### S23 (6b) — Trust layer data and decisions
- **Build:** tables `ai_action_proposals` and `ai_action_executions` (tenant-owned, RLS, `member_scope` for staff, in the isolation suite), per-business autonomy settings (table or tenant column, defaults from the template), the pure `decideAutonomy(action, tier, settings, context)` (incl. "untrusted context forces ask for external actions" and the bulk lock), proposal lifecycle (pending → approved/rejected/expired/superseded), execution record with actor `ai_on_behalf_of:user`, idempotency key, before/after, undo record and explanation trace, outbox links. Audit actions for each. ADR-0028.
- **Think hard about:** the state fingerprint for stale-proposal protection; undo windows per action; who may approve (the proposer's permissions are re-checked at approval time, by the approver's role).
- **Pitfalls:** an approval path that skips `can()`; undo that writes directly instead of through services; storing client contacts inside proposal payloads (store ids).
- **Tests:** property tests for `decideAutonomy` over all actions × levels × tiers × contexts; repository + RLS + isolation; concurrent approve/undo; expiry.

### S24 (6c) — Tool registry and the first tools
- **Build:** the registry (name, description, Zod args, `riskTier`, `actionType`, `preview`, `execute`, `inverse`, `toCard`, `summary`), and about ten tools:
  - reads: `find_availability`, `find_clients`, `get_day` (schedule summary), `get_booking`, `list_services_and_staff`;
  - writes: `create_booking`, `move_booking`, `cancel_booking`, `block_time`, `add_todo`.
- Each write tool's dry run produces the typed diff and the would-be emails; conflicts return the 3 nearest valid slots (AC-W2-1) as a SlotPicker payload.
- **Think hard about:** descriptions as prompts (when to use, when not to, what the arguments mean, in business-zone local time); returning domain errors as model-readable tool results with a stable code; staff scope.
- **Pitfalls:** a tool that accepts a `tenantId` or `staffId` it should infer; returning whole rows (PII) to the model; tools that chain writes.
- **Tests:** per tool: schema tests, preview = execution contract test (D-1), inverse restores state, role matrix through the tool (AC-W2-4), cross-tenant ids rejected; the hostile fake's attacks against every tool.

### S25 (6d) — Agent loop and conversations
- **Build:** `conversations` and `conversation_messages` (tenant-owned, RLS, own-only for staff, `channel`, retention), the `Turn` abstraction, context assembly (static prefix → template fragment → business preferences → date table → recent messages, with untrusted data labelled), the loop with step/time limits and parallel reads, model routing rules, per-business budget (soft/hard) and per-user rate limit, the fallback reply, SSE endpoint `POST /v1/chat/turns` streaming typed events with resume (D8: SSE), OTel spans. ADR-0029.
- **Think hard about:** what goes into the static prefix (cache hits = cost); trimming history by tokens; a turn that produces several writes becomes one plan card; cancelling a turn when the user leaves.
- **Pitfalls:** history that re-sends untrusted text without its label; logging message contents; holding a DB transaction across a model call.
- **Tests:** loop unit tests with the scripted fake (limits, errors, parallel reads, fallback), SSE contract test, budget and rate-limit integration tests, AC-X-2 with a failing provider; all eval sets green on the fakes.

### S26 (6e) — Chat screen, cards, Why, Undo, Autonomy settings
- **Build:** Chat on the PWA (mobile-first, one-hand, suggestion chips), card components shared with the future feed (`@pepper/ui`): Booking, SlotPicker, ChangeDiff, Confirmation, ClientChoice, ToDo; the *Why?* sheet; Undo with the window shown; "Done for you" receipts; the Autonomy settings page (grouped by risk, bulk lock visible); the AI-unavailable state. Follows the approved prototype (`docs/mockups/pepper-prototype.html`).
- **Think hard about:** Microsoft's human-AI guidelines (make clear what the AI can do, support efficient correction and dismissal, explain why, remember recent interactions) and the PAIR guidebook (explainability and trust); streaming text that never jumps the layout; accessible cards (axe).
- **Pitfalls:** rendering model text as HTML; a confirm button that approves a different payload than shown; no feedback while the model thinks.
- **Tests:** component tests per card, Playwright journeys on the scripted fake (book with conflict → slot picker → confirm → undo; staff refusal; ask vs notify; provider down), axe.

### S27 (6f) — Real-model evals, model choice, security review, Phase 6 exit
- **Build/run:** the budget ledger; the full eval sets (~120 cases) under the budget policy (section 4); model choice for routine and stronger turns (D5) based on pass rate, latency and cost; cassettes recorded and replayed in CI; Phase 6 security review (`docs/engineering/security-review-s27.md`) against section 6; Phase 6 exit criteria.
- **Think hard about:** fixing failures in tool descriptions and domain answers before touching the system prompt; never "teaching to the test" (hold out 20% of cases written before the run).
- **Pitfalls:** spending budget on re-runs that cassettes can answer; changing several things before re-running.
- **Done when:** scheduling ≥ 90%, safety 100% (pass^3), hostile fake 100%, AC-W2-1..4, AC-W7-1, AC-W7-3, AC-X-2 green; spend ≤ $5 recorded.

## 8. Explicitly not in Phase 6
Memory facts and recall (Phase 7, but the prompt assembly leaves a slot), operator feed and daily briefing (Phase 8), onboarding extraction (Phase 9), voice (V2), a client-facing AI (V3), sending emails composed freely by the model (drafts arrive with the feed in Phase 8; Phase 6 emails are the existing domain templates).

## 9. Keep getting better (every Phase 6 session, and Phases 7–9 after it)
This layer is the product, so each session also looks for a better way, not only the planned way (user, S22):
- **Before building:** re-check the references for your session and the provider's current docs (APIs, models, prices and recommended patterns move monthly); if something newer is clearly better, say so in the Session Brief with the trade-off.
- **While building:** when a test, eval failure or review shows a weakness in an earlier session's design, fix it in this session if it is small, or log it below and raise it.
- **At the end:** add one to three lines to the improvement log below: what we learned, what to try next, what the next session should do differently. Ideas that change an approved plan go through a PCR; the rest the next session simply picks up.
- **Ideas already queued** (consider them at the session named): per-tool latency budget checks in CI (S24); conversation "undo the whole turn" (S26); a weekly "what Pepper did for you" receipt summary (Phase 8 feed); learning the owner's phrasing ("the usual" = her regular service) from confirmed facts (Phase 7); A/B comparison of tool descriptions on cassettes before spending budget (S27); a public safety page listing what the AI can never do (pilot).

### Improvement log
| Session | Learned / next try |
|---|---|
| S22 | _(filled at the end of S22)_ |

## 10. References (read the ones named in your session)
- Anthropic, *Building effective agents* (2024) — simple composable patterns over frameworks, tool design ("agent-computer interface"): https://www.anthropic.com/engineering/building-effective-agents
- OpenAI, *A practical guide to building agents* (2025) — guardrails, human intervention for high-risk actions: https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/
- OpenAI docs — function calling and Structured Outputs (strict schemas): https://developers.openai.com/api/docs/guides/function-calling · prompt caching (static prefix first, `prompt_cache_key`, `cached_tokens`): https://developers.openai.com/api/docs/guides/prompt-caching · pricing (re-check at S27): https://developers.openai.com/api/docs/pricing
- OWASP, *Top 10 for LLM Applications 2025*: https://genai.owasp.org/llm-top-10/
- Debenedetti et al., *Defeating Prompt Injections by Design* (CaMeL, Google DeepMind, 2025): https://arxiv.org/abs/2503.18813 · Beurer-Kellner et al., *Design Patterns for Securing LLM Agents against Prompt Injections* (2025): https://arxiv.org/abs/2506.08837 · Simon Willison's review of the patterns: https://simonwillison.net/2025/Jun/13/prompt-injection-design-patterns/
- Hines et al., *Defending Against Indirect Prompt Injection Attacks With Spotlighting* (Microsoft, 2024): https://arxiv.org/abs/2403.14720
- Yao et al., *τ-bench: tool-agent-user interaction in real-world domains* (pass^k, judge the final state): https://arxiv.org/abs/2406.12045 · Sierra's write-up: https://sierra.ai/blog/benchmarking-ai-agents
- Hamel Husain, *Your AI product needs evals*: https://hamel.dev/blog/posts/evals/
- Microsoft, *Guidelines for Human-AI Interaction* (18 guidelines, HAX toolkit): https://www.microsoft.com/en-us/research/project/guidelines-for-human-ai-interaction/
- Google PAIR, *People + AI Guidebook* (explainability and trust, errors): https://pair.withgoogle.com/guidebook/
- Stripe, *Designing robust and predictable APIs with idempotency*: https://stripe.com/blog/idempotency
- OpenTelemetry, *Semantic conventions for generative AI*: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- Market scan sources (S22): https://agentplace.io/blog/which-salon-software-has-built-in-ai · https://www.probeauty.ai/blog/best-salon-software-ai-features-2026 · https://bellabooking.com/compare-feature/ai-features

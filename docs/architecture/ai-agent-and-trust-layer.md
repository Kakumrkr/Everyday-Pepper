# AI Agent & Trust Layer

> Provides: agent loop, tool registry, cards, autonomy, explanations, undo · Depends on: core domain services, memory, contracts · Consumed by: chat, operator feed, onboarding, voice (V2)

## Principle: the model proposes, the domain decides
The LLM selects tools and fills arguments. It never accesses the database, never chooses the tenant, and never bypasses domain validation. AI and UI share one code path.

## Components (`packages/ai`)
- **Provider adapter** (S22, [ADR-0027](../adr/0027-llm-provider-port-and-evals.md)) — `LlmProvider` (`respond`, `stream`; `embed` joins in Phase 7) over provider-neutral contracts (`contracts/ai.ts`). Default implementation: OpenAI's Responses API with `store: false` and encrypted reasoning replay. Model IDs are config per route (`routine`, `strong`), not code. A cheap/fast model handles routine turns; a stronger model is used for multi-step planning and onboarding extraction. Tool argument schemas are strict JSON Schema generated from Zod.
- **Tool registry** — each tool: `name`, Zod argument schema (from `packages/contracts`), `riskTier`, `actionType` (for autonomy), `handler` → domain service, `toCard` renderer, eval cases.
- **Agent loop** — context assembly → model call → tool calls (max N steps, timeout) → result → reply with cards. Deterministic fallback message when limits are hit or the provider fails.
- **Prompt assembly** — system prompt + template fragments (L3) + tenant preferences (L4) + recalled memory. Untrusted content (client notes, imported data, calendar text, web pages) is wrapped and labelled as data.
- **Evals** — golden conversations with expected tool calls/arguments, refusals, and confirmation behaviour; deterministic graders, pass^k, cassettes replayed in CI, a budget guard for real runs; gate prompt/model/tool changes. Plan and quality bar: [Phase 6 playbook](../plan/phase-6-playbook.md).

## Risk tiers
| Tier | Examples | Default autonomy | Can be "just do it"? |
|---|---|---|---|
| `read` | availability, lookup, summaries | auto | yes |
| `internal_write` | create/move booking, add note, block time | do it and tell me (undo shown) | yes |
| `external_or_irreversible` | email a customer, cancel with notification, bulk change | ask me | single-recipient only; never for bulk (>10) |

## Autonomy dial
Per tenant, per `actionType`: `ask` / `notify` / `auto`, bounded by tier rules above. Stored in tenant settings; editable in Autonomy settings page; the AI can propose changes ("Want me to auto-confirm bookings from now on?") but changing autonomy is itself an `ask` action.

## Action records
- `ActionProposal` — pending action with exact payload, explanation, expiry; approved/rejected by a user.
- `ActionExecution` — executed action: actor (`user` | `ai_on_behalf_of:user`), idempotency key, before/after snapshot, **undo record** (inverse operation + window), explanation, links to outbox messages.
- **Undo** runs the inverse through domain services (so rules still apply) and cancels pending outbox messages not yet sent.

## Explanations ("Why did you do that?")
Stored per action: user request, tools called, key facts/rules used, alternatives considered. Rendered in plain language. Never includes other tenants' data or hidden prompts.

## Cards
Typed card payloads (`packages/contracts/cards`): Booking, SlotPicker, ChangeDiff, ClientSummary, Suggestion, Confirmation, ImportReport. The same React components render in chat and in the feed.

## Guardrails
Per-tenant token/cost budgets with soft/hard limits; rate limits per user; max tool steps; PII minimisation in prompts; OpenAI data controls set so API data is not used for training (verify zero-retention eligibility before pilot).

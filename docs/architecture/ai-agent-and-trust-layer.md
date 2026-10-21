# AI Agent & Trust Layer

> Provides: agent loop, tool registry, cards, autonomy, explanations, undo · Depends on: core domain services, memory, contracts · Consumed by: chat, operator feed, onboarding, voice (V2)

## Principle: the model proposes, the domain decides
The LLM selects tools and fills arguments. It never accesses the database, never chooses the tenant, and never bypasses domain validation. AI and UI share one code path.

## Components (`packages/ai`)
- **Provider adapter** (S22, [ADR-0027](../adr/0027-llm-provider-port-and-evals.md)) — `LlmProvider` (`respond`, `stream`; `embed` joins in Phase 7) over provider-neutral contracts (`contracts/ai.ts`). Default implementation: OpenAI's Responses API with `store: false` and encrypted reasoning replay. Model IDs are config per route (`routine`, `strong`), not code. A cheap/fast model handles routine turns; a stronger model is used for multi-step planning and onboarding extraction. Tool argument schemas are strict JSON Schema generated from Zod.
- **Tool registry** (S24, [ADR-0029](../adr/0029-tool-registry-and-tools.md), `packages/ai/src/tools`). Ten tools:
  - reads: `find_availability`, `find_clients`, `get_day`, `get_booking`, `list_services_and_staff`;
  - writes: `create_booking`, `move_booking`, `cancel_booking`, `block_time`, `add_todo`.

  Each tool has a name, a version, a guide (use, don't use, returns, examples → the description and generated eval cases), strict Zod arguments in the business's local time, a risk tier and its dial actions (a write that may email the client adds `message.confirmation`).

  `dispatchToolCall` is the one entry point from the model. It parses the arguments twice, takes the business and the member from the session, runs reads in a member transaction and sends writes through the trust layer. Refusals come back as stable codes with SlotPicker, ClientChoice and Change cards (`contracts/tool-cards.ts`).

  A write implements `ActionRunner` with one `perform` through the domain's transaction-taking services. The trust layer runs its preview in a savepoint it always rolls back, so the preview *is* the execution (D-1).

  The model sees ids, local times, names and a client's first name and last initial: never a contact. A hostile fake (`hostile.ts`) attacks every tool, a 100% gate.
- **Agent loop** — context assembly → model call → tool calls (max N steps, timeout) → result → reply with cards. Deterministic fallback message when limits are hit or the provider fails.
- **Prompt assembly** — system prompt + template fragments (L3) + tenant preferences (L4) + recalled memory. Untrusted content (client notes, imported data, calendar text, web pages) is wrapped and labelled as data.
- **Evals** — golden conversations with expected tool calls/arguments, refusals, and confirmation behaviour; deterministic graders, pass^k, cassettes replayed in CI, a budget guard for real runs; gate prompt/model/tool changes. Plan and quality bar: [Phase 6 playbook](../plan/phase-6-playbook.md).

## Risk tiers
| Tier | Examples | Default autonomy | Can be "just do it"? |
|---|---|---|---|
| `read` | availability, lookup, summaries | auto | yes |
| `internal_write` | create/move booking, add note, block time | do it and tell me (undo shown) | yes |
| `external_or_irreversible` | email a customer, cancel with notification, bulk change | ask me | single-recipient only; never for bulk (>10) |

The dial's eleven actions, their tiers, defaults, approval permissions and undo windows are `AUTONOMY_ACTIONS` in `packages/contracts/src/trust.ts` (PCR-003 added `booking.cancel` and `task.create`). A tool call involving several actions (a move that emails the client) follows the strictest; the bulk lock counts the recipients the domain's preview found, whatever the action ([ADR-0028](../adr/0028-trust-layer-proposals-executions-and-autonomy.md)).

## Autonomy dial
Per tenant, per `actionType`: `ask` / `notify` / `auto`, bounded by tier rules above, plus an "Ask me first for everything" switch. Stored in `autonomy_settings` (S23, overrides only; else the template's default, else the platform's); editable in the Autonomy settings page (S26) by owners and managers; the AI can propose changes ("Want me to auto-confirm bookings from now on?") but changing autonomy is itself an `ask` action and the AI can never make it. `decideAutonomy` (pure, property-tested) is called inside the trust layer from the domain's own preview, so no caller can skip it; untrusted text in the turn makes external actions ask and quiet writes visible.

## Action records (S23, [ADR-0028](../adr/0028-trust-layer-proposals-executions-and-autonomy.md))
- `ActionProposal` (`ai_action_proposals`) — pending action with the exact payload, the domain's preview, the **state fingerprint** it was previewed on, explanation, expiry (24 h, never past the appointment); one pending per target; approved/rejected by a person, or expired/superseded. Approval re-runs the preview in its transaction: a different fingerprint supersedes it with a fresh proposal instead of running. Only the member it was made for, or an owner/manager, decides, with their own role re-checked at that moment.
- `ActionExecution` (`ai_action_executions`) — executed action: actor (audit kind `ai_on_behalf_of` with the member), idempotency key, before/after snapshot, **undo record** (inverse + `undo_until`), explanation, links to outbox messages. Written in the same transaction as the change; never changed afterwards (triggers), never deleted by the services.
- **Undo** runs the inverse through domain services as the member (so rules still apply), within the action's window, and takes back outbox messages not yet sent (status `cancelled`); AI-queued client emails wait 2 minutes first ("undo send"). If the world moved on, nothing changes.
- **The tool port** `ActionRunner` (`preview`, `execute`, `undo`) runs inside the trust layer's transaction; S24 tools implement it.

## Explanations ("Why did you do that?")
Stored per action: user request, tools called, key facts/rules used, alternatives considered. Rendered in plain language. Never includes other tenants' data or hidden prompts.

## Cards
Typed card payloads (`packages/contracts/cards`): Booking, SlotPicker, ChangeDiff, ClientSummary, Suggestion, Confirmation, ImportReport. The same React components render in chat and in the feed.

## Guardrails
Per-tenant token/cost budgets with soft/hard limits; rate limits per user; max tool steps; PII minimisation in prompts; OpenAI data controls set so API data is not used for training (verify zero-retention eligibility before pilot).

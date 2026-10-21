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
- **Agent loop** (S25, [ADR-0030](../adr/0030-agent-loop-and-conversations.md), `packages/ai/src/agent`) — a transport-agnostic `Turn`: `startTurn` gives `started` (with `run(emit, signal)`), `existing` (the same client turn id) or `busy`. Each step: context → token reservation → routing → the model's streamed answer → **its tool calls recorded before any runs** → reads in parallel, writes one at a time, only through `dispatchToolCall` → results recorded. Limits: 6 steps, 20 s, 5 writes and 8 calls per answer (`turn_limit`). Routine model by default, strong after step 3 or repeated bad calls, never past the soft budget. One retry, a circuit breaker, and a deterministic fallback with a screen link for every stop reason. An abandoned turn is recovered from the trust layer's records (never a second run). Events: `turn.started`, `text.delta`, `tool.started`, `tool.finished`, `message.completed`, `turn.completed`, `turn.failed`. OTel spans without contents.
- **Conversations** (S25) — `conversations`, `conversation_turns`, `conversation_messages`: own-only for every role, append-only messages with an `untrusted` label, one running turn per conversation, deleted 90 days after the last message. Chat over SSE: `POST /v1/chat/turns`, resume with `Last-Event-ID` (events in a Redis stream), cancel, history.
- **Prompt assembly** (S25) — static instructions + `toolDefinitions()` (shared prefix) → template fragments (L3) → the business and member (L4) → the turn's business clock → history trimmed by whole turns; recalled memory joins in Phase 7. Untrusted content is JSON-wrapped and labelled every time it is sent, and answers written after it are tainted too. Members' messages go without emails or phone numbers.
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

## Cards (S26, [ADR-0031](../adr/0031-chat-screen-cards-why-undo-and-autonomy-settings.md))
Typed card payloads (`contracts/tool-cards.ts`, validated with Zod in the browser): `change` (proposed or done, with the tool's own summary), `slot_picker`, `client_choice`, `booking`, `day`. The same React components in `@pepper/ui` render in chat and on Home (the Phase 8 feed takes them over): `ChangeCard` (confirmation and receipt), `SlotPicker`, `ClientChoice`, `BookingCard`, `DayCard`, `PlanCard` (a turn's changes, "Approve all" exactly as shown, in order), `WhyContent`, `ChatNotice`. Later: ClientSummary, Suggestion, ImportReport.

A card is a snapshot: each reads its record by id (`/v1/ai/proposals/:id`, `/v1/ai/actions/:id`) for its live state. Approve sends only the fingerprint the card showed; a stale card is replaced by the fresh proposal. Undo shows its window and says whether the client was already emailed. The AI's words are plain text, never HTML or Markdown (a lint rule); links come only from `ScreenLinkSchema`.

## Chat and settings screens (S26)
`/chat`: streamed text, resume with `Last-Event-ID`, Stop and cancel on leaving, suggestion chips, the AI off/paused/fallback states with a screen link (AC-X-2). `/autonomy`: the dial grouped by risk, the bulk lock shown, "Ask me first for everything"; owners and managers change it. A lead's approval of a staff member's proposal keeps the requester's "me", and the receipt is the staff member's too (migration 0036).

## Guardrails
Per-tenant monthly token budget reserved atomically before every model call (`AI_MONTHLY_TOKENS`, default 5M; soft at 80% → routine model only, hard → AI paused, screens work); rate limits per member (20 turns / 5 min), business and address; max steps, writes and time per turn; PII minimisation in prompts (no contacts, members' messages redacted); OpenAI data controls set so API data is not used for training (verify zero-retention eligibility before pilot).

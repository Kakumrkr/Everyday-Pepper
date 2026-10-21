# Project Status — read this first in every new session

**Last updated:** 2026-10-21 · **Plan version:** 0.21 · **Current phase:** 6 — AI agent + trust layer. **S25** (agent loop, conversations, SSE, budgets) done and merged → next: **S26** (chat screen, cards, Why, Undo, Autonomy settings)

This file is kept short. The full history is in [session-log.md](session-log.md) (what every session did, its checks and leftovers) and [decisions.md](decisions.md) (every decision made in chat). Open them when a task needs that history; they are not needed to start a session.

## In progress
**S26 (6e) started 2026-10-21** on `claude/epic-bardeen-hqs6l4`. Brief confirmed by the user: "Go ahead with your recommendations, draft PCR-004, ADR is pre-approved … I'm pre-approving the PCR and ADR; raise the PR and merge to main; give a prompt for the next session."
- **Decisions (user, brief):** migration 0036 (`tool_version` on proposals → expired on a version change; `requested_by_user_id` on executions so staff see a lead-approved receipt) recorded in ADR-0031 as an ADR-0028 amendment without a PCR; staff may undo what a lead approved for them while their role allows it; jsdom + Testing Library + axe-core as dev-only test deps in `packages/ui`; managers change autonomy (ADR-0028 wins over the prototype copy); ADR-0031 and PCR-004 pre-approved.
- **Also decided:** the api's 200 ms Redis polling for chat events and cancel stays; blocking `XREAD` + pub/sub is logged for Phase 11 (load test). PCR-004 adds S26b (tool gaps: `find_client_bookings`, `list_todos`, `complete_todo`, `unblock_time`) before S27; client notes go to Phase 7.
- **Tasks:** T1 contracts · T2 migration + core · T3 api endpoints · T4 scripted e2e provider · T5 ui cards · T6 chat screen · T7 Autonomy page + Home receipts · T8 Playwright · T9 docs, PR, merge.
- **Done:** T1 (contracts `ai-views.ts`, card `summary`, `ScreenLinkSchema` refuses `//host`); T2 (migration 0036, core/ai version expiry, requester and summary on receipts; db/core/ai integration green). T3 (`/v1/ai` proposals and receipts with Why, approve by fingerprint, reject, undo; `/v1/autonomy`; `/v1/chat/status`; resumed turns keep cards; **bug found and fixed:** a lead approving a staff member's "remind me"/"book me" turned "me" into the lead, now `ToolDeps.requester`). T4 (`E2eModel` behind `AI_SCRIPTED_PROVIDER=e2e`, refused outside local/ci and with a key; Compose passes the OpenAI vars and the switch; CI's e2e job sets it). T5 (`@pepper/ui` cards, Why content, chat notices, `labels.ts` wording; jsdom 28.1.0 (30 needs Node 22.22.2) + Testing Library + axe-core, 14 component tests). T6 (`/chat`: `chat-stream.ts` SSE client with resume, `chat-state.ts` reducer, `LiveChangeCard` approve by id+fingerprint/stale/refused/expired/undo, Why sheet, plan with Approve all, Stop + cancel on pagehide; lint bans raw HTML/Markdown). T7 (`/autonomy`, Home `AiActivity`, Autonomy link in chat). T8 (`e2e/tests/chat.spec.ts`, 6 journeys + axe; full e2e 72/72 locally on the headless shell; Docker image builds can't reach npm through the cloud proxy, so apps ran locally per dev-setup; found and fixed: focus not returned after Why?, dial not optimistic, a slot tap during a running turn was dropped). **Next:** T9 full checks, self-review, ADR-0031, PCR-004, docs, PR, merge.

## Last sessions
- **S25 Phase 6d (2026-10-21): agent loop, conversations, SSE, budgets** ([ADR-0030](../adr/0030-agent-loop-and-conversations.md), accepted). Full entry in [session-log.md](session-log.md).
  - **Code:**
    - `packages/ai/src/agent`: `startTurn`/`recoverTurn`, context and trimming (untrusted labels kept, taint, contacts redacted), routing, breaker, fallback, `otelTurnTracer`.
    - Conversations (migrations 0034–0035, own-only, 90-day clean-up); `reserveLlmTokens`; `findToolCallResult`.
    - `POST /v1/chat/turns` (SSE), resume with `Last-Event-ID`, cancel, history; rate limits; `AI_MONTHLY_TOKENS`.
    - Evals run through the loop in seeded worlds; the CLI on the registry.
  - **Checks:**
    - `pnpm check` green (contracts 537, core 1,190, ai 183, api 274, web 250).
    - `pnpm test:integration` green, 928 (+66): ai 72, api 69 (chat 7), db 506.
    - Hostile fake through the loop 100% (owner, staff); evals 25/25 on the fakes; AC-X-2 through HTTP. No OpenAI call.
  - **Found and fixed:**
    - Idempotency key ignored the step.
    - Turns used the database clock.
    - SSE streams hung (request `close`).
    - The web forwarder cut streams at 10 s.
    - A stale cassette became a fallback reply.
- **S24 Phase 6c (2026-10-21): tool registry and the first ten tools** ([ADR-0029](../adr/0029-tool-registry-and-tools.md), accepted). Full entry in [session-log.md](session-log.md).
  - **Code:**
    - `packages/ai/src/tools`: ten tools (five reads; `create_booking`, `move_booking`, `cancel_booking`, `block_time`, `add_todo` through the trust layer).
    - `dispatchToolCall`, `toolDefinitions`, and `approveToolProposal`/`undoToolAction` by id.
    - Error codes and cards in `contracts/tool-cards.ts`.
    - Guides with a lint and generated eval cases; the hostile fake (`hostileAttacks`, `hostileProvider`).
    - The trust layer runs every preview in a rolled-back savepoint (preview = execution).
    - Transaction-taking `*In` services with booking writes in savepoints; `reinstateBookingIn`, `withdrawTaskIn`; `queueBookingEmail` with the AI's hold.
    - Client names reach the model as first name and last initial.
  - **Checks:**
    - `pnpm check` green (ai 146, core 1,172, appointments 83).
    - `pnpm test:integration` green, 862: ai 57, with the hostile fake at 100% as owner and staff.
    - Mutation-checked. Per-tool p95 7–63 ms on 2,000 bookings.
    - No OpenAI call.
  - **Found and fixed:**
    - A time long past made the alternatives query fail (a 500 on the calendar too).
    - `get_day` with another business's staff id now answers `not_found`.
    - Approve and undo trusted the caller's object (now ids).
    - A racing retry answered `internal` (now one execution for all).

## Standing decisions (still in force)
Full wording and the history in [decisions.md](decisions.md).
- **Sessions:** one feature-sized goal per session, started with a Session Brief from this file; the user may run `/compact` before the PR when the context is long (checkpoints make that safe).
- **CI minutes:** one CI run per session: all checks locally first, every commit (docs, "ADR accepted", STATUS) in before the PR, pushes to an open PR only to fix CI; docs-only PRs skip the slow jobs; CI runs on PRs, weekly on `main` and by hand. **No retries in CI** (M1).
- **Free development setup:** Docker for Postgres + pgvector, Redis, SeaweedFS and Mailpit; free tiers of GitHub Actions, Sentry and Grafana Cloud; Google Calendar in testing mode.
- **OpenAI cost (user, S22):** $5 credit in total for Phase 6 with a hard limit, spent only at the final testing stage (S27); everything before runs on fake providers (playbook §4).
- **Skip domain, business email and LLC** until before the pilot (Phase 11); brand, trademark and domain checks then.
- **Design:** Pepper green + chili accent (PCR-002), Bricolage Grotesque + Figtree, warm and friendly, mobile-first (`docs/mockups/README.md`).
- **Email provider:** Resend for the pilot (D4, S19); Mailpit over SMTP in development and CI.

## Recent decisions
- **S25 (user, 2026-10-21, Session Brief):** "Go ahead with your recommendations, ADR is fine":
  - conversations own-only for every role; deleted 90 days after the last message;
  - 5M tokens per business per month (`AI_MONTHLY_TOKENS`), soft at 80%;
  - a turn keeps running when the connection drops (explicit cancel only);
  - ADR-0027/0029 amendments recorded in ADR-0030 without a PCR. D8 decided: SSE.
- **End of S25 (user, pre-approved at the brief):** "I'm pre approving the ADR. You have to raise PR and merge to main and at end give a perfect prompt to start the next new session."
- **S25 defaults (Claude, in ADR-0030):** limits 6 steps / 20 s / 5 writes; reads parallel, writes serial; tool calls recorded before they run, recovery only reads; strong model after step 3 or 2 bad calls, never past soft budget; breaker 3 → 30 s; rate limits 20 / 5 min per member; events in a Redis stream (1 h).
- **S24 (user, 2026-10-21, Session Brief):** "Go ahead with your recommendations, ADR-0029 is fine":
  - ADR-0029 for the tools; S25's ADR becomes ADR-0030;
  - `emailClient: null` means the screens' default (email), and the email stays a dial action;
  - Undo never emails the client;
  - staff find only their own clients.
- **End of S24 (user, pre-approved at the brief):** "I'm pre approving the ADR. You have to raise PR and merge to main and at end give a perfect prompt to start the next new session."
- **S24 defaults (Claude, in ADR-0029):**
  - preview = the domain's change in a rolled-back savepoint;
  - fingerprint only what a tool touches;
  - name-only client search;
  - target staff ids as arguments, identity never;
  - approve and undo by id;
  - per-tool budgets.

## Waiting on the user
1. Optional, not yet: create a free Sentry project and a Grafana Cloud stack and put `SENTRY_DSN` / `OTEL_EXPORTER_OTLP_*` in your local `.env` to see errors and traces (nothing is needed for development). The user deferred it after M1 and asked Claude to bring it up: **deferred again at S22 (user); raise it before the pilot (S27/Phase 11 briefs).**

(Done: "Require branches to be up to date before merging" is on for `main`, user, 2026-10-20.)

## Planned sessions (next first)
S1–S25 are done and merged (Phases 0–5, Phases 6a–6d). Phase 6 (AI agent + trust layer) runs S22–S27 as set in the [Phase 6 playbook](phase-6-playbook.md), whose §7 guides each session; details in [session-log.md](session-log.md).

| # | Session target | Phase | Done when |
|---|---|---|---|
| S26 | Chat screen on `POST /v1/chat/turns` (stream, cards, plan card for a turn's writes, cancel on close, AI-off and fallback states), Why, Undo, Autonomy settings (ADR-0031) | 6e | Playwright journeys on the scripted fake, axe |
| S27 | Real-model evals within the $5 budget, model choice, Phase 6 security review, exit | 6f | Scheduling ≥ 90%, safety 100% pass^3, spend ≤ $5 |

## How to resume in a new session
Start the session from the latest `main`. Say: *"Read CLAUDE.md and docs/plan/STATUS.md, give me the Session Brief, then continue."* During the session Claude keeps "In progress" current after each finished task; at the end it moves that session's summary into "Last sessions", appends the full entry to `session-log.md` and new decisions to `decisions.md`, and commits all three.

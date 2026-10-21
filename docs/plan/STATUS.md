# Project Status — read this first in every new session

**Last updated:** 2026-10-21 · **Plan version:** 0.20 · **Current phase:** 6 — AI agent + trust layer. **S24** (tool registry and the first ten tools) done and merged → next: **S25** (agent loop, conversations, SSE, budgets)

This file is kept short. The full history is in [session-log.md](session-log.md) (what every session did, its checks and leftovers) and [decisions.md](decisions.md) (every decision made in chat). Open them when a task needs that history; they are not needed to start a session.

## In progress
**S25 (6d), branch `claude/s25-agent-loop`.** The user approved the brief ("Go ahead with your recommendations, ADR is fine"), pre-approved ADR-0030, and asked Claude to open the PR, merge it, and end with the next session's prompt. Decisions: conversations own-only for every role; 90-day retention; 5M tokens per business per month (soft 80%); a turn keeps running when the connection drops (explicit cancel); ADR-0027/0029 amendments recorded in ADR-0030 without a PCR.
- Done: T1 (step in the idempotency key, `ToolAnswer.untrustedText`), T2 (contracts `chat.ts`, `ai.chat`, conversation tables 0034/0035, `reserveUsage`/`settleUsage`), T3 (core conversation services, stale turns, 90-day clean-up), T4 (`reserveLlmTokens`), T5 (context, trimming, `redactContacts`), T6 (routing, breaker), T7 (loop `startTurn`/`recoverTurn`, fallback, `turn_limit` code; `write_limit` dropped), T8 (exactly-once on Postgres; turns on the app clock), T9 (hostile fake through the loop, 100%), T10 (seeded eval worlds, loop subject, placeholders in cassettes, CLI on the registry: 25/25).
- Next: T11 api chat module → T9 hostile through loop → T10 eval worlds → T11 api SSE → T12 OTel → T13 docs, PR, merge.

## Last sessions
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
- **S23 Phase 6b (2026-10-21): trust-layer data and decisions** ([ADR-0028](../adr/0028-trust-layer-proposals-executions-and-autonomy.md), accepted; [PCR-003](changes/PCR-003.md), approved). Full entry in [session-log.md](session-log.md).
  - **Code:**
    - Tables `autonomy_settings`, `ai_action_proposals`, `ai_action_executions`: RLS, staff scope, guard triggers, no deletes.
    - `decideAutonomy` (decided inside the trust layer from the domain's preview), the state fingerprint.
    - Services `requestAction` / `approveProposal` / `rejectProposal` / `undoAction` / `changeAutonomy`.
    - The `ActionRunner` port for S24 tools.
    - The audit actor `ai_on_behalf_of` everywhere via `auditActorOf`.
    - Outbox `cancelled` for undo, with a 2-minute "undo send" grace.
    - Expired proposals marked by the daily clean-up.
  - **Checks:**
    - `pnpm check` green (contracts 530, core 1,172 incl. property tests, db 44).
    - `pnpm test:integration` green, 790, incl. the isolation suite with the new tables and concurrent approve/undo and undo-vs-worker races.
    - No OpenAI call.
  - **Found and fixed:**
    - AI approve/undo is refused (undo could bypass the dial).
    - Outbox links from tools are verified.
    - The guard's quadratic email pattern is bounded.
    - Two load-sensitive tests are fixed (worker "sent" wait, api start-up 90 s).

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
- **S23 (user, 2026-10-21, Session Brief):** "Go ahead with your recommendations":
  - PCR-003 (`booking.cancel`, `task.create`, strictest action, bulk by recipients);
  - a 2-minute "undo send" grace;
  - undo windows: bookings 24 h but not past the start; blocked time 24 h; notes and to-dos 7 days; messages until sent;
  - an "Ask me first for everything" switch.
- **End of S23 (user):** "ADR-0028 approved. Raise PR and complete merge."
- **S23 defaults (Claude, in ADR-0028, accepted by the user):**
  - The dial is decided inside the trust layer.
  - Only people approve, reject or undo.
  - The approver is the requester or a lead, with their role re-checked.
  - A stale fingerprint means superseded plus a fresh proposal.
  - Proposals and receipts are immutable and never deleted by the services.
  - Proposals expire after 24 h (or at the appointment).
  - Undo reasons feed the wrong-action metric.

## Waiting on the user
1. Optional, not yet: create a free Sentry project and a Grafana Cloud stack and put `SENTRY_DSN` / `OTEL_EXPORTER_OTLP_*` in your local `.env` to see errors and traces (nothing is needed for development). The user deferred it after M1 and asked Claude to bring it up: **deferred again at S22 (user); raise it before the pilot (S27/Phase 11 briefs).**

(Done: "Require branches to be up to date before merging" is on for `main`, user, 2026-10-20.)

## Planned sessions (next first)
S1–S24 are done and merged (Phases 0–5, Phases 6a–6c). Phase 6 (AI agent + trust layer) runs S22–S27 as set in the [Phase 6 playbook](phase-6-playbook.md), whose §7 guides each session; details in [session-log.md](session-log.md).

| # | Session target | Phase | Done when |
|---|---|---|---|
| S25 | Agent loop, conversations, SSE, budgets and rate limits (ADR-0030); wires S24's `dispatchToolCall`, replays the hostile fake through the loop, seeded worlds for the generated tool eval cases | 6d | Eval sets green on the fakes; AC-X-2 |
| S26 | Chat screen, cards, Why, Undo, Autonomy settings | 6e | Playwright journeys, axe |
| S27 | Real-model evals within the $5 budget, model choice, Phase 6 security review, exit | 6f | Scheduling ≥ 90%, safety 100% pass^3, spend ≤ $5 |

## How to resume in a new session
Start the session from the latest `main`. Say: *"Read CLAUDE.md and docs/plan/STATUS.md, give me the Session Brief, then continue."* During the session Claude keeps "In progress" current after each finished task; at the end it moves that session's summary into "Last sessions", appends the full entry to `session-log.md` and new decisions to `decisions.md`, and commits all three.

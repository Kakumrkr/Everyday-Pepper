# Project Status — read this first in every new session

**Last updated:** 2026-10-21 · **Plan version:** 0.19 · **Current phase:** 6 — AI agent + trust layer. **S23** (trust-layer data and decisions) done and merged → next: **S24** (tool registry and the first tools)

This file is kept short. The full history is in [session-log.md](session-log.md) (what every session did, its checks and leftovers) and [decisions.md](decisions.md) (every decision made in chat). Open them when a task needs that history; they are not needed to start a session.

## In progress
**S24 (6c) tool registry and the first tools**: Session Brief approved by the user (2026-10-21): "Go ahead with your recommendations, ADR-0029 is fine". The user pre-approved ADR-0029 and asked Claude to open the PR, merge it to `main` and end with the prompt for the next session.
- **Done:**
  - T3: the trust layer runs every preview in a savepoint it always rolls back (`dryRun`). An approval whose fresh preview the domain refuses supersedes the proposal and returns `refused` with the error. Mutation-checked.
  - T2: `queueBookingEmail` (appointments) with `holdSeconds`, returning the outbox id; the api's `BookingEmails` delegates to it.
  - T1: transaction-taking variants (`createBookingIn`, `changeBookingIn`, `getBookingIn`, `listBookingsIn`, `reinstateBookingIn`, `findAvailabilityIn`, `addTimeOffIn`/`removeTimeOffIn`/`listTimeOffBetweenIn`, `listServicesIn`, `listStaffIn`, `createTaskIn`, `withdrawTaskIn`, `findClientsByNameIn`). Booking writes run in a savepoint. New audit action `task.deleted`.
- **Next:** T4–T6 the registry and the ten tools; T7 the hostile fake; T8 eval generation and latency; T9 docs, ADR-0029 (accepted), PR, merge.
- **Decisions (user, brief):**
  - ADR-0029 for S24; S25's ADR becomes 0030.
  - `email_client` on write tools: `null` means the screens' default; the email stays on the dial.
  - Undo never emails the client.
  - Staff find only their own clients.

## Last sessions
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
- **S22 Phase 6a (2026-10-20): Phase 6 plan, provider adapter, eval runner skeleton** ([ADR-0027](../adr/0027-llm-provider-port-and-evals.md), accepted). Playbook confirmed; `@pepper/ai` with the `LlmProvider` port, `OpenAiProvider` (Responses API, `store: false`), fakes, strict tool schemas, metering and the eval runner with cassettes and a budget guard. Full entry in [session-log.md](session-log.md).

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
- **S22 (user, 2026-10-20):**
  - Plan Phase 6 with great care, as the product's most important layer: Claude acts as senior advisor, and every decision must improve the product and stand out from the market.
  - **OpenAI budget: $5 in total for Phase 6, spent only at the final testing stage (S27).**
  - Phase 6 playbook confirmed, with a "keep getting better" rule.
  - The official `openai` SDK.
  - Sentry and Grafana Cloud deferred again.
- **End of S22 (user):** "ADR-0027 approved. Open PR and complete the merge."
- **S22 defaults (Claude, in ADR-0027, accepted by the user):**
  - Responses API with `store: false` and reasoning replay.
  - Our own retries, with a 30 s timeout.
  - Strict tool schemas from Zod (`.nullable()` instead of optional).
  - Model ids only from config, chosen in S27.
  - A call fails if it can't be metered.
  - Deterministic graders and cassettes.
  - A $1.50 per-run cap (at most $4.50), and a price table filled before any real run.

## Waiting on the user
1. Optional, not yet: create a free Sentry project and a Grafana Cloud stack and put `SENTRY_DSN` / `OTEL_EXPORTER_OTLP_*` in your local `.env` to see errors and traces (nothing is needed for development). The user deferred it after M1 and asked Claude to bring it up: **deferred again at S22 (user); raise it before the pilot (S27/Phase 11 briefs).**

(Done: "Require branches to be up to date before merging" is on for `main`, user, 2026-10-20.)

## Planned sessions (next first)
S1–S23 are done and merged (Phases 0–5, Phases 6a–6b). Phase 6 (AI agent + trust layer) runs S22–S27 as set in the [Phase 6 playbook](phase-6-playbook.md), whose §7 guides each session; details in [session-log.md](session-log.md).

| # | Session target | Phase | Done when |
|---|---|---|---|
| S24 | Tool registry + about ten tools with dry-run previews, inverses, permissions; each implements ADR-0028's `ActionRunner` (booking services get transaction-taking variants) | 6c | Preview = execution and hostile-fake tests green (incl. AI approve/undo and foreign outbox links refused) |
| S25 | Agent loop, conversations, SSE, budgets and rate limits | 6d | Eval sets green on the fakes; AC-X-2 |
| S26 | Chat screen, cards, Why, Undo, Autonomy settings | 6e | Playwright journeys, axe |
| S27 | Real-model evals within the $5 budget, model choice, Phase 6 security review, exit | 6f | Scheduling ≥ 90%, safety 100% pass^3, spend ≤ $5 |

## How to resume in a new session
Start the session from the latest `main`. Say: *"Read CLAUDE.md and docs/plan/STATUS.md, give me the Session Brief, then continue."* During the session Claude keeps "In progress" current after each finished task; at the end it moves that session's summary into "Last sessions", appends the full entry to `session-log.md` and new decisions to `decisions.md`, and commits all three.

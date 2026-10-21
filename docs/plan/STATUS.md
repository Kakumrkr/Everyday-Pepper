# Project Status — read this first in every new session

**Last updated:** 2026-10-21 · **Plan version:** 0.22 · **Current phase:** 6 — AI agent + trust layer. **S26** (chat screen, cards, Why, Undo, Autonomy settings) done and merged → next: **S26b** (four tools, [PCR-004](changes/PCR-004.md)), then **S27**

This file is kept short. The full history is in [session-log.md](session-log.md) (what every session did, its checks and leftovers) and [decisions.md](decisions.md) (every decision made in chat). Open them when a task needs that history; they are not needed to start a session.

## In progress
**S26b** (PCR-004, user 2026-10-21: "Go ahead with your recommendations, ADR is pre-approved"). Decisions at the brief: a staff member unblocking a colleague's time answers `forbidden` (they can see it), clients and to-dos they can't see `not_found`; explanation facts in this session (Task 6, else S27); no new card kinds, no new Playwright journeys.
- Done: Task 1 `find_client_bookings` (db `listClientBookings`, appointments `listClientBookingsIn`, the tool, reads/hostile/evals/latency tests; the hostile test's mini-loop trims history).
- Done: Task 2 `list_todos` (core `listTasksIn`, `memberFirstNamesIn`; titles through `redactContacts`; the AI's own to-dos come back labelled untrusted).
- Watch: `reads.int.test.ts` "list_todos" failed once with no visible diff, then passed 16 runs in a row; re-run it in the full suite.
- Next: Task 3 `complete_todo`, 4 `unblock_time` + `get_day` v2, 5 hostile/evals for all, 6 facts, 7 docs + ADR-0032 + checks.

## Last sessions
- **S26 Phase 6e (2026-10-21): chat screen, cards, Why, Undo, Autonomy settings** ([ADR-0031](../adr/0031-chat-screen-cards-why-undo-and-autonomy-settings.md), accepted; [PCR-004](changes/PCR-004.md), approved). Full entry in [session-log.md](session-log.md).
  - **Code:**
    - `/chat` on `POST /v1/chat/turns`: plain-text streaming, resume with `Last-Event-ID`, Stop and cancel on leaving, chips, AI off/paused/fallback states.
    - `@pepper/ui` cards (change/confirmation/receipt, slot picker, client choice, booking, day, plan), *Why?*, Undo with its window and "already emailed"; `/autonomy`; Home's "Needs your OK" and "Done for you".
    - `/v1/ai/*` (live views, approve by fingerprint, reject, undo), `/v1/autonomy`, `/v1/chat/status`; migration 0036 (tool version, requester, summary).
    - `E2eModel` behind `AI_SCRIPTED_PROVIDER=e2e` (CI only, refused elsewhere and next to a key); a lint rule against raw HTML and Markdown.
  - **Checks:**
    - `pnpm check` green (contracts 547, core 1,190, ai 183, api 292, web 264, ui 103).
    - `pnpm test:integration` green, 943 (+15).
    - Playwright on CI's headless shell, phone and desktop, with axe: the full suite 74/74, twice in a row (an earlier run failed 2: a turn slower than Playwright's 5 s default, and an `ECONNRESET` from Node's 5 s keep-alive race; fixed with turn-length waits and a 65 s keep-alive on the web server). No OpenAI call.
  - **Found and fixed:**
    - A lead's approval turned a staff member's "me" into the lead.
    - Focus not returned after *Why?*.
    - A slot tapped during a turn was dropped.
    - Resumed turns lost their cards.
    - The scripted switch trusted a defaulted environment name.
    - The web server's 5 s keep-alive raced reused connections (`ECONNRESET`).
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
- **S26 (user, 2026-10-21, Session Brief):** "Go ahead with your recommendations, draft PCR-004, ADR is pre-approved":
  - migration 0036 in ADR-0031 as an ADR-0028 amendment, without a PCR;
  - staff may undo what a lead approved for them;
  - jsdom, Testing Library and axe-core (dev-only) in `@pepper/ui`;
  - managers change autonomy (ADR-0028 over the prototype);
  - the chat's Redis polling stays; blocking reads in Phase 11;
  - PCR-004: S26b (four tools) before S27.
- **End of S26 (user, pre-approved at the brief):** "I'm pre-approving the PCR and ADR. You have to raise PR and merge to main and at last give a perfect prompt to start the next session."
- **S26 defaults (Claude, in ADR-0031):** cards read their record by id; Approve sends only the shown fingerprint; `ToolDeps.requester`; plain text only; Stop and leaving cancel; a card choice during a turn is queued; "Approve all" in order, stopping at the first failure.
- **S25 (user, 2026-10-21, Session Brief):** "Go ahead with your recommendations, ADR is fine": own-only conversations, deleted after 90 days; 5M tokens a month, soft at 80%; turns keep running when the connection drops (explicit cancel only); ADR-0027/0029 amendments in ADR-0030 without a PCR. D8 decided: SSE.
- **S25 defaults (Claude, in ADR-0030):** 6 steps / 20 s / 5 writes; reads parallel, writes serial; tool calls recorded before they run, recovery only reads; breaker 3 → 30 s; rate limits 20 / 5 min per member; events in a Redis stream (1 h).

## Waiting on the user
1. Optional, not yet: create a free Sentry project and a Grafana Cloud stack and put `SENTRY_DSN` / `OTEL_EXPORTER_OTLP_*` in your local `.env` to see errors and traces (nothing is needed for development). The user deferred it after M1 and asked Claude to bring it up: **deferred again at S22 (user); raise it before the pilot (S27/Phase 11 briefs).**

(Done: "Require branches to be up to date before merging" is on for `main`, user, 2026-10-20.)

## Planned sessions (next first)
S1–S26 are done and merged (Phases 0–5, Phases 6a–6e). Phase 6 (AI agent + trust layer) runs S22–S27 as set in the [Phase 6 playbook](phase-6-playbook.md), whose §7 guides each session; [PCR-004](changes/PCR-004.md) adds S26b. Details in [session-log.md](session-log.md).

| # | Session target | Phase | Done when |
|---|---|---|---|
| S26b | Four tools ([PCR-004](changes/PCR-004.md)): `find_client_bookings`, `list_todos`, `complete_todo`, `unblock_time`; explanation `facts` | 6e+ | Per-tool tests as S24, hostile fake 100%, eval cases on the fakes |
| S27 | Real-model evals within the $5 budget, model choice, Phase 6 security review, exit | 6f | Scheduling ≥ 90%, safety 100% pass^3, spend ≤ $5 |

## How to resume in a new session
Start the session from the latest `main`. Say: *"Read CLAUDE.md and docs/plan/STATUS.md, give me the Session Brief, then continue."* During the session Claude keeps "In progress" current after each finished task; at the end it moves that session's summary into "Last sessions", appends the full entry to `session-log.md` and new decisions to `decisions.md`, and commits all three.

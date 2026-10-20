# Project Status — read this first in every new session

**Last updated:** 2026-10-20 · **Plan version:** 0.17 · **Current phase:** 5 — Messaging + jobs, **complete** (S19–S21, merged). Maintenance session **M1** (shorter `STATUS.md`, checkpoint rule, CI-parity tests, Docker Hub fallback) done → next: **S22** (Phase 6 planning)

This file is kept short. The full history is in [session-log.md](session-log.md) (what every session did, its checks and leftovers) and [decisions.md](decisions.md) (every decision made in chat). Open them when a task needs that history; they are not needed to start a session.

## In progress
Nothing in progress: M1 is complete and merged. (During a session, Claude keeps this section current after each finished task: done so far, next step, open questions, decisions made in chat. See "Checkpoints" in `CLAUDE.md`.)

## Last sessions
- **M1 maintenance (2026-10-20):** `STATUS.md` split into this file, [session-log.md](session-log.md) and [decisions.md](decisions.md); checkpoint rule and generous-time-limits testing rule in `CLAUDE.md`; local Playwright in cloud sessions uses CI's headless shell; the session-start hook starts Docker with Google's mirror (`mirror.gcr.io`) so Docker Hub's rate limit no longer blocks pulls. No product code changed.
- **S21 Phase 5c (2026-10-20): to-dos, Web Push for the team, Phase 5 security review** ([ADR-0026](../adr/0026-tasks-and-web-push.md), accepted by the user on 2026-10-20). At the Session Brief the user chose Claude's recommendation on all four questions: the `web-push` library; pushes for booking-page activity and due to-dos; no client names in pushes; staff see their own to-dos, owners and managers all.
  - **Database** (migrations 0030–0031):
    - `tasks`: title, due time, assignee (composite key to memberships, cleared when they leave), open/done, source, creator, `due_notified_at`. A restrictive `member_scope` limits staff to tasks assigned to them or that they created; there is a `tasks` job scan.
    - `push_subscriptions`: endpoint and keys per member and business. Each member reaches only their own; the rows are removed with the membership.
    - The outbox type gains `push`.
    - Both tables are in the isolation suite.
  - **Contracts:** task schemas; push schemas with `isPushServiceEndpoint`; `OutboxPushSchema` (app paths only); permissions `tasks.read`/`tasks.manage` (staff `own`); audit `task.created`/`task.updated` (never the title); error codes `task_not_found`, `task_assignee_not_member`, `push_unavailable`.
  - **Core:**
    - Task services: a task is the caller's own by default; staff assign only themselves.
    - `sendDueTaskPushes`.
    - The `Pusher` port and push failure rules (404/410: device removed, push dropped without an alert).
    - `queuePush`, `queuePushToMembers`, device save, remove and status.
    - `can()` now fails closed for an unknown role.
  - **Appointments:** the booking page's team push (staff member and owners and managers) with wording on the business clock.
  - **Api:** `/v1/tasks`; `/v1/push` (key, subscription PUT/DELETE, status); `TeamPushes` queued next to the client's email. The api reads only `VAPID_PUBLIC_KEY`.
  - **Worker:** `WebPusher` (web-push 3.6.7, the one new dependency, pinned, worker only) sends the outbox's pushes; the due-task job runs on the reminders' interval when the VAPID keys are set.
  - **Web:**
    - A To-dos card on Home: add with date and time on the business clock, "For" for owners and managers, mark done, undo, overdue.
    - A "Notifications on this device" card: on, off, blocked, unsupported, and "add to Home Screen first" on iPhone and iPad; hidden when pushes are off.
    - `sw.js` shows pushes and opens only own-origin pages.
  - **Config:** a local-only VAPID key pair in Compose and `.env.example`. Three VAPID lines were appended to your local `.env`; nothing else in it was changed.
  - **Security review** (`docs/engineering/security-review-s21.md`): no high findings.
    - M1 SSRF through device endpoints, fixed: push services only, checked twice.
    - M2 one member crowding out the others' devices, fixed: 10 per member.
    - B1 shared device, fixed.
    - L1–L5 logged: send quotas, local secrets in production, task limits, a rare duplicate push, dev-only audit items.
  - **Docs:** ADR-0026; data-model, jobs-messaging-integrations; security-and-tenancy, dev-setup; traceability, dependency map, CHANGELOG 0.17.
  - **Checks run:**
    - `pnpm check` green.
      - Unit tests: contracts 475, core 562, web 247, api 263, runtime 90, appointments 79, worker 26, db 43, ui 79, templates 96, testing 13.
      - All coverage gates pass (core 100% lines, appointments 100%, web 98.8% lines, db functions 82.6%).
    - `pnpm test:integration` green, **712**:

      | Package | Tests | New in S21 |
      |---|---|---|
      | db | 424 | isolation for both tables and the tasks scan; tasks and devices 12 |
      | appointments | 125 | |
      | core | 93 | tasks 10, push 10 |
      | api | 62 | booking page push through the real api |
      | worker | 4 | |
      | runtime | 2 | |
      | testing | 2 | |

    - Playwright **60/60 green** (phone and desktop), incl. `tasks.spec.ts` and `notifications.spec.ts` (the switch with a stand-in browser subscription), against api, worker and `next start` on Compose Postgres, Redis and Mailpit (project `pepper-s21`), `--workers=2`. Afterwards the outbox held 30 emails, all sent on the first attempt; the worker logged no warnings.
    - `pnpm audit --prod`: no known vulnerabilities.
  - **Not done / for later:**
    - Docker image builds were not run here; CI builds them.
    - A real push to a real phone (needs a device; the encryption and signature are proven by decrypting and verifying in tests).
    - Per-business send quotas and refusing local secrets in production (Phase 11).
    - Recurring to-dos, AI-created to-dos (Phase 6), notification preferences per event.
  - **Note:** Docker Hub answered 429 in S18; this time the images pulled normally.

## Standing decisions (still in force)
Full wording and the history in [decisions.md](decisions.md).
- **Sessions:** one feature-sized goal per session, started with a Session Brief from this file; the user may run `/compact` before the PR when the context is long (checkpoints make that safe).
- **CI minutes:** one CI run per session: all checks locally first, every commit (docs, "ADR accepted", STATUS) in before the PR, pushes to an open PR only to fix CI; docs-only PRs skip the slow jobs; CI runs on PRs, weekly on `main` and by hand. **No retries in CI** (M1).
- **Free development setup:** Docker for Postgres + pgvector, Redis, SeaweedFS and Mailpit; free tiers of GitHub Actions, Sentry and Grafana Cloud; Google Calendar in testing mode.
- **OpenAI cost (to decide at S22):** add ~$5–10 credit with a hard monthly limit (recommended) or develop on a free local model via the provider adapter and run evals on OpenAI before the pilot.
- **Skip domain, business email and LLC** until before the pilot (Phase 11); brand, trademark and domain checks then.
- **Design:** Pepper green + chili accent (PCR-002), Bricolage Grotesque + Figtree, warm and friendly, mobile-first (`docs/mockups/README.md`).
- **Email provider:** Resend for the pilot (D4, S19); Mailpit over SMTP in development and CI.

## Recent decisions
- **S21 decisions (user, 2026-10-20, S21 Session Brief):** (1) **`web-push` 3.6.7** to sign and encrypt pushes (worker only), not hand-written crypto; (2) pushes for **booking-page bookings, moves and cancellations** (to the staff member and the owners and managers) and **due to-dos** (to the assignee); (3) **no client names** in a push; (4) **staff see and manage their own to-dos; owners and managers see and assign everyone's**.
- **S21 defaults (Claude, in ADR-0026; accepted by the user with "ADR-0026 approve", 2026-10-20):** a new to-do is the caller's own, a date without a time is due at 9:00 AM business time, a team (unassigned) to-do notifies the owners and managers; to-dos live in core (L1); devices only on browser push services, at most 10 per member, a shared device moves to whoever turned it on last; turning off removes this business's device but keeps the browser subscription; the due-task job runs on the reminders' interval; a local-only VAPID key pair in Compose and `.env.example`; the To-dos and Notifications cards on Home.
- **End of S21 (user, 2026-10-20):** "ADR-0026 approve. open PR and merge to main." ADR-0026 accepted as proposed, with Claude's defaults. S22 starts in a new session from `main`.
- **M1 (user, 2026-10-20, after S21):** split `STATUS.md`; a checkpoint after each finished task; no retries in CI; Docker pulls go through Google's mirror automatically; done in a maintenance session before S22.

## Waiting on the user
1. Optional, not yet: create a free Sentry project and a Grafana Cloud stack and put `SENTRY_DSN` / `OTEL_EXPORTER_OTLP_*` in your local `.env` to see errors and traces (nothing is needed for development). The user deferred it after M1 and asked Claude to bring it up: **raise it in the next Session Brief's "Decisions needed" (and again before the pilot) until it is done or declined.**

(Done: "Require branches to be up to date before merging" is on for `main`, user, 2026-10-20.)

## Planned sessions (next first)
S1–S21 are done and merged (Phases 0–5; details in [session-log.md](session-log.md)). Phase 6 (AI agent + trust layer) is split at the S22 Session Brief.

| # | Session target | Phase | Done when |
|---|---|---|---|
| S22 | **Phase 6 planning + provider adapter:** split Phase 6 (AI agent + trust layer) into sessions; decide the OpenAI cost option (credit with a hard monthly limit, or a free local model for development, see Decisions); build the provider adapter with a fake provider and the eval runner skeleton | 6a | Phase 6 plan confirmed; adapter contract tests and a first eval run green |

## How to resume in a new session
Start the session from the latest `main`. Say: *"Read CLAUDE.md and docs/plan/STATUS.md, give me the Session Brief, then continue."* During the session Claude keeps "In progress" current after each finished task; at the end it moves that session's summary into "Last sessions", appends the full entry to `session-log.md` and new decisions to `decisions.md`, and commits all three.

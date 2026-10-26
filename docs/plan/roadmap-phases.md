# Roadmap & Implementation Phases

Plan version: **0.33** (see `CHANGELOG.md`; Phases 9–17 from [PCR-007](changes/PCR-007.md), session by session in the [V1 playbook](v1-playbook.md)). Builder: solo + Claude Code. Each phase is approved by the user before it starts; each ends with CI green and its exit criteria proven by automated tests.

| # | Phase | Deliverables | Exit criteria | Est. |
|---|---|---|---|---|
| 0 | Planning | These docs, competitor audit, ADRs accepted, UX mockups of key screens, brand/name | User sign-off on docs + ADRs + mockups | 3–5 wks |
| 1 | Foundations | Monorepo (pnpm/Turborepo), apps skeletons, Docker Compose, CI, lint/format/typecheck, test harnesses, Sentry/OTel wiring, env validation | CI green; `docker compose up` serves web+api+worker; sample unit/integration/E2E tests pass | 1–2 wks |
| 2 | Platform core | Auth (+MFA), tenants, memberships/roles, RLS, audit log, usage metering skeleton | Cross-tenant suite 100%; role matrix 100%; auth E2E | 2–3 wks |
| 3 | Appointments + templates | Services, staff, hours, rules engine, availability engine, bookings (exclusion constraint), waitlist model, template system + 8 V1 templates | Property tests (10k) no double booking/rule violations; ≥ 80% coverage; template schema tests | 3–4 wks |
| 4 | PWA + booking page | Owner/staff screens (calendar, clients, services, team), design system, public booking page with email verification | Playwright: setup, manual booking, public booking, concurrent last-slot (AC-W8-1) | 3–4 wks |
| 5 | Messaging + jobs | Outbox, BullMQ worker, email channel, confirmations/reminders, tasks | No duplicate sends on retry (AC-W4-2); reminder timing (AC-W6-1) | 2 wks |
| 6 | AI agent + trust layer | Provider adapter (OpenAI), tool registry, agent loop, cards, autonomy dial, proposals, undo, explanations, eval runner | Evals ≥ 90% scheduling, 100% safety; AC-W2-*, AC-W7-1/3 | 4–5 wks |
| 7 | Memory | Facts and visit notes, learned rules, episodic recall (pgvector), "What I know" page; sessions S29–S33 in the [Phase 7 playbook](phase-7-playbook.md) (PCR-005) | Recall eval ≥ 95%; deletion eval 100% (AC-W7-2); AC-W3-* | 2 wks |
| 8 | Operator feed | Insights, daily briefing, suggestions with drafts, smart waitlist; sessions S34–S38 in the [Phase 8 playbook](phase-8-playbook.md) (PCR-006) | AC-W4-1, AC-W5-1; insight fixtures tested | 3 wks |
| 9 | New look | Design direction from three clickable mockups, new tokens and component kit, every screen restyled, design rules enforced by tests ([ADR-0044](../adr/0044-redesign-and-design-rules.md), [DESIGN.md](../design/DESIGN.md)); S39–S43 | Scorecard C3, C4, C10 ≥ 8; screenshot tests at 3 widths × 2 themes; legacy stylesheet gone | 5 sessions |
| 10 | First 10 minutes | Password reset + email verification, business type at signup with a pre-filled menu, setup checklist and warnings, branded booking page, activation events; the carried waitlist fix; S44–S47 | A new owner bookable in < 10 min; no setup dead end | 4 sessions |
| 11 | Switching + privacy | Client and history import (Square, Booksy, Vagaro, GlossGenius, Fresha, generic), merge/delete, walk-ins, export, account and business deletion; S48–S51 | AC-W1-3; export round-trips; scorecard C11, C13 ≥ 8 | 4 sessions |
| 12 | The employee | Home card board ([ADR-0043](../adr/0043-card-board-first-interaction.md)), activity log, autonomy presets and standing rules, the cancellation → fill loop with receipts, win-back, weekly value card, evening wrap, review requests, `send_client_message`, `mark_no_show`; S52–S56b (recorded) | Fill offered < 2 min p95, 0 wrong sends; evals ≥ 98% on one-sentence moves; scorecard C1, C5 ≥ 8, C8 ≥ 9 | 6 sessions |
| 13 | Pilot readiness | Deploy, sending domain, backups + restore drill, Sentry/OTel on, Redis rate limits, load test, support button, legal pages, pilot metrics, security review; S57–S60 | Scorecard pilot gate ([scorecard.md](scorecard.md)); restore drill passed; user approves prod deploy | 4 sessions |
| — | **Private pilot** | 3–5 owners, email only, 60 days free | The hypotheses in the playbook §6 measured | runs alongside 14–17 |
| 14 | SMS | SMS channel with consent and STOP, reminders + confirm by text, approve by text; live after 10DLC; S61–S64 | Reminder timing and idempotency; scorecard C12 ≥ 7 | 4 sessions |
| 15 | Deposits | Stripe Connect Express, deposits and card on file, smart deposits, policy builder, no-show fee by approval; S65–S68 | No charge without an approved card; scorecard C12 ≥ 8 | 4 sessions |
| 16 | Calendar + staff | Week view + drag, Google Calendar in and out (the old Phase 10), recurring appointments, staff week; S69–S72 | Contract tests; conflict + token-expiry scenarios; scorecard C6 ≥ 8 | 4 sessions |
| 17 | Launch gate | Reports, Pepper billing (trial, plans), landing page, final re-record, security review; S73–S76 | Every scorecard category ≥ 9; paid-launch go/no-go | 4 sessions |

**Phases 9–17: 39 sessions (S39–S76, S56 in "a" and "b" halves).** Parallel non-code tasks for the user (parked until needed, P1-6): a cheap neutral domain by Phase 13; the LLC before SMS and Stripe go live (10DLC registration takes weeks); Google OAuth verification started during Phase 10; the brand name and trademark before paid launch.

## Post-V1
V1.1 booking-page layouts, Goals, two-way chat by text → after PMF the mini-website on the owner's own domain, booth-rental shops, clinical studios → V2 voice, Classes & Memberships, Spanish → V3 Quotes & Jobs, Orders, AWS. See `../product/v1-scope.md`.

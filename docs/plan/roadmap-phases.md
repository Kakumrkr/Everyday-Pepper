# Roadmap & Implementation Phases

Plan version: **0.2** (see `CHANGELOG.md`). Builder: solo + Claude Code. Each phase is approved by the user before it starts; each ends with CI green and its exit criteria proven by automated tests.

| # | Phase | Deliverables | Exit criteria | Est. |
|---|---|---|---|---|
| 0 | Planning | These docs, competitor audit, ADRs accepted, UX mockups of key screens, brand/name | User sign-off on docs + ADRs + mockups | 3–5 wks |
| 1 | Foundations | Monorepo (pnpm/Turborepo), apps skeletons, Docker Compose, CI, lint/format/typecheck, test harnesses, Sentry/OTel wiring, env validation | CI green; `docker compose up` serves web+api+worker; sample unit/integration/E2E tests pass | 1–2 wks |
| 2 | Platform core | Auth (+MFA), tenants, memberships/roles, RLS, audit log, usage metering skeleton | Cross-tenant suite 100%; role matrix 100%; auth E2E | 2–3 wks |
| 3 | Appointments + templates | Services, staff, hours, rules engine, availability engine, bookings (exclusion constraint), waitlist model, template system + 8 V1 templates | Property tests (10k) no double booking/rule violations; ≥ 80% coverage; template schema tests | 3–4 wks |
| 4 | PWA + booking page | Owner/staff screens (calendar, clients, services, team), design system, public booking page with email verification | Playwright: setup, manual booking, public booking, concurrent last-slot (AC-W8-1) | 3–4 wks |
| 5 | Messaging + jobs | Outbox, BullMQ worker, email channel, confirmations/reminders, tasks | No duplicate sends on retry (AC-W4-2); reminder timing (AC-W6-1) | 2 wks |
| 6 | AI agent + trust layer | Provider adapter (OpenAI), tool registry, agent loop, cards, autonomy dial, proposals, undo, explanations, eval runner | Evals ≥ 90% scheduling, 100% safety; AC-W2-*, AC-W7-1/3 | 4–5 wks |
| 7 | Memory | Facts, learned rules, episodic recall (pgvector), "What I know" page | Recall eval ≥ 95%; deletion eval 100% (AC-W7-2); AC-W3-* | 2 wks |
| 8 | Operator feed | Insights, daily briefing, suggestions with drafts, smart waitlist | AC-W4-1, AC-W5-1; insight fixtures tested | 3 wks |
| 9 | Zero-setup onboarding | Website/Google profile/photo extraction, review card, competitor CSV import | AC-W1-*; extraction ≥ 90% on fixture set | 2–3 wks |
| 10 | Google Calendar sync | OAuth, push + incremental sync, busy blocks, outbound events | Contract tests; conflict + token-expiry scenarios | 2 wks |
| 11 | Hardening + pilot | Security review, load test, backups + restore drill, runbooks, VPS deploy, legal docs | SLOs met under load; no open high-severity findings; restore drill passed; user approves prod deploy | 2–3 wks |

**Total to pilot: ~7–10 months.** Parallel non-code tasks for the user: pick brand name, form company, register domain, Google OAuth verification (start by Phase 9), start SMS 10DLC registration before pilot for V1.1.

## Post-V1
V1.1 SMS, deposits (Stripe Connect), Goals, text-the-AI → V2 voice, Classes & Memberships, Spanish → V3 Quotes & Jobs, Orders, AWS. See `../product/v1-scope.md`.

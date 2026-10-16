# Risk Register

| # | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | AI performs a wrong action | Med | High | Domain validation, risk tiers, autonomy dial, proposals, undo, audit, eval gate | Eng |
| R2 | Solo scope creep / burnout delays V1 | High | High | Strict V1 scope, one phase at a time, PCR process, cut lists per phase | User + Claude |
| R3 | LLM cost exceeds budget | Med | Med | Small model default, per-tenant budgets, caching, metering, hard account cap | Eng |
| R4 | Prompt injection via notes/imports/websites/calendar | Med | High | Untrusted-data labelling, tenant-bound tools, gated external actions, injection evals | Eng |
| R5 | Email-only reminders less effective → no-shows | High | Med | Strong email UX, start 10DLC early, SMS in V1.1 via channel-agnostic layer | Product |
| R6 | No deposits in V1 — weaker no-show protection | High | Med | Design deposit hooks now; Stripe Connect in V1.1 | Product |
| R7 | Google Calendar sync conflicts/duplicates | Med | Med | Clear source of truth, sync tokens, idempotent upserts, reconciliation | Eng |
| R8 | Google OAuth verification / company formation delays | Med | Med | Start entity + domain + verification by Phase 9 | User |
| R9 | Onboarding extraction inaccurate | Med | Med | Always review before commit, fixture-based accuracy tests, manual fallback | Eng |
| R10 | Switching resistance (owners on competitor tools) | High | High | Zero-setup + CSV import, free export, month-to-month, clear differentiators | Product |
| R11 | Self-hosted pilot infra failure | Med | Med | Backups + restore drill, monitoring, simple runbooks, migrate to managed when revenue | DevOps |
| R12 | Competitors ship similar AI features | High | Med | Compete on trust layer + operator feed depth + UX; move fast on V1.1 Goals | Product |
| R13 | Pricing unknown → unit economics unclear | Med | Med | Metering from day one; decide pricing before pilot | User |

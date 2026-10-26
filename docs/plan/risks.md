# Risk Register

| # | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | AI performs a wrong action | Med | High | Domain validation, risk tiers, autonomy dial, proposals, undo, audit, eval gate | Eng |
| R2 | Solo scope creep / burnout delays V1 | High | High | Strict V1 scope, one phase at a time, PCR process, cut lists per phase | User + Claude |
| R3 | LLM cost exceeds budget | Med | Med | Small model default, per-tenant budgets, caching, metering, hard account cap | Eng |
| R4 | Prompt injection via notes/imports/websites/calendar | Med | High | Untrusted-data labelling, tenant-bound tools, gated external actions, injection evals | Eng |
| R5 | Email-only reminders less effective → no-shows | High | Med | SMS in V1 (Phase 14, PCR-007) through the channel-agnostic outbox; the pilot is told "email only" until 10DLC is approved | Product |
| R6 | No deposits in V1 — weaker no-show protection | High | Med | Deposits, card on file and fees by approval in V1 (Phase 15, PCR-007); smart deposits keep regulars unasked | Product |
| R7 | Google Calendar sync conflicts/duplicates | Med | Med | Clear source of truth, sync tokens, idempotent upserts, reconciliation | Eng |
| R8 | Google OAuth verification / company formation delays | Med | Med | Parked by the user (P1-6): a neutral pilot domain by Phase 13; the LLC before SMS and Stripe go live; Google verification started in Phase 10. SMS and Stripe are built in sandbox so code never waits on paperwork | User |
| R9 | Onboarding extraction inaccurate | Med | Med | Always review before commit, fixture-based accuracy tests, manual fallback | Eng |
| R10 | Switching resistance (owners on competitor tools) | High | High | Zero-setup + CSV import, free export, month-to-month, clear differentiators | Product |
| R11 | Self-hosted pilot infra failure | Med | Med | Backups + restore drill, monitoring, simple runbooks, migrate to managed when revenue | DevOps |
| R12 | Competitors ship similar AI features | High | Med | Compete on trust layer + operator feed depth + UX; move fast on V1.1 Goals | Product |
| R13 | Pricing unknown → unit economics unclear | Med | Med | Metering from day one; decide pricing before pilot | User |
| R14 | The planning hypotheses are wrong (they come from simulated interviews, not real owners) | Med | High | Treated as hypotheses; the pilot measures each one (V1 playbook §6); a failed one goes to a decision round before the next phase; real interviews override them | User + Claude |
| R15 | Eval data sent to the data-sharing OpenAI project includes real personal data | Low | High | A separate `pepper-dev-evals` project; fixtures are made up; a test fails on real-looking phones and emails in fixtures (S56a); production on a sharing-off, zero-retention project | Eng |
| R16 | The redesign stalls feature work or breaks journeys | Med | Med | Five bounded sessions first (Phase 9), screenshot and journey tests on every restyled screen, nothing new built in the old look | Eng |
| R17 | 39 sessions to launch: scope creep or fatigue | Med | High | One playbook row per session; a scorecard gate per phase; unrelated ideas go to "Later" in the playbook, not into the current session | User + Claude |
| R18 | Payments: a wrong charge or a chargeback | Low | High | No charge without an approved card; Stripe-hosted fields (no card data in Pepper); idempotent webhooks; dispute-ready receipts | Eng |

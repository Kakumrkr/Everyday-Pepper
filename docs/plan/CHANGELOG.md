# Plan Changelog

Plan versions use `MAJOR.MINOR`: MINOR for approved PCRs that keep compatibility; MAJOR for scope or architecture changes.

## 0.2 — 2026-10-16
- Initial planning set: product, architecture, engineering, plan docs, competitor audit, CLAUDE.md.
- Scope: all appointment-based US industries (Beauty, Wellness & fitness templates), owner/staff AI, public booking page, email-only messaging, no payments, voice in V2.
- Stack: Next.js, NestJS, OpenAI, PostgreSQL + pgvector, Redis + BullMQ, Google Calendar, S3-compatible storage, Sentry + OTel; lean deployment (Docker → VPS → AWS).
- ADRs 0001–0006 proposed.

## 0.1 — 2026-10-16
- First draft (salon-only, superseded).

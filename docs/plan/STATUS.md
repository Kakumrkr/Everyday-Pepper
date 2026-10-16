# Project Status — read this first in every new session

**Last updated:** 2026-10-16 · **Plan version:** 0.3 · **Current phase:** 0 — Planning (no application code yet; mockups in progress)

## Done
- Full planning set in `docs/` (product, architecture, engineering, plan) and `CLAUDE.md`. **Reviewed and approved by the user — no changes.**
- Competitor audit v0.1 (`docs/research/competitor-audit.md`).
- ADR-0001…0008 **accepted** (incl. Better Auth for auth, Drizzle for the database layer).
- Working name chosen: **Floty**.
- **S1 Mockups part 1 (2026-10-16):** clickable prototype `docs/mockups/floty-prototype.html` with Home/operator feed, Chat with cards, Calendar (day/week), a design-direction page, and placeholders for part 2. Phone + desktop layouts, light + dark. Preview: https://claude.ai/artifact/WNTU3YyQgBjJvCC9hxHqS1. Checks: Playwright click-through (112 assertions, 4 viewport/theme combos) and WCAG AA token contrast, both passing (`docs/mockups/checks/`).

## Decisions made in conversation
- **Skip domain, business email and LLC during development.** Needed only before the pilot (Phase 11) / before charging customers. Final brand, trademark and domain checks also happen before the pilot.
- **Free development setup:** Postgres+pgvector, Redis, MinIO and Mailpit (fake inbox) in Docker; GitHub Actions, Sentry and Grafana Cloud free tiers; Google Calendar API with a personal Gmail and the OAuth app in "testing" mode (≤ 100 test users, no verification).
- **OpenAI cost:** $0 until Phase 6 (tests use a fake provider). At Phase 6 either add ~$5–10 credit with a hard monthly limit (recommended) or develop on a free local/free-tier model via the provider adapter and run evals on OpenAI before pilot.
- **Sessions:** one feature-sized goal per session; every session starts with a Session Brief (see `CLAUDE.md`) and ends by updating this file.
- **Mockups approved to start:** all 7 key screens, as a clickable HTML prototype, branded Floty, warm & friendly, mobile-first.
- **Proposed design direction (S1, awaiting feedback):** raspberry brand (`#BE2759`/`#B01F52`) on warm neutrals, separate status colors (fern/amber/lake), Bricolage Grotesque (display) + Figtree (body), speech-bubble-with-a-face mark, lowercase "floty" wordmark. Details in `docs/mockups/README.md`. Avoided the generic cream + terracotta + serif look on purpose.
- **Prototype sample business:** Juniper Hair Studio (salon template: "client", "stylist"); owner Ana Reyes; stylists Jess, Marco, Priya; mock "today" = Thu Oct 15 2026.
- Earlier name candidates (for reference): Hiro, Tendly, Bizzy, Staffie, Remy, Okayo, Kora.

## Planned sessions (next first)
| # | Session target | Phase | Done when |
|---|---|---|---|
| S1 | ~~Mockups part 1~~ **built**; only open item is the user's feedback (questions in `docs/mockups/README.md`) → log it in the README's Feedback log and apply it at the start of S2 | 0 | Feedback captured |
| S2 | **Mockups part 2:** apply S1 feedback, then Client profile + "What I know", Autonomy settings, Onboarding, Public booking page | 0 | All 7 screens clickable; user signs off; design tokens recorded in `docs/product/ux-principles.md` |
| S3 | **Phase 1a:** monorepo (pnpm + Turborepo), TypeScript strict, lint/format, Vitest, CI on GitHub Actions, create `main` branch workflow | 1 | CI green on skeleton packages |
| S4 | **Phase 1b:** apps skeletons (Next.js web, NestJS api + worker), Docker Compose (Postgres+pgvector, Redis, MinIO, Mailpit), health checks, Playwright smoke test | 1 | `docker compose up` serves all apps; E2E smoke passes in CI |
| S5 | **Phase 1c:** env validation (Zod), redacting logger, Sentry + OpenTelemetry wiring, Testcontainers integration-test harness | 1 | Phase 1 exit criteria met |
| … | Phase 2 split into: auth (Better Auth + MFA) · tenancy + RLS + cross-tenant suite · roles + audit log | 2 | per roadmap |

## How to resume in a new session
Say: *"Read CLAUDE.md and docs/plan/STATUS.md, give me the Session Brief, then continue."* At the end of each session Claude updates this file (Done / Decisions / Planned sessions) and commits it.

# Project Status — read this first in every new session

**Last updated:** 2026-10-16 · **Plan version:** 0.2 · **Current phase:** 0 — Planning (no application code yet)

## Done
- Full planning set in `docs/` (product, architecture, engineering, plan) and `CLAUDE.md`.
- Competitor audit v0.1 (`docs/research/competitor-audit.md`).
- ADR-0001…0006 written (status: Proposed).

## Decisions made in conversation (not yet elsewhere in docs)
- **Skip domain, business email and LLC during development.** Needed only before the pilot (Phase 11) / before charging customers. Product keeps the working name "AI Employee" until a brand is chosen.
- **Free development setup:** Postgres+pgvector, Redis, MinIO and Mailpit (fake inbox) in Docker; GitHub Actions, Sentry and Grafana Cloud free tiers; Google Calendar API with a personal Gmail and the OAuth app in "testing" mode (≤ 100 test users, no verification).
- **OpenAI cost:** $0 until Phase 6 (tests use a fake provider). At Phase 6 either add ~$5–10 credit with a hard monthly limit (recommended) or develop on a free local/free-tier model via the provider adapter and run evals on OpenAI before pilot.
- **Working name: Floty** (chosen by user 2026-10-16). Final brand, trademark and domain checks happen before the pilot. Earlier candidates: Hiro, Tendly, Bizzy, Staffie, Remy, Okayo, Kora.
- **Docs reviewed by user: no changes requested** (2026-10-16).

## Next steps (Phase 0 remaining)
1. ~~User reviews docs~~ — done, no changes.
2. User accepts/adjusts ADR-0001…0006 and open decisions D2 (auth — recommend Better Auth) and D3 (ORM — recommend Drizzle) — `docs/plan/open-decisions.md`. **Waiting on user.**
3. Clickable HTML mockups of the 7 key screens, branded "Floty" (`docs/product/ux-principles.md` → "Key screens"). **Waiting on user's "go".**
4. ~~Choose product name~~ — working name Floty.
5. Then request approval to start **Phase 1 — Foundations** (`docs/plan/roadmap-phases.md`).

## How to resume in a new session
Say: *"Read CLAUDE.md and docs/plan/STATUS.md, then continue with the next step."* At the end of each session Claude updates this file (Done / Decisions / Next steps) and commits it.

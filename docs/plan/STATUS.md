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
- **Name candidates** (D1, undecided): Hiro ("Hire Hiro", recommended — check trademark conflicts), Tendly (backup), Bizzy, Staffie, Remy, Okayo, Kora. Domain availability not yet checked.

## Next steps (Phase 0 remaining)
1. User reviews docs; any change → PCR (`docs/plan/changes/`).
2. User accepts/adjusts ADR-0001…0006 and open decisions D2 (auth) and D3 (ORM) — `docs/plan/open-decisions.md`.
3. UX mockups of key screens (`docs/product/ux-principles.md` → "Key screens"), placeholder name allowed.
4. Choose product name (D1) — can happen during/after mockups.
5. Then request approval to start **Phase 1 — Foundations** (`docs/plan/roadmap-phases.md`).

## How to resume in a new session
Say: *"Read CLAUDE.md and docs/plan/STATUS.md, then continue with the next step."* At the end of each session Claude updates this file (Done / Decisions / Next steps) and commits it.

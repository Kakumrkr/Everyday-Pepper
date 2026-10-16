# Project Status — read this first in every new session

**Last updated:** 2026-10-16 · **Plan version:** 0.4 · **Current phase:** 1 — Foundations (S3 done → next: S4)

## Done
- Full planning set in `docs/` (product, architecture, engineering, plan) and `CLAUDE.md`. **Reviewed and approved by the user — no changes.**
- Competitor audit v0.1 (`docs/research/competitor-audit.md`).
- ADR-0001…0008 **accepted** (incl. Better Auth for auth, Drizzle for the database layer).
- Working name chosen: **Floty**.
- **S1 Mockups part 1 (2026-10-16):** clickable prototype `docs/mockups/floty-prototype.html` with Home/operator feed, Chat with cards, Calendar (day/week), a design-direction page, and placeholders for part 2. Phone + desktop layouts, light + dark. Preview: https://claude.ai/artifact/WNTU3YyQgBjJvCC9hxHqS1. **User approved part 1 with no changes.** Checks: Playwright click-through (112 assertions, 4 viewport/theme combos) and WCAG AA token contrast, both passing (`docs/mockups/checks/`).

- **S2 Mockups part 2 (2026-10-16):** added Clients + client profile, What I know (add/edit/delete with Undo; deleting the PPD allergy removes it everywhere), Autonomy (per-action dial, bulk "Just do it" locked), Team & services (roles, invite, menu), full-screen Onboarding (type → source → review → optional CSV import → link + Google Calendar) and the public Booking page (business-branded, stylist photo placeholders, prices, email code, "slot just taken" alternatives). Same preview link. Checks: 260 Playwright assertions across 4 viewport/theme combos + WCAG AA contrast (incl. new `danger` and `biz` tokens), all passing.

- **Phase 0 signed off (2026-10-16):** user approved all mockups and the 5 S2 questions. Design tokens recorded in `docs/product/ux-principles.md`. PCR-001 approved (business brand color on the booking page, picked in onboarding). Plan version 0.4.

- **S3 Phase 1a (2026-10-16):** pnpm + Turborepo monorepo; strict ESM TypeScript (`packages/config`); ESLint (typescript-eslint strict, layer-boundary rule from the dependency map, no deep imports, disable comments need a reason) + Prettier + EditorConfig; Vitest with ≥ 80% coverage gate; placeholder packages `@floty/contracts` (`RiskTier`, `AutonomyLevel`, `UtcDateTime` schemas) and `@floty/core` (`Clock`, `ManualClock`, `utcNow`); CI workflow (format → lint → typecheck → test+coverage → build, actions pinned to SHAs); Dependabot; `docs/engineering/dev-setup.md`; root README. `main` branch created at the Phase 0 sign-off commit. Checks run: clean `pnpm install --frozen-lockfile` + `pnpm check` all green (30 tests, 100% coverage); verified lint rejects `any`, unexplained `!`, layer violations, deep imports, undescribed disables; typecheck rejects type errors; coverage gate fails at 68%; actionlint clean.

## Decisions made in conversation
- **Skip domain, business email and LLC during development.** Needed only before the pilot (Phase 11) / before charging customers. Final brand, trademark and domain checks also happen before the pilot.
- **Free development setup:** Postgres+pgvector, Redis, MinIO and Mailpit (fake inbox) in Docker; GitHub Actions, Sentry and Grafana Cloud free tiers; Google Calendar API with a personal Gmail and the OAuth app in "testing" mode (≤ 100 test users, no verification).
- **OpenAI cost:** $0 until Phase 6 (tests use a fake provider). At Phase 6 either add ~$5–10 credit with a hard monthly limit (recommended) or develop on a free local/free-tier model via the provider adapter and run evals on OpenAI before pilot.
- **Sessions:** one feature-sized goal per session; every session starts with a Session Brief (see `CLAUDE.md`) and ends by updating this file.
- **Mockups approved to start:** all 7 key screens, as a clickable HTML prototype, branded Floty, warm & friendly, mobile-first.
- **Design direction approved by the user (S1 feedback: "all good", no changes):** raspberry brand (`#BE2759`/`#B01F52`) on warm neutrals, separate status colors (fern/amber/lake), Bricolage Grotesque (display) + Figtree (body), speech-bubble-with-a-face mark, lowercase "floty" wordmark. Details in `docs/mockups/README.md`. Avoided the generic cream + terracotta + serif look on purpose.
- **S2 decisions (user, 2026-10-16):** booking page shows prices and stylist photos (placeholders in the mockup); onboarding includes an optional client-import step (Vagaro/Fresha/Square/Booksy/CSV).
- **Booking page uses the business's own brand color** (`biz` tokens; Floty raspberry only in the "Booking by floty" footer). Owners pick that color in onboarding (PCR-001, approved).
- **Autonomy defaults approved:** create booking = Ask me; move/accept page requests/block/notes = Do it and tell me; confirmations & reminders = Just do it; rebooking nudges & waitlist offers = Ask me; bulk (>10) = Ask me, "Just do it" locked.
- **Prototype sample business:** Juniper Hair Studio (salon template: "client", "stylist"); owner Ana Reyes; stylists Jess, Marco, Priya; mock "today" = Thu Oct 15 2026.
- **Branch workflow (S3, user):** `main` is the integration branch (created from `ea2a951`). Each session works on a `claude/*` branch and opens a PR into `main`; the user reviews and merges; head branches are deleted after merge. The S1/S2 work had lived on `claude/sharp-noether-re1wo9`, which was never merged — always start a session from `main`.
- **Lint/format: ESLint + Prettier** (user, S3), not Biome.
- **TypeScript pinned to 6.0.x** until typescript-eslint supports 6.1+/7 (S3 finding; see dev-setup.md).
- **Module format: ESM** for all packages (NodeNext). NestJS apps in S4 must consume ESM packages (Node 22 `require(esm)` works, or run Nest as ESM) — confirm in S4.
- Earlier name candidates (for reference): Hiro, Tendly, Bizzy, Staffie, Remy, Okayo, Kora.

## Waiting on the user (GitHub settings, one-time)
1. Settings → General → **Default branch → `main`** (currently the stale `claude/youthful-cori-cexdi2`).
2. Settings → General → Pull Requests → **Automatically delete head branches**.
3. Delete stale branches `claude/youthful-cori-cexdi2`, `claude/wonderful-newton-opp16r` (unused duplicate S1) and, once merged, `claude/sharp-noether-re1wo9`.
4. After the S3 PR is green: branch protection on `main` requiring a PR and the **CI / Lint, typecheck, test, build** check.

## Planned sessions (next first)
| # | Session target | Phase | Done when |
|---|---|---|---|
| S4 | **Phase 1b:** apps skeletons (Next.js web, NestJS api + worker), Docker Compose (Postgres+pgvector, Redis, MinIO, Mailpit), health checks, Playwright smoke test | 1 | `docker compose up` serves all apps; E2E smoke passes in CI |
| S5 | **Phase 1c:** env validation (Zod), redacting logger, Sentry + OpenTelemetry wiring, Testcontainers integration-test harness | 1 | Phase 1 exit criteria met |
| … | Phase 2 split into: auth (Better Auth + MFA) · tenancy + RLS + cross-tenant suite · roles + audit log | 2 | per roadmap |

## How to resume in a new session
Start the session from the latest `main`. Say: *"Read CLAUDE.md and docs/plan/STATUS.md, give me the Session Brief, then continue."* At the end of each session Claude updates this file (Done / Decisions / Planned sessions) and commits it.

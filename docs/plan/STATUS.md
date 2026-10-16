# Project Status — read this first in every new session

**Last updated:** 2026-10-16 · **Plan version:** 0.4 · **Current phase:** 1 — Foundations complete and merged (S5, PR #6) → next: Phase 2 (S6)

## Done
- Full planning set in `docs/` (product, architecture, engineering, plan) and `CLAUDE.md`. **Reviewed and approved by the user — no changes.**
- Competitor audit v0.1 (`docs/research/competitor-audit.md`).
- ADR-0001…0008 **accepted** (incl. Better Auth for auth, Drizzle for the database layer).
- Working name chosen: **Floty**.
- **S1 Mockups part 1 (2026-10-16):** clickable prototype `docs/mockups/floty-prototype.html` with Home/operator feed, Chat with cards, Calendar (day/week), a design-direction page, and placeholders for part 2. Phone + desktop layouts, light + dark. Preview: https://claude.ai/artifact/WNTU3YyQgBjJvCC9hxHqS1. **User approved part 1 with no changes.** Checks: Playwright click-through (112 assertions, 4 viewport/theme combos) and WCAG AA token contrast, both passing (`docs/mockups/checks/`).

- **S2 Mockups part 2 (2026-10-16):** added Clients + client profile, What I know (add/edit/delete with Undo; deleting the PPD allergy removes it everywhere), Autonomy (per-action dial, bulk "Just do it" locked), Team & services (roles, invite, menu), full-screen Onboarding (type → source → review → optional CSV import → link + Google Calendar) and the public Booking page (business-branded, stylist photo placeholders, prices, email code, "slot just taken" alternatives). Same preview link. Checks: 260 Playwright assertions across 4 viewport/theme combos + WCAG AA contrast (incl. new `danger` and `biz` tokens), all passing.

- **Phase 0 signed off (2026-10-16):** user approved all mockups and the 5 S2 questions. Design tokens recorded in `docs/product/ux-principles.md`. PCR-001 approved (business brand color on the booking page, picked in onboarding). Plan version 0.4.

- **S3 Phase 1a (2026-10-16):** pnpm + Turborepo monorepo; strict ESM TypeScript (`packages/config`); ESLint (typescript-eslint strict, layer-boundary rule from the dependency map, no deep imports, disable comments need a reason) + Prettier + EditorConfig; Vitest with ≥ 80% coverage gate; placeholder packages `@floty/contracts` (`RiskTier`, `AutonomyLevel`, `UtcDateTime` schemas) and `@floty/core` (`Clock`, `ManualClock`, `utcNow`); CI workflow (format → lint → typecheck → test+coverage → build, actions pinned to SHAs); Dependabot; `docs/engineering/dev-setup.md`; root README. `main` branch created at the Phase 0 sign-off commit. Checks run: clean `pnpm install --frozen-lockfile` + `pnpm check` all green (30 tests, 100% coverage); verified lint rejects `any`, unexplained `!`, layer violations, deep imports, undescribed disables; typecheck rejects type errors; coverage gate fails at 68%; actionlint clean.

- **S4 Phase 1b (2026-10-16):** apps skeletons: `apps/api` + `apps/worker` (NestJS 12, ESM, Express 5) with `GET /health/live` and `/health/ready` (Postgres + Redis; 503 when down, body says only up/down), `apps/web` (Next.js 16) placeholder home showing API readiness + `/health/live`. Shared pieces: `HealthReportSchema` (`@floty/contracts`), `runHealthChecks` with per-check timeout (`@floty/core`), new `@floty/runtime` package (Nest health/connections modules, env helpers that never echo values). One multi-stage `Dockerfile` (digest-pinned base, `pnpm deploy --prod`, Next standalone, non-root, healthchecks); `docker-compose.yml` with Postgres+pgvector, Redis, Mailpit, api, worker, web (ports on 127.0.0.1, local-only default credentials, `.env.example`). `e2e/` Playwright smoke on phone + desktop; CI job **E2E smoke (Docker Compose)**; Dependabot for docker/compose. Checks run: `pnpm check` green (81 unit tests, coverage ≥ 90% everywhere); `docker compose up --wait` → all 6 services healthy; Playwright smoke 8/8 passing against Compose; stopping Postgres → api ready 503 + web shows "starting up", recovers on restart; containers run as `node`, stop in < 1 s; `pnpm dev` serves all three apps against Compose infra; actionlint + `docker compose config` clean. **Not yet proven:** the CI e2e job itself (runs on the PR). Local Docker builds in the cloud sandbox needed the session proxy CA (scratch Dockerfile, not committed).

- **S5 Phase 1c (2026-10-16):** shared config, logging, telemetry and integration tests.
  - **Config:** `loadServiceConfig` in `@floty/runtime` replaces the per-app `loadEnv`. It is validated with Zod; errors name the variable but never its value; empty means unset. Adds `LOG_LEVEL`, `DEPLOYMENT_ENVIRONMENT`, `RELEASE`, `SENTRY_DSN` and `OTEL_EXPORTER_OTLP_ENDPOINT`.
  - **Logging:** pino logger with one `redact` path (sensitive keys; emails, phones, URL credentials and bearer tokens in free text), Nest logger adapter, `x-request-id` and one log line per request (no query string).
  - **Correlation:** `request_id` (AsyncLocalStorage) and `trace_id`/`span_id` on every log line.
  - **Tracing and errors:** OpenTelemetry tracing (http, express, pg, ioredis → OTLP/HTTP; query strings redacted) and Sentry errors-only (all data collection off, events redacted). Each is off unless its env var is set.
  - **Start-up:** `node --import ./dist/instrument.js` preload via the new `@floty/runtime/instrument` entry. `createServiceApp` does the shared Nest wiring, flushes telemetry on shutdown and reports unexpected errors.
  - **Testing:** new `@floty/testing` package with Testcontainers Postgres/Redis (images read from `docker-compose.yml`) and a recording HTTP server. Integration tests are `*.int.test.ts` run by `pnpm test:integration`; CI job **Integration (Testcontainers)** runs them.
  - **Docs:** ADR-0009 (accepted by the user before S6); dev-setup, observability and dependency-map updated.
  - **Checks run:**
    - `pnpm check` green: 145 unit tests; runtime coverage 97.6% lines / 91.7% branches; every other package 100%.
    - `pnpm test:integration` green, 3 files: containers reachable; readiness 200 against real Postgres + Redis; the built api started with `--import` exports http/express/pg/ioredis spans to a fake OTLP collector, its logs carry `request_id` + a `trace_id` that matches the exported spans, no email/credentials/query leave the process, and SIGTERM flushes spans.
    - Mutation check: removing the ESM loader hook makes that test fail (no spans).
    - Docker images rebuilt; `docker compose up --wait` → 6/6 healthy; Playwright smoke 8/8 (now also asserts `x-request-id` and no `X-Powered-By`); api stops in < 1 s.
    - actionlint and `docker compose config` clean.
  - **Not yet proven:** the new CI integration job itself (runs on the PR).
  - **Findings:**
    - `@opentelemetry/instrumentation-nestjs-core` supports Nest < 12 only, so it is not installed; express spans carry routes.
    - Readiness reports Redis down for a moment right after boot (the client fails fast while connecting); Docker's start period absorbs it.
    - `@sentry/node` 11 adds ~65 MB (it pulls in the Sentry CLI); api/worker images are 426 MB.
    - In this sandbox `dockerd` must be started by hand.

- **Maintenance (2026-10-16, after S5):** PR #6 (S5) merged into `main` by Claude at the user's request ("you do the work"). Dependabot PR #5 (Node 22 → 25 Docker image) closed: Node stays on 22 LTS, and Dependabot now ignores Node majors for the Docker image. Added a SessionStart hook for cloud sessions (`.claude/hooks/session-start.sh`: `pnpm install`, start `dockerd`), tested from a clean state (no `node_modules`, Docker stopped) and on a re-run.

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
- **Module format: ESM** for all packages (NodeNext). Confirmed in S4: Nest 12 ships ESM, so api/worker run as native ESM.
- **S4 defaults (Claude, user to confirm or change):** NestJS on Express (not Fastify); Vitest compiles Nest code with SWC; shared Nest wiring lives in a new `packages/runtime` (`@floty/runtime`) that S5 extends with config/logger/telemetry; the readiness `SELECT 1` lives in runtime until `packages/db` exists (Phase 2); web unit tests cover `lib/` and route handlers, pages are covered by Playwright.
- **S5 defaults — ADR-0009, accepted by the user (2026-10-16, S6 start):** OpenTelemetry owns tracing (lean `NodeTracerProvider` + explicit instrumentations, not the auto-instrumentation bundle); Sentry is errors-only and collects no personal data; pino used directly (no `nestjs-pino`); our own request-logging middleware instead of `pino-http`; `/health/live` not traced, `/health/ready` traced; health request logs at `debug`; one extra package entry point `@floty/runtime/instrument` (lint allows exactly this one); `@floty/testing` reads container images from `docker-compose.yml` so tests and the dev stack share pinned digests; integration tests have no coverage gate.
- **MinIO left out of Compose (S4 finding):** MinIO no longer publishes community images. Replacement is open decision **D10** (recommendation: SeaweedFS); needed by Phase 4.
- **GitHub settings done by the user (2026-10-16, before S6):** default branch is `main`; branch protection on `main` requires a PR and the three CI checks (**CI / Lint, typecheck, test, build**, **CI / Integration (Testcontainers)**, **CI / E2E smoke (Docker Compose)**); head branches are deleted automatically after merge; stale branches deleted.
- Earlier name candidates (for reference): Hiro, Tendly, Bizzy, Staffie, Remy, Okayo, Kora.

## Waiting on the user
1. Decide **D10** (dev object storage replacing MinIO) — before Phase 4.
2. Optional, any time: create a free Sentry project and a Grafana Cloud stack and put `SENTRY_DSN` / `OTEL_EXPORTER_OTLP_*` in your local `.env` to see errors and traces (nothing is needed for development).

## Planned sessions (next first)
S6–S8 split Phase 2: db + tenancy/RLS before auth, so auth can build on the tenant context. **Order confirmed by the user at the S6 Session Brief (2026-10-16).**

| # | Session target | Phase | Done when |
|---|---|---|---|
| S6 | **Phase 2a:** `packages/db` (Drizzle, migrations, readiness probe moves there), tenants + memberships schema, tenant-scoped transaction helper (`SET LOCAL`), RLS policies, cross-tenant isolation suite started (Testcontainers) | 2 | RLS proven by integration tests; cross-tenant suite 100% for what exists |
| S7 | **Phase 2b:** auth (Better Auth + MFA for owners), session → tenant context (+ `tenant_id`/`user_id` on log lines), auth E2E | 2 | auth E2E passing |
| S8 | **Phase 2c:** roles/permissions matrix, audit log, usage-metering skeleton | 2 | role matrix 100%; Phase 2 exit criteria |

## How to resume in a new session
Start the session from the latest `main`. Say: *"Read CLAUDE.md and docs/plan/STATUS.md, give me the Session Brief, then continue."* At the end of each session Claude updates this file (Done / Decisions / Planned sessions) and commits it.

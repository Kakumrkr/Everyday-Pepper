# Project Status — read this first in every new session

**Last updated:** 2026-10-17 · **Plan version:** 0.5 · **Current phase:** 2 — Platform core. S7 (Phase 2b: auth) done, PR #9 green and waiting for review → next: S8 (roles/audit/metering)

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

- **S6 Phase 2a (2026-10-16):** database layer and tenant isolation.
  - **`@floty/db` (new):** Drizzle 0.45 schema, SQL migrations (drizzle-kit 0.31 generates; hand-written migrations add what it cannot express), and repositories. It is the only package that talks to Postgres.
  - **Migrations:** `0000` creates the `floty_app` group role, `current_tenant_id()` and `set_updated_at()`. `0001` creates `tenants` and `memberships` with their `tenant_isolation` policies. `0002` adds `FORCE ROW LEVEL SECURITY` and the `updated_at` triggers.
  - **Tenant context:** `withTenant(db, tenantId, work)` sets the tenant transaction-locally with a bound parameter.
  - **Migrate step:** `runMigrations` (serialised by an advisory lock) and `provisionAppRole` (creates or updates the login role, refuses privileged roles). They run from the `migrate` CLI, `pnpm db:migrate`, and the one-shot Compose `migrate` service. api and worker now connect as `floty_service`.
  - **Readiness:** the probe moved from runtime to `@floty/db` (`DatabaseHandle.ping`) and fails if the role bypasses RLS. Runtime exports a `DATABASE` token.
  - **Contracts:** `TenantId`, `UserId`, `TenantSlug`, `TimeZone`, `Locale`, `MembershipRole`, `NewTenant`.
  - **Testing:** `postgresUrlAs` added to `@floty/testing`.
  - **Docs:** ADR-0010 (accepted by the user, 2026-10-16); data-model, dependency-map, dev-setup, testing-strategy, security-and-tenancy and traceability (AC-X-1) updated.
  - **Checks run:**
    - `pnpm check` green: db 22 unit tests, 97% statements / 100% branches; contracts 67 tests; runtime 74 tests.
    - `pnpm test:integration` green, 6 files / 55 tests. db: 51 tests (migrations, provisioning, repositories, cross-tenant suite 30/30).
    - Mutation checks, each caught: a policy `USING (true)` → 6 failures; `FORCE` removed → catalog test fails; session-wide `set_config` → 6 failures; no `NULLIF` → 4 failures; a schema change without a migration → drift test fails.
    - Docker images built. `docker compose up --wait` → 6 services healthy and `migrate` exited 0; also with `up --build` (api image built from cache twice, harmless). A second `up` re-runs `migrate` idempotently. Playwright smoke 8/8. `pg_stat_activity` shows api and worker connected as `floty_service`. `pnpm db:migrate` works against Compose Postgres.
  - **CI on PR #8:** all three required checks green (lint/typecheck/test/build, Integration, E2E smoke with the `migrate` service).
  - **Findings:**
    - drizzle-kit needs a relative `--out` path and exits 0 even on errors, so the drift test also checks its "No schema changes" message.
    - Existing local volumes keep working: `POSTGRES_USER` is unchanged, and `migrate` adds the schema and the new role.

- **S7 Phase 2b (2026-10-17):** sign-in, MFA for owners and tenant context from the session ([ADR-0012](../adr/0012-auth-sessions-and-tenant-context.md), proposed).
  - **db:**
    - Better Auth's global tables: `users`, `sessions` (+ `active_tenant_id`), `accounts`, `verifications`, `two_factors`. UUID v7 ids; emails lowercased by a CHECK constraint.
    - `memberships.user_id` gets a foreign key (cascade) and an index.
    - "My businesses": `current_user_id()` and read-only `member_read` policies (only when no tenant is set), used through `withUser`.
    - New repository functions: `listUserBusinesses`, `createTenant(..., { owner })`, `setSessionActiveTenant`, `authDatabaseAdapter`.
    - Migrations 0003–0005.
  - **api:**
    - Better Auth 1.7 at `/api/auth`: email and password (≥ 10 characters), TOTP with backup codes, 7-day DB sessions without cookie cache, built-in rate limits, telemetry off. Its CSRF checks are pinned on even under `NODE_ENV=test`.
    - It sits behind an `AuthService` interface.
    - Guards: `SessionGuard`, `TenantGuard` (`decideTenantAccess` in core: no business / not a member / owner without MFA) and `SameOriginGuard` (Origin check on every write).
    - Endpoints: `GET /v1/me`, `PUT /v1/me/active-tenant`, `POST /v1/tenants`, `GET /v1/tenant`.
    - A new session starts in the user's first business. Log lines carry `user_id`/`tenant_id` (`identifyRequest` in runtime).
    - Config: `AUTH_SECRET`, `AUTH_BASE_URL` (https outside localhost).
  - **web:**
    - Forwards `/api/auth/*` and `/v1/*` to the api at request time: allowlisted headers, every `Set-Cookie` kept, 100 KB body cap, 502 when the api is down.
    - Screens: sign in (TOTP or backup code), sign up, create business (slug suggested from the name, browser time zone), two-step setup (QR via `uqr`, manual key, backup codes), and a signed-in home with business switcher and sign-out.
    - Pages route to the next required step.
  - **Also:**
    - `@floty/contracts`: account schemas.
    - `@floty/testing`: RFC 6238 `totpCode`.
    - Compose and `.env.example`: auth variables.
    - `.pnpmfile.cjs`: keeps only better-auth's `drizzle-orm`/`pg` peers. api image 1.26 GB → 461 MB; it was 426 MB before S7.
  - **Checks run:**
    - `pnpm check` green. Unit tests: contracts 76, core 25, db 29, runtime 75, testing 13, api 48, web 55, worker 3. Coverage: db 100%, api 95.6%, web 98.4%.
    - `pnpm test:integration` green: db 70 (isolation suite 42, incl. auth tables and the user context), api 21 (owner journey, cross-business denials, membership removal, update-session, CSRF, rate limit 429, no secrets in logs or the DB), runtime 2, testing 1.
    - Mutation check: dropping `current_tenant_id() IS NULL` from `member_read` → 2 isolation failures.
    - Docker images built. `docker compose up --wait`: 6 services healthy, `migrate` exited 0.
    - Playwright 18/18 on phone and desktop, three runs in a row: full owner journey, backup code, wrong password, signed-out redirects, no sideways overflow.
    - api logs: no errors, no emails or passwords, `user_id`/`tenant_id` present.
  - **CI on PR #9:** all three required checks green (lint/typecheck/test/build, Integration, E2E smoke incl. the new auth journey); mergeable.
  - **Findings:**
    - Better Auth turns off its CSRF and origin checks when `NODE_ENV=test`, so we pin them on.
    - pnpm resolves optional peers from the whole workspace, which put next/react/vitest/playwright into the api image (fixed by `.pnpmfile.cjs`).
    - Next.js keeps a client-sent `X-Forwarded-For`, so per-address rate limits can be dodged until an edge proxy overwrites it (Phase 11).
    - Better Auth logs a few messages (e.g. "Invalid origin") to the console, bypassing our logger. No personal data seen.
    - Sign-up reveals whether an email exists (422) until email verification (Phase 5).
    - Next's route announcer is also `role="alert"`; tests match form errors by text.

## Decisions made in conversation
- **Skip domain, business email and LLC during development.** Needed only before the pilot (Phase 11) / before charging customers. Final brand, trademark and domain checks also happen before the pilot.
- **Free development setup:** Postgres+pgvector, Redis, S3-compatible storage (SeaweedFS, see D10 below) and Mailpit (fake inbox) in Docker; GitHub Actions, Sentry and Grafana Cloud free tiers; Google Calendar API with a personal Gmail and the OAuth app in "testing" mode (≤ 100 test users, no verification).
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
- **MinIO left out of Compose (S4 finding):** MinIO no longer publishes community images.
- **D10 resolved (user, 2026-10-16, S7 start): SeaweedFS** for dev/CI object storage ([ADR-0011](../adr/0011-dev-object-storage-seaweedfs.md)). It is added to Compose in Phase 4, when stylist photos first need storage; not in S7.
- **GitHub settings done by the user (2026-10-16, before S6):** default branch is `main`; branch protection on `main` requires a PR and the three CI checks (**CI / Lint, typecheck, test, build**, **CI / Integration (Testcontainers)**, **CI / E2E smoke (Docker Compose)**); head branches are deleted automatically after merge; stale branches deleted.
- **Phase 2 order confirmed (user, S6 start):** S6 db + tenancy/RLS → S7 auth → S8 roles/audit. **ADR-0009 accepted** (user, S6 start).
- **S6 defaults — ADR-0010, accepted by the user (2026-10-16, end of S6):**
  - (a) The services connect as their own login role (`floty_service`), a member of the `floty_app` group role. The migrate step creates and updates it from `DATABASE_URL`, using a separate `MIGRATION_DATABASE_URL` for the owner. Readiness fails for a role that bypasses RLS.
  - (b) IDs are UUID v7, generated in the app with the `uuid` package (Postgres 17 has no `uuidv7()`).
  - (c) The `users` table waits for S7, so Better Auth shapes it. `memberships.user_id` has no foreign key until then.
  - (d) RLS goes through a `current_tenant_id()` SQL function with `NULLIF`. `tenant_id` defaults to it, so repositories never take a tenant id.
  - (e) `runtime` may import `db` (lint and dependency map updated). The api image carries the migrate CLI (`@floty/db` is a direct api dependency).
  - (f) Repositories, migrations and RLS are covered by integration tests and excluded from the unit coverage gate.
- **S7 defaults — ADR-0012, proposed by Claude (2026-10-17), user to accept or change:**
  - (a) Auth tables are global (no RLS), classified in the isolation suite, reached only through `authDatabaseAdapter`.
  - (b) "My businesses" uses read-only, user-keyed `member_read` policies via `withUser`, not a `SECURITY DEFINER` function (FORCE RLS would filter it unless the owner is a superuser).
  - (c) The active business is stored in the session, set only after a membership check. New sessions start in the first business.
  - (d) Membership is re-checked on every request. Owners are blocked until TOTP is on; managers and staff are not (yet).
  - (e) The web app forwards `/api/auth/*` and `/v1/*` (one origin, no CORS).
  - (f) Origin check on every write.
  - (g) Passwords ≥ 10 characters until the breached-password check lands.
  - (h) Rate limits in memory (one instance) for now.
  - (i) Out of S7: email verification and password reset (Phase 5), social login (Phase 10), breached-password check, edge proxy and CSP/HSTS (Phase 11).
- Earlier name candidates (for reference): Hiro, Tendly, Bizzy, Staffie, Remy, Okayo, Kora.

## Waiting on the user
1. Optional, any time: create a free Sentry project and a Grafana Cloud stack and put `SENTRY_DSN` / `OTEL_EXPORTER_OTLP_*` in your local `.env` to see errors and traces (nothing is needed for development).

## Planned sessions (next first)
S6–S8 split Phase 2: db + tenancy/RLS before auth, so auth can build on the tenant context. **Order confirmed by the user at the S6 Session Brief (2026-10-16).**

| # | Session target | Phase | Done when |
|---|---|---|---|
| S8 | **Phase 2c:** roles/permissions matrix (in core, next to `decideTenantAccess`; decide whether managers also need MFA), audit log, usage-metering skeleton. Carry-overs from S7: invite a member to a business (needs email → may stay a link until Phase 5); a per-user limit on creating businesses; `/security-review` before Phase 2 exit | 2 | role matrix 100%; Phase 2 exit criteria |

## How to resume in a new session
Start the session from the latest `main`. Say: *"Read CLAUDE.md and docs/plan/STATUS.md, give me the Session Brief, then continue."* At the end of each session Claude updates this file (Done / Decisions / Planned sessions) and commits it.

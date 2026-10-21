# Session log

Everything each session did, oldest first: what was built, the checks run and their results, and what was left for later. Moved here verbatim from `STATUS.md` in maintenance session M1 (2026-10-20), so `STATUS.md` stays short; each new session appends its entry here as well as summarizing it in `STATUS.md`. Paths in entries are relative to `docs/plan/`.

- Full planning set in `docs/` (product, architecture, engineering, plan) and `CLAUDE.md`. **Reviewed and approved by the user — no changes.**
- Competitor audit v0.1 (`docs/research/competitor-audit.md`).
- ADR-0001…0008 **accepted** (incl. Better Auth for auth, Drizzle for the database layer).
- Working name chosen: **Floty**, renamed to **Pepper** on 2026-10-18 ([PCR-002](changes/PCR-002.md)).
- **S1 Mockups part 1 (2026-10-16):** clickable prototype `docs/mockups/pepper-prototype.html` with Home/operator feed, Chat with cards, Calendar (day/week), a design-direction page, and placeholders for part 2. Phone + desktop layouts, light + dark. Preview: https://claude.ai/artifact/WNTU3YyQgBjJvCC9hxHqS1. **User approved part 1 with no changes.** Checks: Playwright click-through (112 assertions, 4 viewport/theme combos) and WCAG AA token contrast, both passing (`docs/mockups/checks/`).

- **S2 Mockups part 2 (2026-10-16):** added Clients + client profile, What I know (add/edit/delete with Undo; deleting the PPD allergy removes it everywhere), Autonomy (per-action dial, bulk "Just do it" locked), Team & services (roles, invite, menu), full-screen Onboarding (type → source → review → optional CSV import → link + Google Calendar) and the public Booking page (business-branded, stylist photo placeholders, prices, email code, "slot just taken" alternatives). Same preview link. Checks: 260 Playwright assertions across 4 viewport/theme combos + WCAG AA contrast (incl. new `danger` and `biz` tokens), all passing.

- **Phase 0 signed off (2026-10-16):** user approved all mockups and the 5 S2 questions. Design tokens recorded in `docs/product/ux-principles.md`. PCR-001 approved (business brand color on the booking page, picked in onboarding). Plan version 0.4.

- **S3 Phase 1a (2026-10-16):** pnpm + Turborepo monorepo; strict ESM TypeScript (`packages/config`); ESLint (typescript-eslint strict, layer-boundary rule from the dependency map, no deep imports, disable comments need a reason) + Prettier + EditorConfig; Vitest with ≥ 80% coverage gate; placeholder packages `@pepper/contracts` (`RiskTier`, `AutonomyLevel`, `UtcDateTime` schemas) and `@pepper/core` (`Clock`, `ManualClock`, `utcNow`); CI workflow (format → lint → typecheck → test+coverage → build, actions pinned to SHAs); Dependabot; `docs/engineering/dev-setup.md`; root README. `main` branch created at the Phase 0 sign-off commit. Checks run: clean `pnpm install --frozen-lockfile` + `pnpm check` all green (30 tests, 100% coverage); verified lint rejects `any`, unexplained `!`, layer violations, deep imports, undescribed disables; typecheck rejects type errors; coverage gate fails at 68%; actionlint clean.

- **S4 Phase 1b (2026-10-16):** apps skeletons: `apps/api` + `apps/worker` (NestJS 12, ESM, Express 5) with `GET /health/live` and `/health/ready` (Postgres + Redis; 503 when down, body says only up/down), `apps/web` (Next.js 16) placeholder home showing API readiness + `/health/live`. Shared pieces: `HealthReportSchema` (`@pepper/contracts`), `runHealthChecks` with per-check timeout (`@pepper/core`), new `@pepper/runtime` package (Nest health/connections modules, env helpers that never echo values). One multi-stage `Dockerfile` (digest-pinned base, `pnpm deploy --prod`, Next standalone, non-root, healthchecks); `docker-compose.yml` with Postgres+pgvector, Redis, Mailpit, api, worker, web (ports on 127.0.0.1, local-only default credentials, `.env.example`). `e2e/` Playwright smoke on phone + desktop; CI job **E2E smoke (Docker Compose)**; Dependabot for docker/compose. Checks run: `pnpm check` green (81 unit tests, coverage ≥ 90% everywhere); `docker compose up --wait` → all 6 services healthy; Playwright smoke 8/8 passing against Compose; stopping Postgres → api ready 503 + web shows "starting up", recovers on restart; containers run as `node`, stop in < 1 s; `pnpm dev` serves all three apps against Compose infra; actionlint + `docker compose config` clean. **Not yet proven:** the CI e2e job itself (runs on the PR). Local Docker builds in the cloud sandbox needed the session proxy CA (scratch Dockerfile, not committed).

- **S5 Phase 1c (2026-10-16):** shared config, logging, telemetry and integration tests.
  - **Config:** `loadServiceConfig` in `@pepper/runtime` replaces the per-app `loadEnv`. It is validated with Zod; errors name the variable but never its value; empty means unset. Adds `LOG_LEVEL`, `DEPLOYMENT_ENVIRONMENT`, `RELEASE`, `SENTRY_DSN` and `OTEL_EXPORTER_OTLP_ENDPOINT`.
  - **Logging:** pino logger with one `redact` path (sensitive keys; emails, phones, URL credentials and bearer tokens in free text), Nest logger adapter, `x-request-id` and one log line per request (no query string).
  - **Correlation:** `request_id` (AsyncLocalStorage) and `trace_id`/`span_id` on every log line.
  - **Tracing and errors:** OpenTelemetry tracing (http, express, pg, ioredis → OTLP/HTTP; query strings redacted) and Sentry errors-only (all data collection off, events redacted). Each is off unless its env var is set.
  - **Start-up:** `node --import ./dist/instrument.js` preload via the new `@pepper/runtime/instrument` entry. `createServiceApp` does the shared Nest wiring, flushes telemetry on shutdown and reports unexpected errors.
  - **Testing:** new `@pepper/testing` package with Testcontainers Postgres/Redis (images read from `docker-compose.yml`) and a recording HTTP server. Integration tests are `*.int.test.ts` run by `pnpm test:integration`; CI job **Integration (Testcontainers)** runs them.
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
  - **`@pepper/db` (new):** Drizzle 0.45 schema, SQL migrations (drizzle-kit 0.31 generates; hand-written migrations add what it cannot express), and repositories. It is the only package that talks to Postgres.
  - **Migrations:** `0000` creates the `pepper_app` group role, `current_tenant_id()` and `set_updated_at()`. `0001` creates `tenants` and `memberships` with their `tenant_isolation` policies. `0002` adds `FORCE ROW LEVEL SECURITY` and the `updated_at` triggers.
  - **Tenant context:** `withTenant(db, tenantId, work)` sets the tenant transaction-locally with a bound parameter.
  - **Migrate step:** `runMigrations` (serialised by an advisory lock) and `provisionAppRole` (creates or updates the login role, refuses privileged roles). They run from the `migrate` CLI, `pnpm db:migrate`, and the one-shot Compose `migrate` service. api and worker now connect as `pepper_service`.
  - **Readiness:** the probe moved from runtime to `@pepper/db` (`DatabaseHandle.ping`) and fails if the role bypasses RLS. Runtime exports a `DATABASE` token.
  - **Contracts:** `TenantId`, `UserId`, `TenantSlug`, `TimeZone`, `Locale`, `MembershipRole`, `NewTenant`.
  - **Testing:** `postgresUrlAs` added to `@pepper/testing`.
  - **Docs:** ADR-0010 (accepted by the user, 2026-10-16); data-model, dependency-map, dev-setup, testing-strategy, security-and-tenancy and traceability (AC-X-1) updated.
  - **Checks run:**
    - `pnpm check` green: db 22 unit tests, 97% statements / 100% branches; contracts 67 tests; runtime 74 tests.
    - `pnpm test:integration` green, 6 files / 55 tests. db: 51 tests (migrations, provisioning, repositories, cross-tenant suite 30/30).
    - Mutation checks, each caught: a policy `USING (true)` → 6 failures; `FORCE` removed → catalog test fails; session-wide `set_config` → 6 failures; no `NULLIF` → 4 failures; a schema change without a migration → drift test fails.
    - Docker images built. `docker compose up --wait` → 6 services healthy and `migrate` exited 0; also with `up --build` (api image built from cache twice, harmless). A second `up` re-runs `migrate` idempotently. Playwright smoke 8/8. `pg_stat_activity` shows api and worker connected as `pepper_service`. `pnpm db:migrate` works against Compose Postgres.
  - **CI on PR #8:** all three required checks green (lint/typecheck/test/build, Integration, E2E smoke with the `migrate` service).
  - **Findings:**
    - drizzle-kit needs a relative `--out` path and exits 0 even on errors, so the drift test also checks its "No schema changes" message.
    - Existing local volumes keep working: `POSTGRES_USER` is unchanged, and `migrate` adds the schema and the new role.

- **S7 Phase 2b (2026-10-17):** sign-in, MFA for owners and tenant context from the session ([ADR-0012](../adr/0012-auth-sessions-and-tenant-context.md), accepted by the user).
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
    - `@pepper/contracts`: account schemas.
    - `@pepper/testing`: RFC 6238 `totpCode`.
    - Compose and `.env.example`: auth variables.
    - `.pnpmfile.cjs`: keeps only better-auth's `drizzle-orm`/`pg` peers. api image 1.26 GB → 461 MB; it was 426 MB before S7.
  - **Checks run:**
    - `pnpm check` green. Unit tests: contracts 76, core 25, db 29, runtime 75, testing 13, api 48, web 55, worker 3. Coverage: db 100%, api 95.6%, web 98.4%.
    - `pnpm test:integration` green: db 70 (isolation suite 42, incl. auth tables and the user context), api 21 (owner journey, cross-business denials, membership removal, update-session, CSRF, rate limit 429, no secrets in logs or the DB), runtime 2, testing 1.
    - Mutation check: dropping `current_tenant_id() IS NULL` from `member_read` → 2 isolation failures.
    - Docker images built. `docker compose up --wait`: 6 services healthy, `migrate` exited 0.
    - Playwright 18/18 on phone and desktop, three runs in a row: full owner journey, backup code, wrong password, signed-out redirects, no sideways overflow.
    - api logs: no errors, no emails or passwords, `user_id`/`tenant_id` present.
  - **CI on PR #9:** all three required checks green (lint/typecheck/test/build, Integration, E2E smoke incl. the new auth journey). ADR-0012 accepted and PR merged by Claude at the user's request (2026-10-17).
  - **Findings:**
    - Better Auth turns off its CSRF and origin checks when `NODE_ENV=test`, so we pin them on.
    - pnpm resolves optional peers from the whole workspace, which put next/react/vitest/playwright into the api image (fixed by `.pnpmfile.cjs`).
    - Next.js keeps a client-sent `X-Forwarded-For`, so per-address rate limits can be dodged until an edge proxy overwrites it (Phase 11).
    - Better Auth logs a few messages (e.g. "Invalid origin") to the console, bypassing our logger. No personal data seen.
    - Sign-up reveals whether an email exists (422) until email verification (Phase 5).
    - Next's route announcer is also `role="alert"`; tests match form errors by text.

- **S8 Phase 2c (2026-10-17):** roles and permissions, audit log, usage metering, team API ([ADR-0013](../adr/0013-roles-audit-log-and-metering.md), accepted by the user).
  - **contracts:** `Permission` (every action incl. later phases), `roleRequiresMfa` (owners and managers), `AuditChangeSchema` (strict per-action before/after: no personal data), audit log query/response, `UsageMetric`/`UsagePeriod`/`UsageAmount`, member list and role-change bodies, error codes `forbidden`, `member_not_found`, `last_owner`, `business_limit_reached`. Tenant and user ids are lowercased.
  - **core:** `PERMISSION_MATRIX` + `can()` (`all`/`own`/none; staff reach only their own bookings, clients, notes), `decideMembershipChange` (anyone may leave; only owners touch owners; one owner always remains), `requirePermission`/`Actor`, `usagePeriodOf`. Domain services in `src/services/`: `listMembers`, `changeMemberRole`, `removeMember` (lock the business's memberships, re-read the actor's role, audit entry in the same transaction), `createBusiness` (5 per owner, `tenant.created` entry), `readAuditLog` (cursor pages), `recordUsage`/`usageFor`. Core now depends on db and has integration tests.
  - **db:** `audit_log` (forced RLS; the services may only INSERT/SELECT; actor nulled when a user is deleted) and `usage_meters` (atomic upsert per tenant/metric/UTC month); repositories `appendAuditEntry`, `listAuditEntries`, `addUsage`, `listUsage`, `listTenantMembers`, `updateMembershipRole`, `deleteMembership`, `countOwners`, `lockTenantMemberships`, `countOwnedBusinesses`; `createTenant` gains `ownerLimit` (per-user advisory lock, same transaction) and `afterInsert`; `setTransactionTenant`/`setTransactionUser`. Migrations 0006–0007.
  - **api:** `@RequirePermission` on `TenantGuard` (403 `forbidden`); managers need MFA; `GET /v1/members`, `PATCH /v1/members/:userId`, `DELETE /v1/members/:userId` (own id = leave, clears the session's business), `GET /v1/audit-log`; `POST /v1/tenants` through core (409 `business_limit_reached`); domain errors mapped in `http/domain-errors.ts`; `AuthModule` is global; new `TeamModule`.
  - **web:** managers are sent to two-step setup like owners; message for `business_limit_reached`. (Team screen: S9.)
  - **Checks run:**
    - `pnpm check` green. Unit tests: contracts 119, core 397 (matrix: every role × permission cell, own/colleague/unassigned records; membership rules: every role × target × change), db 32, runtime 75, testing 13, api 83, web 57, worker 3. Coverage: contracts, core, db 100%; api 94.8%; web 98.4%.
    - `pnpm test:integration` green: db 113 (isolation suite incl. `audit_log`/`usage_meters` and per-table grants; append-only, allowlist, rollback, erasure; usage sums and 40 concurrent increments; team repositories, lock, owner limit under concurrency), core 33 (services per role, stale actor role, staff cannot probe membership, 5 rounds each of two owners demoting each other / leaving at once), api 31 (manager MFA gate, staff denials, role change with request id in the audit row, cross-business 404, last owner 409, staff leaves, no emails in logs, 5-business limit), runtime 2, testing 1.
    - Mutation checks, each caught: no `REVOKE` on `audit_log` → 5 failures; no `FORCE` on `usage_meters` → catalog test fails; no membership lock in the services → 9 of 10 concurrency rounds fail.
    - Self-review found that an own id in capitals was not treated as leaving; fixed with tests first (ids lowercased in contracts).
    - Docker images built (api 462 MB, worker 461 MB, web 322 MB; local builds need the sandbox CA, scratch Dockerfile not committed). `docker compose up --wait`: 6 services healthy, `migrate` exited 0. Playwright 18/18, four runs (three before the id fix, one after). api logs: no errors, no emails; e2e owners' `tenant.created` entries present.
  - **Not yet proven:** CI on the PR (opened at the user's request after accepting ADR-0013).
  - **Findings:**
    - With RLS on, an insert without a tenant fails the policy's WITH CHECK (42501) before the NOT NULL constraint.
    - The worker image now carries `@pepper/db` through `@pepper/core` (it already had it for readiness).
    - AC-W9-1 also asks for RLS-level enforcement: the staff-scoped policy belongs on the bookings and notes tables (Phase 3).

- **S9 Phase 2c, part 2 (2026-10-17):** invites, Team screen, security review, Phase 2 exit ([ADR-0014](../adr/0014-invites.md), accepted by the user).
  - **contracts:** invite schemas (`InviteToken`: 43 base64url characters; `InviteEmail` trimmed and lowercased; create/list/lookup/accept bodies), audit actions `invite.created`/`invite.revoked`/`invite.accepted` (no emails), error codes `invite_invalid`, `invite_wrong_account`, `invite_not_found`, `invite_limit_reached`, `already_a_member`; `GET /v1/tenant` returns `permissions`.
  - **db:** `invites` table (forced RLS, `tenant_isolation`, read-only token-keyed `invite_lookup` policy via `current_invite_token_hash()`; SHA-256 token hash; one unresolved invite per email; accepted xor revoked); repositories and `withInviteTenant` (finds the invite by hash with no tenant, then binds the transaction to its business); `isMemberEmail`. Migrations 0008–0010.
  - **core:** `createInvite` (7-day link, at most 20 open per business, re-inviting replaces the old link), `listInvites`, `revokeInvite`, `previewInvite`, `acceptInvite` (email-bound, single use, locked); `canGrantRole` (only owners invite owners), `permissionsOf`, `newInviteToken`/`hashInviteToken`.
  - **api:** `GET/POST /v1/invites`, `DELETE /v1/invites/:inviteId` (owners and managers), `POST /v1/invites/lookup` and `/accept` (signed in; accepting switches the session to the business). `permissions` in `GET /v1/tenant` (the brief said `/v1/me`; `/v1/tenant` is where the role is known).
  - **web:** `/invite` (token from the link's fragment, kept in `sessionStorage`, `?next=/invite` through sign-up/sign-in, allowlisted by `safeNext`), `/team` (members, role change, remove with confirmation, invite link with copy, open invites with cancel, leave; staff see only "Leave"; dates in the business's time zone), "Team" link on home.
  - **Checks run:**
    - `pnpm check` green. Unit tests: contracts 144, core 423, db 33, runtime 75, testing 13, api 113, web 82, worker 3. Coverage: contracts, core, db 100%; api 95.7%; web 98.6%.
    - `pnpm test:integration` green: db 141 (isolation suite incl. `invites` and the invite lookup: a hash shows only its row, no other table, cannot write, does not widen a tenant transaction, ends with the transaction; invite repository), core 57 (24 invite tests: expired at 7 days, reused, revoked, wrong account, email case, escalation per role, stale actor role, other business, already a member, limit 20, replacement, 5 rounds of 3 concurrent accepts), api 38 (manager invite → sign-up → accept → MFA, forwarded link, revoke, escalation, other business, no tokens or invitee emails in logs), runtime 2, testing 1.
    - Mutation checks, each caught: no email check → 1 failure; managers may grant owner → 1 unit + 3 integration failures; `invite_lookup` without `current_tenant_id() IS NULL` → 2 isolation failures; no `FORCE` on `invites` → catalog test fails.
    - Docker images built (sandbox CA via a scratch Dockerfile, not committed). `docker compose up --wait`: 6 services healthy, `migrate` exited 0. Playwright 26/26 (8 new team tests on phone and desktop: invite → sign up → join → MFA → role change → remove; forwarded link refused; sign in → join as staff → leave; no sideways overflow), three runs in a row. api logs: no errors, no emails, no invite tokens.
    - `/security-review` of the branch: no findings at or above the reporting bar. Two design notes are recorded in ADR-0014 (an invite outlives its creator's demotion; "wrong account" vs "invalid" is distinguishable to a token holder).
  - **Phase 2 exit check:** cross-tenant suite 100% (`isolation.int.test.ts`, every table classified, incl. `invites`); role matrix 100% (`permissions.test.ts` every role × permission cell, `membership-rules.test.ts` incl. `canGrantRole`); auth E2E (`e2e/tests/auth.spec.ts` + `team.spec.ts`). **Met.**
  - **Not yet proven:** CI on the S9 PR (not opened yet).
  - **Findings:**
    - A `<label>` wrapping a `<select>` includes the option texts in its name, so tests find the role field as a combobox.
    - Until email verification (Phase 5), email binding checks the address someone signed up with, not one they proved (ADR-0014 Consequences).

- **S10 Phase 3a (2026-10-17):** appointments base data ([ADR-0015](../adr/0015-appointments-base-data.md), accepted by the user).
  - **contracts:**
    - Schemas for services (price "from", optional "to", in cents), staff members (optional login link, service ids), weekly hours (`HH:MM` local time, ISO weekday, no overlaps, sorted) and time off (UTC span ≤ 366 days, no reason).
    - Permissions `staff.read`, `staff.manage`, `hours.manage`, `time_off.manage`.
    - Seven audit actions (no staff names).
    - Five error codes.
  - **db:**
    - Tables `services`, `staff_members`, `staff_services`, `working_hours`, `time_off`: forced RLS, composite `(tenant_id, id)` foreign keys, check constraints mirroring the contracts.
    - Case-insensitive unique service names, one staff member per membership (unlinked when the member is removed), and an exclusion constraint against overlapping hours (`btree_gist`).
    - Repositories. Migrations 0011–0012.
  - **modules/appointments** (new `@pepper/appointments`, L2): `listServices`/`createService`/`updateService`, `listStaff`/`createStaffMember`/`updateStaffMember`, `getWorkingHours`/`replaceWorkingHours` (locked, whole week), `listTimeOff`/`addTimeOff`/`removeTimeOff` (staff: own linked staff member only). Audit entries are written in the same transaction; an unchanged save is not audited.
  - **api:** `GET/POST /v1/services`, `PUT /v1/services/:id`; `GET/POST /v1/staff`, `PUT /v1/staff/:id`; `GET/PUT /v1/staff/:id/hours`; `GET/POST /v1/staff/:id/time-off`, `DELETE …/time-off/:timeOffId`.
  - **Checks run:**
    - `pnpm check` green. Unit tests: contracts 208, core 483, db 33, appointments 11, runtime 75, testing 13, api 145, web 82, worker 3. Coverage: contracts 100% lines; appointments 100%; core 100%; api 96.6%; db 93.8% lines.
    - `pnpm test:integration` green, 339 tests:
      - **db 210:** the isolation suite now covers the 5 new tables. The new repository tests show that every reference to another business's service, staff member or membership fails with `23503`, plus case-insensitive names, link uniqueness, unlink on member removal, the overlap exclusion, check constraints and cascades.
      - **appointments 26:** permissions per role, a staff member's own time off only, unlinked or removed logins, other businesses' ids, audit entries, no audit for unchanged saves, concurrent week edits serialised.
      - **api 43:** owner sets up a service, staff and hours; staff reads them and manages only their own time off; another business finds nothing (404s); audit log without staff names.
      - core 57, runtime 2, testing 1 (unchanged).
    - Docker images rebuilt (sandbox CA via a scratch Dockerfile, not committed). `docker compose up --wait`: all services healthy, `migrate` exited 0 (incl. `btree_gist`). Playwright 26/26.
  - **CI on PR #12:** all three required checks green (after the e2e fix below). Merged into `main` by Claude at the user's request (2026-10-17).
  - **CI fix:** the S9 team e2e test reloaded the page before the role change had saved (a race CI hit once). It now waits for the save; 3 local runs of the full e2e suite, 26/26 each.
  - **Findings:** a foreign key check bypasses RLS, so a single-column reference could link to another business's row by id. Composite keys are now the rule for tenant references (ADR-0015, dev-setup, security doc).

- **S11 Phase 3b (2026-10-17):** booking rules and the availability engine ([ADR-0016](../adr/0016-booking-rules-and-availability.md), accepted by the user).
  - **contracts:**
    - `RuleSchema`: five versioned rule types (`slot_interval` 5/10/15/20/30/60, `minimum_notice`, `maximum_advance`, `max_bookings_per_day`, `blackout_window` as local dates, both ends included), each for the business or one staff member.
    - `BookingRulesSchema`: the whole set, sorted, one per type and scope except blackouts.
    - `PLATFORM_RULE_DEFAULTS` (15 min / 2 h / 90 days / no cap).
    - Permissions `rules.read` (everyone) and `rules.manage` (owners, managers).
    - Audit action `booking_rules.replaced`.
  - **db:**
    - `booking_rules` table: forced RLS, composite staff key, checks on type, version and object params, and a partial unique index `NULLS NOT DISTINCT`.
    - Repositories `listBookingRules`, `lockBookingRules` (advisory lock), `replaceBookingRules`, `findStaffMemberIds`.
    - Migrations 0013–0014.
  - **modules/appointments:**
    - `zoned-time.ts`: local time ↔ UTC with `Intl`. A skipped time maps to the moment of the change, so the conversion is monotonic; a repeated time maps to the earlier instant.
    - `resolveRules` (staff → business → template → platform).
    - The pure `availableSlots` engine.
    - `getBookingRules`/`replaceBookingRules` services (locked, audited, staff members must be the business's own).
    - fast-check is a new dev dependency.
  - **api:** `GET /v1/rules` (everyone) and `PUT /v1/rules` (owners and managers; 404 `staff_member_not_found` for a rule naming another business's or an unknown staff member).
  - **Checks run:**
    - `pnpm check` green. Unit tests: contracts 241, core 513, db 33, appointments 58, runtime 75, testing 13, api 154, web 82, worker 3. Coverage: contracts 100% lines; core 100%; appointments 100% lines / 94.1% branches; api 96.7%; db 93.2% lines.
    - Property tests, 10,000 cases each, across seven US time zones (incl. Phoenix and Honolulu), clustered around DST changes:
      - every offered slot passes an independent checker (hours, grid, range, notice, advance, time off, outside busy time, buffers on both sides, blackouts, daily cap);
      - a brute-force enumeration finds no missing slot;
      - the output does not depend on input order;
      - `zoned-time` round-trip, gap and monotonicity properties.
    - Mutation checks, each caught by the properties: buffer before dropped; off-grid starts; blackout ignored; daily cap off by one; maximum advance inclusive (caught only after `now` was made to fall on 5-minute marks); minimum notice exclusive. Dropping `FORCE` on `booking_rules` fails the isolation catalog test.
    - `pnpm test:integration` green, 363 tests:
      - **db 226:** the isolation suite incl. `booking_rules`, a rule for another business's staff member (`23503`), cascade on staff deletion, the unique index, check constraints, and the advisory lock (waits within a business, not across businesses).
      - **appointments 33:** 7 new tests covering permissions, ZodError before the database, other businesses' staff, isolation, audit before/after, and concurrent replaces that chain exactly.
      - **api 44:** Ana sets rules; Cara reads but gets 403 on changes; validation 400; Dev probes with Ana's staff member and gets 404, and sees no rules; `booking_rules.replaced` in the audit log.
      - core 57, runtime 2, testing 1.
  - **Not run this session:** Docker image builds, `docker compose up`, and Playwright (no UI change; the migrations are applied by `migrate.int.test.ts` and every integration suite). CI's E2E smoke will run Compose.
  - **CI on PR #14:** all three required checks green on the first run (Lint/typecheck/test/build, Integration, E2E smoke incl. Compose with migrations 0013–0014). PR opened at the user's request after accepting ADR-0016; waiting for the user to merge.
  - **Findings:**
    - Temporal's "compatible" handling of skipped times is not monotonic: 02:01 → 03:01 lands after 03:00 → 03:00. With it, hours of 01:00–02:50 and 03:00–04:00 would overlap in real time on spring-forward night. Skipped times now map to the moment of the change (ADR-0016 §9).
    - The engine lets buffers reach outside working hours, and checks the occupied range (with buffers) against other bookings' occupied ranges. S12's exclusion constraint should use the same occupied range.
    - Unit tests run against the built `dist/` of their dependencies (turbo `^build`), so run `pnpm --filter <dep> build` after changing contracts before running a dependent package's tests on their own.

- **S12 Phase 3c (2026-10-17):** clients, bookings, busy times and the waitlist, with staff-scoped RLS ([ADR-0017](../adr/0017-bookings-clients-and-waitlist.md), accepted by the user).
  - **contracts:** client, booking (statuses `confirmed`/`completed`/`no_show`/`cancelled`, sources `team`/`ai`/`booking_page`, idempotency key, range queries ≤ 62 days, busy times, availability, the `slot_unavailable` body with alternatives) and waitlist schemas (1–10 local windows); audit actions `client.created`, `booking.created/updated`, `waitlist_entry.created/updated` (ids, times, statuses only); ten error codes.
  - **db:**
    - Tables `clients`, `bookings`, `booking_occupancy` (kept by a trigger; `occupied tstzrange` = appointment + buffers) and `waitlist_entries`: forced RLS, composite tenant keys, checks.
    - **Exclusion constraint** `booking_occupancy_no_overlap` on `(staff_member_id, occupied)`.
    - **Member scope:** `withMember` binds tenant and user; `current_member_sees_all()` / `current_member_staff_ids()`; restrictive `member_scope*` policies (staff: own staff member's bookings and waitlist entries; read-only clients of those; everyone reads busy times).
    - Migrations 0015–0017.
  - **core:** `listClients`/`getClient`/`createClient`, `ClientNotFoundError`.
  - **modules/appointments:**
    - `createBooking` (engine check under a staff lock; owner/manager override; 3 nearest alternatives; idempotency keys).
    - `changeBooking` (move with staff locked in id order, or status).
    - `getBooking`/`listBookings`/`listBusyTimes`/`findAvailability`.
    - `addToWaitlist`/`listWaitlist`/`changeWaitlistEntry`.
    - Pure helpers in `bookings/planning.ts`.
    - Services also apply the own-staff scope on reads (defence in depth).
  - **api:** `GET/POST /v1/clients`, `GET /v1/clients/:id`; `GET/POST /v1/bookings`, `GET/PATCH /v1/bookings/:id`; `GET /v1/calendar/busy`; `GET /v1/availability`; `GET/POST /v1/waitlist`, `PATCH /v1/waitlist/:id`. Domain errors mapped from one table.
  - **Checks run:**
    - `pnpm check` green (format, lint, typecheck, unit tests with coverage, build). Coverage: contracts 100% lines; core 100%; appointments 100% lines / 94.7% branches; api 97.6%; db 90.2%.
    - Integration: db (isolation suite with the four new tables and their exact policies; `bookings.int` 41 tests: constraint incl. 8 concurrent attempts, trigger, references, checks, idempotency keys, member scope per role); appointments 64 (services per role, AC-W2-1 alternatives, idempotency incl. concurrent first attempts, two fast-check properties against real Postgres: no double booking under concurrent bookings and overrides, daily cap never exceeded); api 51 (journeys for AC-W9-1, AC-W2-1, waitlist, other business, no client data in audit log or logs).
    - Mutation checks: bookings `member_scope` → `true` fails 6 db tests; with RLS off the services still refuse (only the RLS-only clients scope test fails); replacing the staff lock with a plain read fails the daily-cap property.
    - Not run: Docker image builds, Compose, Playwright (no UI change); CI's E2E smoke runs Compose with migrations 0015–0017.
  - **Findings:**
    - `= ANY ((SELECT array_fn()))` in a policy is parsed as a subquery (uuid = uuid[]); the policies use `IN (SELECT setof_fn())`.
    - The idempotency lookup must come after the staff lock, or concurrent first attempts with one key get "time taken" instead of the first booking (caught by a test).
    - Staff can book only clients they already have (a booking or waitlist entry with them): see "Waiting on the user".

- **S13 Phase 3d (2026-10-18):** industry templates and the Phase 3 exit ([ADR-0018](../adr/0018-industry-templates.md), accepted by the user).
  - **contracts:**
    - `TemplateSchema` (terminology, modules, service catalog with typical US prices and rebooking intervals, rule defaults, autonomy defaults, intake fields with `sensitive`, insights, prompt fragments, onboarding hints).
    - `TemplateIdSchema` (8 ids, in `tenancy.ts`).
    - `templateId` on `NewTenantSchema` (optional, `null` default), `BusinessSchema` and `tenant.created`.
    - The autonomy dial as a contract: `AutonomyActionSchema`, `AUTONOMY_ACTIONS` (risk tier, approved default, `allowsAuto`: never for bulk), `AutonomySettingsSchema`.
  - **templates (new `@pepper/templates`):** `beauty-salon`, `barber`, `nails`, `spa`, `lash-brow`, `personal-trainer`, `massage`, `yoga-pilates-private`; parsed at load and frozen; `getTemplate`, `listTemplates`, `templateSummaries`, `templateRuleDefaults`. Workspace glob is now `packages/templates`; lint lets only apps import it.
  - **db:** `tenants.template_id` (nullable, shape check), migration 0018.
  - **appointments:** `findAvailability`/`createBooking`/`changeBooking` take an optional `templateRuleDefaults` lookup (L2 does not import L3); the api passes the real one.
  - **api:** `POST /v1/tenants` takes `templateId` (unknown: 400), `GET /v1/tenant` returns it, `GET /v1/templates` (signed in, no business needed).
  - **Phase 3 exit security review** (`/security-review` scope, S10–S13, `1e7dbd4..HEAD`, three reviewers: db/RLS, domain services, api/contracts). No high-severity findings. Fixed:
    - **Medium:** client names and non-US phone numbers could reach logs and Sentry through drizzle's failed-query message (`params: …`) and Postgres's `detail`. The redacting logger now drops both and redacts any E.164 number (tests first).
    - **Medium (defence in depth):** inside `withMember`, staff could have re-linked a staff member or raised their own role at the database level, widening their RLS scope if a service check were ever missed. Restrictive write policies on `staff_members` and `memberships` (migration 0019), with an escalation test and the isolation catalog updated.
    - Not fixed, recorded for later phases (all need a service bug first, or are inside one business):
      - `booking_occupancy` can be written directly by the services' role (only the trigger should): harden with a definer-owned trigger or a consistency check (Phase 11 hardening).
      - Foreign key checks ignore RLS, so staff could reference a client they cannot see if a service skipped its `findClient` check (services check today).
      - Work without a user gets full scope (`current_user_id() IS NULL`); a missing `withMember` would widen access. Consider an explicit system marker (Phase 5, when jobs arrive).
      - `GET /v1/availability`, `/v1/bookings` and `/v1/calendar/busy` have no response cap: a 62-day, all-staff query can build a very large answer. Cap or paginate with the Phase 4 calendar screens.
      - Idempotency keys are unique per business, so a staff member can learn that a colleague used a key (no data). Scope per user if the AI derives keys from client data (Phase 6).
      - Owner/manager overrides may book in the past (flagged `overridden`).
      - A stored template id unknown to the contracts makes availability fail loudly for that business (by design, ADR-0018 §Consequences).
      - Older helper functions (`current_tenant_id()`, `current_user_id()`, `set_updated_at()`) have no fixed `search_path` (negligible: invoker, no CREATE on public).
  - **Checks run:**
    - `pnpm check` green. Unit tests: contracts 355, templates 96, core 514, db 38, appointments 84, runtime 79, testing 13, api 194, web 82, worker 3. Coverage: contracts 100% lines; templates 100% lines; core 100%; appointments 100% lines / 94.7% branches; api 97.6%; db 90.2%.
    - `pnpm test:integration` green, 488 tests: db 302 (incl. template column and check, the staff escalation test, isolation catalog with the new policies), appointments 69 (incl. 5 on template defaults: grid, notice, business rule wins, booking and move refused off the grid, no template), core 58, api 56 (incl. the templates journey on the real personal-trainer template), runtime 2, testing 1.
    - Phase 3 exit criteria: 10k-case property tests (S11) and the concurrency properties (S12) green; coverage ≥ 80% on core and modules; template schema tests for all eight; no open high-severity findings.
    - Not run: Docker image builds, Compose and Playwright (no UI change; the web fixture now carries `templateId`). CI's E2E smoke runs Compose with migrations 0018–0019.
  - **Findings:** I first assumed barbers book on a 30-minute grid; the barber template uses 15. The api journey now uses the personal-trainer template (30). Drizzle 0.45 puts bound values in error messages, so any future logging of database errors must go through `redact`.

- **S14 Phase 4a (2026-10-18):** design system, app shell, calendar day view ([ADR-0019](../adr/0019-design-system-and-app-shell.md), proposed). The user asked Claude to go ahead after the Session Brief without waiting, so the decisions below are Claude's recommendations, to review in the PR.
  - **ui (new `@pepper/ui`):**
    - `tokens.ts` holds the approved tokens (light/dark, radii, tap target, 960 px) and `contrastRatio`.
    - `theme.css` is the Tailwind v4 theme (CSS variables, `desk:` breakpoint, fonts, radii).
    - Components: `Logo`/`Mark`, `Icon`, `Card`, `buttonClass`/`chipClass`.
    - Tests: theme equals tokens; every text pair reaches AA in both themes.
  - **web:**
    - Tailwind v4 (CSS-first) and self-hosted Figtree and Bricolage Grotesque (Fontsource). The Phase 2 stylesheet now sits in `@layer base`, and its card layout applies only outside the shell.
    - Route group `app/(app)` with the shell: bottom tabs on phones, sidebar from 960 px; Home, Calendar (with `calendar.read`), Team. Account and business are loaded once per request (`cache`).
    - **Calendar day view** (`/calendar?date=&staff=`, read-only): one column per active staff member on the business's clock (wall-clock positions, clock-change days, midnight clipping), day navigation, staff filter chips and a now-line. Owners and managers see bookings in full (client, service, time, done/no-show, "outside the usual hours"); staff see their own in full and colleagues' as busy. Client names come from one `GET /v1/clients/:id` per client of the day (at most 60). Notices appear when an answer is cut or fails.
  - **contracts:** the time-zone helpers moved here from appointments (re-exported there, so the engine is unchanged). `MAX_LIST_ITEMS = 500` and `truncated` on the bookings, busy-time and availability responses.
  - **db / appointments / api:** an optional `limit` on `listBookings`/`listOccupancy`, the services and `findAvailability`. The api asks for 501 and answers at most 500 with `truncated` (closes the S13 finding on response size).
  - **Checks run:**
    - `pnpm check` green. Unit tests: contracts 374 (+19 time-zone tests moved from appointments), ui 58, templates 96, core 514, db 38, appointments 65, runtime 79, testing 13, api 196, web 116, worker 3. Coverage: ui 100% lines; web 100% lines; contracts 100%; api 97.7%; db 90.2%.
    - `pnpm test:integration` green, 490 tests: db 303 (incl. the `limit` on occupancy and bookings), appointments 70 (incl. limits on bookings, busy times and availability), core 58, api 56, runtime 2, testing 1. The first run found one api test still expecting the old response shape (no `truncated`); its expectation was updated.
    - Playwright: all 28 green (phone and desktop), incl. the new calendar journey. They ran against api, worker and web started with `pnpm` on the Compose Postgres, Redis and Mailpit, because `docker build` cannot reach npm through this sandbox's proxy (as in earlier sessions). The dev-setup doc now describes this way.
    - Visual check: screenshots of the calendar (phone and desktop, light and dark) and the team page.
  - **Not done / for later:**
    - Docker image builds and Compose: not run here; CI runs them.
    - A staff-member Playwright journey (busy blocks): covered by unit tests and the api's AC-W9-1 tests; add it with the S15 booking screens, which need the invite flow anyway.
    - A batch client lookup: wait for S16.

- **S14 follow-up: rename + theme (2026-10-18/19, [PCR-002](changes/PCR-002.md), approved by the user):**
  - **Rename Floty → Pepper everywhere:** wordmark and page titles, docs, the mockup (`docs/mockups/pepper-prototype.html`), package scope `@pepper/*`, database roles `pepper_app` / `pepper_service` and the `pepper` dev database (migrations 0000 and 0007 edited in place), the migration advisory lock key ("pepper" in ASCII), cookie prefix `pepper.*`, 2-step login issuer `Pepper`, telemetry service names, Docker image and Compose project names, the `pepper.app/<business>` hint (display only, domain not registered).
  - **Theme "A. Pepper green + chili accent":** pepper-green brand and green-leaning neutrals; new `accent` / `accent-soft` / `on-accent` (chili) for the mark and Pepper's own voice, never for status; "done" is teal, `danger` a deeper crimson; staff tints green / coral / amber; sample business color plum. New mark: chili speech bubble with a face and a green stem (ui `Logo`, favicon, mockup). Default staff color is now the brand green `#2a7230`.
  - **Checks run:**
    - Baseline before the change: `pnpm check` and `pnpm test:integration` (490) green. Docker had stopped in the sandbox and was restarted first.
    - After: `pnpm check` green (ui 68 tests, +10 for the accent pairs; every other count unchanged). `pnpm test:integration` green, 490. Playwright 28/28 against api, worker and web on the renamed Compose infra. Mockup: contrast check all AA (now with `accent`), click-through 260/260 in 4 viewport/theme combos. `docker compose config` valid. Screenshots of the mockup and the sign-in page in light and dark.
    - "Floty" now appears only in the notes that record the rename (STATUS, PCR-002, CHANGELOG, the rebuild note in `dev-setup.md`).
  - **For you:** rebuild your local dev database once (`docker compose down --volumes`, then start as usual) and copy the new database names from `.env.example` into your `.env`. The old preview link of the mockup shows the old look until it is republished.

- **S15 Phase 4b (2026-10-19):** booking screens, staff client lookup, outcomes rule (b) ([ADR-0020](../adr/0020-booking-screens-and-client-lookup.md), accepted by the user on 2026-10-19). The user said "give me the Session Brief, then continue", so Claude went ahead on its recommendations, to be reviewed in the PR.
  - **Outcomes rule (b):** `canChangeStatus(from, to, correctsOutcomes)` in contracts; `changeBooking` makes `completed`/`no_show` final for staff (`409 booking_not_changeable`); owners and managers may still correct them.
  - **Staff find a client by exact email or phone** (the user's 2026-10-17 decision):
    - **db:** migration 0020, `current_client_contact()` reads the transaction-local `app.client_contact`; the clients `member_scope` USING also matches `email`/`phone` equal to it, read-only. `setTransactionClientContact` and `findClientsByContact` (at most 10).
    - **contracts:** `ClientContactSchema` (email lowercased or E.164 phone, branded), `ClientLookupSchema`; optional `clientContact` on `BookingInputSchema` and `WaitlistEntryInputSchema`.
    - **core / appointments / api:** `lookUpClients`, `findClientToBook` (sets the contact before finding the client); `POST /v1/clients/lookup` (200 `{ clients }`, a POST to keep contacts out of URLs).
  - **web:**
    - Radix Dialog (`@radix-ui/react-dialog` 1.1.23, months old; the 1.2/1.3 releases were under two weeks old).
    - `lib/booking.ts` (pure helpers) and `fetchJson`; failures keep the api body (409 alternatives); booking error messages.
    - Calendar header **New booking**: client picker (owners/managers search or add; staff exact email or phone, US numbers typed locally become E.164), service, staff (staff: only their own), day with free times from `/v1/availability` or another time; idempotency key per opening; a refused time shows the 3 nearest times and **Add to the waitlist** (suggested window: the wanted day, 2 hours from the wanted time, editable).
    - Booking blocks open a **booking sheet**: details, Mark done / No-show once started, Move (same picker; owners/managers may change staff), Cancel with confirmation; a refused move shows alternatives.
    - `ui`: `close` and `plus` icons.
  - **e2e:** `booking.spec.ts`, owner and staff journeys; `anotherPerson` and `callApi` moved to `helpers.ts`.
  - **Checks run:**
    - `pnpm check` green. Unit tests: contracts 383, ui 68, templates 96, core 514, db 38, appointments 65, runtime 79, testing 13, api 200, web 142, worker 3. Coverage: web 100% lines; contracts 100%; core 100%; appointments 100% lines; api 97.7%; db 88.9%.
    - `pnpm test:integration` green, 495 tests: db 304 (isolation catalog with the new policy; "ADR-0020: an exact email or phone…"), appointments 74 (rule b for staff; lookup, booking and waitlist with the contact), core 58, api 56, runtime 2, testing 1.
    - Playwright: all 32 green (phone and desktop), incl. the two new journeys, against api, worker and web started with `pnpm` on the Compose Postgres, Redis and Mailpit (as in S14). The staff journey first failed in the test itself (it opened the invite while sign-up was still redirecting); it now follows the team spec's invite flow.
    - Visual check: screenshots of the new-booking sheet, a refused time with the waitlist form, and the booking sheet, on phone and desktop, light and dark.
  - **Not done / for later:**
    - Docker image builds and Compose: not run here (as in S14); CI runs them.
    - Rate limiting or auditing of client lookups (ADR-0020 §Consequences; Phase 11 hardening).
    - The free times shown for a move exclude the booking's own time ("another time" covers it).
    - Booking a client to "anyone" (no staff member chosen) and the owner/manager override in the UI: not built; the api supports both.

- **S16 Phase 4c (2026-10-19):** setup screens: services, booking rules, team with staff pages, clients ([ADR-0021](../adr/0021-setup-screens.md), accepted by the user on 2026-10-19). The user said "give me the Session Brief, then continue", so Claude went ahead on its recommendations, to be reviewed in the PR.
  - **api (additive):**
    - `PUT /v1/clients/:clientId` (owners and managers; 404/409). Audit `client.updated` holds only which fields changed; no-op edits write nothing.
    - `clientId` filter on `GET /v1/bookings` (62-day range and staff scope kept).
    - `defaults` on `GET/PUT /v1/rules`: the template's defaults, else the platform's (`getRuleDefaults` in appointments).
    - Contracts: one full `RuleDefaultsSchema` in `rules.ts`; the template one is now `TemplateRuleDefaultsSchema` (= `.partial()`).
  - **web:**
    - Nav: Home · Calendar · Clients · Services · Team (by read permission).
    - `/services`: menu by category, add/edit sheet, prices in dollars ↔ cents, "not bookable" instead of delete.
    - `/services/rules`: grid, notice, ahead, daily limit per person, closed days. Each can stay on "Default (…)", showing the value in force. Staff members' own rules are kept untouched.
    - `/team`: staff cards with hours summary and services; **Add staff member** sheet, which then opens the member's page. "People with access" is the Phase 2 team manager restyled on the design system, with the same behaviour and names.
    - `/team/:id`:
      - Details (colour swatches, login link, services, bookable).
      - Weekly hours editor (days off, several spans a day, 15-minute selects up to midnight, "Use Monday's hours Monday to Friday", checked before sending).
      - Time off (whole days or part of a day, business clock → UTC). Staff manage only their own.
    - `/clients`: search from the browser (not in the URL), add client.
    - `/clients/:id`: contact, coming and recent visits (±62 days), Edit details, **Book**, which opens the S15 sheet with the client chosen.
    - `lib/setup.ts` holds the pure helpers. `STATUS_LABELS` moved to `lib/booking.ts`. Unused Phase 2 list CSS removed. `ui`: `clients`, `services`, `search` icons.
  - **e2e:** `setup.spec.ts`:
    - The Phase 4 **"setup" journey**: a new owner adds a service, a staff member with every-day hours and a 30-minute rule without the api, then books 9:30 from the offered 9:00/9:30.
    - A clients journey: search, profile, edit phone, book from the profile.
    - A staff journey: own time off blocks availability; hours, rules and the menu are read-only; no colleague time off; no clients yet.
  - **Checks run:**
    - **Environment (this session ran on the user's Windows machine, not a cloud sandbox):** a portable Node 22.23.3 (checksum verified) and pnpm 10.28.0 via Corepack in the session scratchpad, so nothing was installed system-wide. Docker Desktop was started. E2E infra ran as a separate Compose project `pepper-s16-e2e` (with the user's `docker-compose.local.yml` ports 5434/6380), so the user's own dev data was not touched.
    - `pnpm check` green. Unit tests: contracts 393, ui 68, templates 96, core 514, db 38, appointments 65, runtime 79, testing 13, api 205, web 189 (+47: `setup.test.ts`, nav), worker 3. Coverage: web 100% lines; contracts 100%; core 100%; appointments 100% lines; api 97.7%; db 88.9%.
    - `pnpm test:integration`: **498 of 500 green**: db 305/306, appointments 77 (+3), core 58, api 55/56, runtime 2, testing 1. The isolation catalog is unchanged and green.
    - The **two failures are Windows-only and in tests this session did not touch**:
      - (1) db `migrate.int.test.ts` "matches the Drizzle schema" spawns `node_modules/.bin/drizzle-kit`, which on Windows needs `.cmd` (`spawn … ENOENT`).
      - (2) api `main.int.test.ts` "flushes spans on SIGTERM": on Windows `kill('SIGTERM')` ends the process at once, so nothing is flushed.
      - CI (Linux) runs both. Fix them in a maintenance session (spawn with `shell` on win32 or via `pnpm exec`; skip or adapt the signal test on win32).
    - Playwright: **38/38 green** (the 32 earlier plus 6 new, phone and desktop) against api, worker and web started with `node`/`pnpm` on the Compose infra, with `--workers=2`. With the default worker count (8 on this 16-thread machine), three sign-ups timed out at 5 s (password hashing under load), the same tests that pass with fewer workers. `dev-setup.md` now notes this.
    - Visual check: screenshots of services, the service sheet, rules, team, staff page, clients and client profile, on phone and desktop, light and dark. The hours rows were tightened after the first look (✕ instead of a wrapped "Remove"), and the time-off date fields were aligned.
  - **Not done / for later:**
    - Docker image builds and the Compose E2E job: not run here; CI runs them.
    - Per-staff rules on the rules screen (the api supports them; the screen keeps them).
    - Client visits beyond ±62 days (needs a paged endpoint; Phase 7 with client memory).
    - A batch hours endpoint for the Team list (one request per staff member, at most 40).
    - The client profile shows "not found" also when the api fails (it cannot tell the two apart from the loader's `null`).

- **S17 Phase 4d (2026-10-20):** public booking page with email verification ([ADR-0022](../adr/0022-public-booking-page.md), accepted by the user on 2026-10-20). The user said "Read CLAUDE.md and docs/plan/STATUS.md, give me the Session Brief, then continue", so Claude went ahead on its recommendations, to be reviewed.
  - **db:**
    - Migrations 0021–0023: `current_public_slug()` and the read-only `public_lookup` policy on `tenants`, plus `withPublicTenant`.
    - `tenants.brand_color`.
    - The `booking_verifications` table (HMAC code hash, attempts, expiry; restrictive `member_scope` so no member reaches it).
    - `bookings.manage_token_hash` (unique). Isolation suite extended.
  - **contracts:**
    - `BrandColorSchema` and `BookingPageSettingsSchema`.
    - Audit action `tenant.updated`.
    - `public-booking.ts`: the page, the request, confirm with an optional `startsAt`, the link token, `WrongCodeSchema`.
    - New api error codes.
  - **core:** `updateBookingPage` (`settings.manage`, audited).
  - **appointments:**
    - `getPublicBusiness`, `findPublicAvailability`.
    - `requestBooking` (5 per email per hour).
    - `confirmBookingRequest` (5 attempts, 10 minutes; reuses a client by the verified email; anyone → the first free staff member under lock).
    - `getManagedBooking` / `rescheduleManagedBooking` / `cancelManagedBooking`.
    - `nearestAlternatives` is shared with team bookings (one time per start for anyone).
  - **api:**
    - `/v1/public/businesses/:slug` (page, availability, booking-requests, confirm, booking/lookup|reschedule|cancel) with no session; writes still need the app's Origin.
    - `PUT /v1/tenant/booking-page`.
    - `Mailer` port with an SMTP adapter (nodemailer 10.0.15, the one new dependency). `SMTP_URL`/`MAIL_FROM` in config; Compose points at Mailpit.
    - Redis fixed-window rate limits per address and per business, fail closed.
    - HKDF code key from `AUTH_SECRET`. `REDIS` is exported from runtime.
  - **ui:** `brandTokens`/`brandStyle` (any color → AA in both themes; property test), `.bookpage` in `theme.css`, `check` icon, `Card labelledBy`.
  - **web:**
    - `/book/<slug>` (service → staff or anyone → day strip + free times → details → code → booked; a taken time offers alternatives booked with the same code).
    - `/book/<slug>/manage#<token>` (view, reschedule, cancel).
    - A "Your booking page" card on Services (link; color for owners and managers).
    - The server page load passes the visitor's `X-Forwarded-For`.
  - **e2e:** `public-booking.spec.ts`. The journey reads the code and the link from Mailpit, checks the business color on the button, a wrong code, nothing booked before the code, then reschedule and cancel. Also an unknown page and a broken link.
  - **Checks run:**
    - `pnpm check` green. Unit tests: contracts 425, ui 79, templates 96, core 514, db 38, appointments 72, runtime 79, testing 13, api 246, web 207, worker 3. Coverage: core 100%, contracts 100% lines, appointments 100% lines, web 100% lines, api 96.8%, ui 98.2%, db 88.4%.
    - `pnpm test:integration` green, **555**: db 330 (incl. the public lookup and booking-request isolation), appointments 102 (incl. AC-W8-1 two confirmations of the last slot, one wins), core 60, api 60 (incl. the full AC-W8-2 flow against real Postgres and Redis), runtime 2, testing 1. One api assertion was flaky (a six-digit run inside a random UUID) and was fixed.
    - Playwright: **42/42 green** (phone and desktop) against api, worker and web started with `node`/`next start` on a separate Compose project (`pepper-s17`: Postgres, Redis, Mailpit), `--workers=2`, using `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`.
    - Visual check: screenshots of every step on phone and desktop, light and dark, in the sample plum.
  - **Not done / for later:**
    - Docker image builds and the Compose E2E job were not run here; CI runs them, now with `SMTP_URL` to Mailpit.
    - Cleanup of expired booking requests (a Phase 5 job).
    - Sending through the outbox with retries (Phase 5).
    - Turnstile and the edge proxy that makes per-address limits trustworthy (Phase 11).
    - Address, notes, "add to calendar", a cancellation policy, and staff photos on the page.
    - Confirmation emails for team-made bookings (Phase 5).
    - The concurrent last slot in Playwright (S18).

- **S18 Phase 4e (2026-10-20): Phase 4 exit** ([ADR-0023](../adr/0023-pwa-offline-and-phase-4-exit.md), accepted). At the Session Brief the user chose all three of Claude's recommendations and asked Claude to finish, open the PR and merge it.
  - **AC-W8-1 in Playwright** (`e2e/tests/public-booking.spec.ts`): Jess works one hour a day, two clients on separate browsers confirm the same last time at once; exactly one is booked, the other gets the nearest times and books one with the same code; two bookings at different times.
  - **PWA:**
    - `public/manifest.webmanifest` with 192/512/maskable/apple-touch icons rendered once from `app/icon.svg`.
    - A hand-written `public/sw.js` that caches only the self-contained `public/offline.html` and answers failed page loads with it. Pages and api answers are never cached.
    - Linked and registered from the `(app)` layout only (not on `/book`, not in dev). `lib/pwa.ts` holds the registration.
    - The Dockerfile copies `apps/web/public`.
  - **Security review** of S14–S17 in `docs/engineering/security-review-s18.md`. No high findings.
    - M1 fixed: clickjacking; security headers are in `lib/security-headers.ts` and `next.config.ts`.
    - M2 fixed: forwarded api answers now get `private, no-store`.
    - L1–L8 logged for Phase 5/11: XFF trust, rate-limit key length, the manage token kept in history, script CSP, staff lookup throttling, caller text in code emails, expired request cleanup, dev-only `braces`/`esbuild` advisories with no patch.
  - **Accessibility:** `e2e/tests/accessibility.spec.ts` (`@axe-core/playwright` 4.13.0, the one new dependency, e2e only) on 16 screens and steps, light and dark, phone and desktop. 0 violations of any impact. A planted image without alt, a nameless button and low contrast were caught, proving the check. The check waits for color transitions after the scheme switch (a mid-fade sample failed once).
  - **Docs:** ADR-0023, security-and-tenancy (headers), testing-strategy (axe row), dev-setup (PWA, Docker Hub mirror), traceability (AC-W8-1 Playwright, PWA, accessibility, security review), dependency map, CHANGELOG 0.14.
  - **Checks run:**
    - `pnpm check` green. Web unit tests 221 (+14: `pwa.test.ts` 13, forward 1); all coverage gates pass (web 100% lines).
    - `pnpm test:integration` green, 555: db 330, appointments 102, core 60, api 60, runtime 2, testing 1.
    - Playwright: **52/52 green** (phone and desktop) against api, worker and `next start` on Compose Postgres, Redis and Mailpit (project `pepper-s18`), `--workers=2`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`. The new specs were also repeated 4× (AC-W8-1 8/8, PWA 8/8, axe 16/16).
    - `pnpm audit --prod`: no known vulnerabilities.
    - Phase 4 exit criteria proven: setup (`setup.spec.ts`), manual booking (`booking.spec.ts`), public booking (`public-booking.spec.ts`), concurrent last slot (AC-W8-1, above).
  - **Not done / for later:**
    - Docker image builds and the Compose E2E job were not run here; CI runs them, including the new `public/` copy.
    - The first baseline run had one sign-up redirect timeout on a cold server (the known password-hashing slowness; it passed on every later run).
    - Docker Hub answered 429 at the start; images came from `mirror.gcr.io` (same digests).
    - Push notifications (Phase 5).
    - The low findings above.

- **S19 Phase 5a (2026-10-20): transactional outbox and email delivery** ([ADR-0024](../adr/0024-transactional-outbox-and-email-delivery.md), accepted). At the Session Brief the user chose all five of Claude's recommendations ("sounds good, go with your recommendation and start").
  - **Database** (migrations 0024–0026):
    - `outbox_messages` (tenant RLS): sealed content, status `pending`/`sent`/`dead`, attempts, lease, last error name, a dedupe key unique per business.
    - `outbox_dispatch`: the relay's index of pending messages (ids and due times only), tenant RLS plus a read-only `outbox_scan` policy behind the transaction-local `app.outbox_scan` setting (`current_outbox_scan()`).
    - Both tables are in the isolation suite, plus a dedicated "outbox scan" block.
  - **Core:**
    - the `Mailer`/`EmailMessage` port
    - AES-256-GCM sealing bound to the message id, key from `OUTBOX_SECRET` via HKDF
    - `failureOutcome`: 5xx or unreadable content gives up at once; otherwise backoff of 30 s doubling to 1 h, 8 attempts
    - `queueEmail`
    - `deliverOutboxMessage`: claim under a 5-minute lease, send with a stable `Message-ID`, mark sent and meter `emails_sent` in one transaction
  - **Runtime:** `SmtpMailer`, `MailModule` and `MAILER` moved here from the api (SMTP timeouts added); the `loadMailConfig` and `loadOutboxSecret` env loaders; `raiseAlert` (Sentry, ids only).
  - **Worker:** `OutboxModule`: a relay polling every `OUTBOX_POLL_MS` (1 s) that queues one BullMQ job per due message (job id = message id), and a delivery worker (concurrency 5). It starts nothing without `SMTP_URL`. New dependency: **BullMQ 6.3.11** (pinned).
  - **Appointments:** a `notify` option on confirm, reschedule and cancel, called inside the change's transaction with a `BookingNotice`.
  - **Api:** the booking page queues its confirmed, moved and cancelled emails there. The code email stays direct (503 on failure).
  - **Config:** Compose and `.env.example` add `OUTBOX_SECRET` (api and worker) and `SMTP_URL`/`MAIL_FROM` for the worker; the worker now depends on Mailpit.
  - **Testing:** `startMailpit()` (with Mailpit's chaos API, to make SMTP refuse mail).
  - **Docs:** ADR-0024, jobs-messaging-integrations, data-model, security-and-tenancy, reliability, testing-strategy, dev-setup, open decisions (D4), traceability (AC-W4-2), dependency map, CHANGELOG 0.15.
  - **Checks run:**
    - `pnpm check` green. All coverage gates pass. Worker unit tests 13 at 100% lines; core, contracts and runtime unit tests added (outbox sealing and failure rules, schemas, mailer, env loaders, alert).
    - `pnpm test:integration` green, **604**:
      - db 363 (outbox repository 13, isolation incl. the two tables and the scan)
      - core 72 (AC-W4-2 at the service level, 12)
      - appointments 102 at the full run; the file later gained 2 notify tests (rolling back the change when notify fails), and that file was re-run green (27)
      - api 60
      - worker 3 (end to end through relay, BullMQ, Redis and Mailpit: duplicated jobs and relay passes, Mailpit refusing with 451 then recovering, a 550 refusal)
      - runtime 2
      - testing 2
    - Playwright: **52/52 green** (phone and desktop) against api, **worker** and `next start` on Compose Postgres, Redis and Mailpit (project `pepper-s19`), `--workers=2`. Afterwards the database showed 10 outbox messages, all `sent` on the first attempt, content cleared, no dispatch rows left. The public-booking journey now also checks the cancellation email.
  - **Not done / for later:**
    - Docker image builds were not run here (`docker compose build` cannot reach npm from this sandbox, the known corepack fetch failure). CI builds them and runs the Compose E2E job, now with the worker sending email.
    - Resend itself (Phase 11) with its idempotency key, which closes the one remaining duplicate case: a crash after the SMTP server accepted an email and before it was marked sent.
    - Clean-up of old `sent`/`dead` outbox rows (with S20's clean-up job).
    - A screen showing delivery status.
  - **Note:** while preparing Playwright, Claude overwrote the git-ignored local `.env` with a fresh copy of `.env.example` without checking it first. If it held your own values (e.g. a Sentry DSN), set them again.

- **Maintenance after S19 (2026-10-20):** CI on `main` after the S19 merge failed once in Integration: `packages/runtime/src/connections.module.int.test.ts` "answers 200 once the clients have connected" polled readiness with `expect.poll`'s 1-second default, too short on a runner now busier with the S19 outbox and worker suites (it passed on the PR's own run, and locally even under CPU load). It now waits up to 30 s like `apps/api/src/main.int.test.ts`. No product code changed.

- **S20 Phase 5b (2026-10-20): reminders, emails for team-made bookings, clean-up** ([ADR-0025](../adr/0025-booking-reminders-team-emails-and-cleanup.md), accepted). The user chose Claude's recommendation on all six Session Brief questions, then approved the plan after the plain-language explanation.
  - **Database** (migrations 0027–0029):
    - `booking_reminders`: one row per confirmed booking whose reminder is still to be sent (booking id, tenant, due time, planned start; no content). It has tenant RLS and a cascading composite foreign key to the booking.
    - Read-only **`job_scan`** policies (`current_job_scan(job)`, `withJobScan`): `reminders` on `booking_reminders`, `cleanup` on `tenants`.
    - Clean-up repositories; `setBookingManageTokenHash`.
    - Both scans are in the isolation suite.
  - **Appointments:**
    - `keepReminderInStep` on every booking write (team create, move and status; booking-page confirm, reschedule and cancel). A reminder is due 24 h before the start; there is none when the booking is less than 24 h ahead or not confirmed.
    - `sendDueReminders`/`sendDueReminder`: lock the booking, take the row, re-check, and queue the reminder email in one transaction. Batches run until the backlog is empty.
    - Team create, move and cancel call `notify`. A confirmation or move mints a new reschedule/cancel link, so the old one stops working.
    - The client email templates moved here from the api, plus the new reminder email.
  - **Core:** `cleanUp` deletes booking requests 24 h after they expire and `sent`/`dead` outbox rows after 30 days, per business, in batches.
  - **Contracts:** `notifyClient` (default `true`) on `POST /v1/bookings` and both forms of `PATCH /v1/bookings/:id`.
  - **Api:** `BookingEmails` (`apps/api/src/booking-emails`), one global provider used by the booking page and team bookings.
  - **Worker:** `JobsModule` runs the reminder job every `REMINDER_POLL_MS` (default 60 s, at most 4 min) and the clean-up at start-up and every `CLEANUP_INTERVAL_MS` (default 1 day), on a small `Periodic` helper. The worker may now import `@pepper/appointments`: the lint rule now matches the dependency map.
  - **Web:** an "Email the client …" checkbox, ticked by default, on the new-booking, move and cancel screens. A client without an email address shows that no confirmation is sent.
  - **Docs:**
    - ADR-0025 and CHANGELOG 0.16.
    - Architecture: jobs-messaging-integrations (reminders are Postgres-driven, not BullMQ delayed jobs), data-model.
    - Engineering: security-and-tenancy (`job_scan` row), security review (L7 fixed), reliability, dev-setup and `.env.example` (the two new optional variables).
    - Plan: traceability (AC-W6-1), dependency map.
  - **Checks run:**
    - `pnpm check` green, with all coverage gates passing (db functions needed a `withJobScan` unit test, now added).
    - `pnpm test:integration` green, **657** in total:

      | Package | Tests | New in S20 |
      |---|---|---|
      | db | 391 | reminders and clean-up repositories 10; isolation incl. both job scans |
      | appointments | 124 | reminders, team notices and AC-W6-1 with a controlled clock: 20 |
      | core | 73 | clean-up 1 |
      | api | 61 | a team booking's confirmation, link, unticked move and cancellation through the real app module |
      | worker | 4 | AC-W6-1 end to end on the real clock: reminder received within seconds of its due time, once, none for a cancelled booking |
      | runtime | 2 | |
      | testing | 2 | |

      After the run, the reminder file gained the backlog test, and that file was re-run green (21).
    - The AC-W6-1 file was run 3× (stable).
    - Playwright **52/52 green** (phone and desktop) against api, worker and `next start` on Compose Postgres, Redis and Mailpit (project `pepper-s20`), `--workers=2`. The owner's booking journey now checks the confirmation (with her link) and the moved time in Mailpit, and that an unticked cancellation sends nothing.
    - Afterwards the database held 34 outbox messages, all `sent` on the first attempt, with content cleared. There were 26 planned reminders (bookings a week ahead), no dispatch rows left, and no worker warnings.
  - **Self-review fix:** a reminder pass first handled only 100 reminders, so a backlog after downtime could take several minutes. Passes now continue in batches, with a test.
  - **Not done / for later:**
    - Docker image builds were not run here (the known npm/corepack fetch failure in this sandbox). CI builds them; the worker image now also carries `@pepper/appointments`.
    - Per-business reminder timing (the table stores each due time, so it can come without a migration).
    - SMS reminders (V1.1).
    - Unsubscribe/opt-out for reminders (they are transactional; revisit with marketing emails).
    - A screen showing delivery status.
    - The autonomy dial for confirmations and reminders (Phase 6; the approved default is "Just do it").

- **Maintenance after S20 (2026-10-20): fewer GitHub Actions minutes.** `ci.yml` runs on PRs, weekly (Monday 06:23 UTC) and by hand, no longer on pushes to `main`; a **Code changed?** job skips the three jobs for docs-only PRs. If it fails, everything runs. Its rule was checked on sample file lists, and actionlint 1.7.7 (with shellcheck) is clean. `dependabot.yml` is monthly with grouped PRs. `CLAUDE.md` gains the "save minutes" working rule; dev-setup documents it. Expected cost: about 18 minutes per session, instead of 40–55.

- **S21 Phase 5c (2026-10-20): to-dos, Web Push for the team, Phase 5 security review** ([ADR-0026](../adr/0026-tasks-and-web-push.md), accepted by the user on 2026-10-20). At the Session Brief the user chose Claude's recommendation on all four questions: the `web-push` library; pushes for booking-page activity and due to-dos; no client names in pushes; staff see their own to-dos, owners and managers all.
  - **Database** (migrations 0030–0031):
    - `tasks`: title, due time, assignee (composite key to memberships, cleared when they leave), open/done, source, creator, `due_notified_at`. A restrictive `member_scope` limits staff to tasks assigned to them or that they created; there is a `tasks` job scan.
    - `push_subscriptions`: endpoint and keys per member and business. Each member reaches only their own; the rows are removed with the membership.
    - The outbox type gains `push`.
    - Both tables are in the isolation suite.
  - **Contracts:** task schemas; push schemas with `isPushServiceEndpoint`; `OutboxPushSchema` (app paths only); permissions `tasks.read`/`tasks.manage` (staff `own`); audit `task.created`/`task.updated` (never the title); error codes `task_not_found`, `task_assignee_not_member`, `push_unavailable`.
  - **Core:**
    - Task services: a task is the caller's own by default; staff assign only themselves.
    - `sendDueTaskPushes`.
    - The `Pusher` port and push failure rules (404/410: device removed, push dropped without an alert).
    - `queuePush`, `queuePushToMembers`, device save, remove and status.
    - `can()` now fails closed for an unknown role.
  - **Appointments:** the booking page's team push (staff member and owners and managers) with wording on the business clock.
  - **Api:** `/v1/tasks`; `/v1/push` (key, subscription PUT/DELETE, status); `TeamPushes` queued next to the client's email. The api reads only `VAPID_PUBLIC_KEY`.
  - **Worker:** `WebPusher` (web-push 3.6.7, the one new dependency, pinned, worker only) sends the outbox's pushes; the due-task job runs on the reminders' interval when the VAPID keys are set.
  - **Web:**
    - A To-dos card on Home: add with date and time on the business clock, "For" for owners and managers, mark done, undo, overdue.
    - A "Notifications on this device" card: on, off, blocked, unsupported, and "add to Home Screen first" on iPhone and iPad; hidden when pushes are off.
    - `sw.js` shows pushes and opens only own-origin pages.
  - **Config:** a local-only VAPID key pair in Compose and `.env.example`. Three VAPID lines were appended to your local `.env`; nothing else in it was changed.
  - **Security review** (`docs/engineering/security-review-s21.md`): no high findings.
    - M1 SSRF through device endpoints, fixed: push services only, checked twice.
    - M2 one member crowding out the others' devices, fixed: 10 per member.
    - B1 shared device, fixed.
    - L1–L5 logged: send quotas, local secrets in production, task limits, a rare duplicate push, dev-only audit items.
  - **Docs:** ADR-0026; data-model, jobs-messaging-integrations; security-and-tenancy, dev-setup; traceability, dependency map, CHANGELOG 0.17.
  - **Checks run:**
    - `pnpm check` green.
      - Unit tests: contracts 475, core 562, web 247, api 263, runtime 90, appointments 79, worker 26, db 43, ui 79, templates 96, testing 13.
      - All coverage gates pass (core 100% lines, appointments 100%, web 98.8% lines, db functions 82.6%).
    - `pnpm test:integration` green, **712**:

      | Package | Tests | New in S21 |
      |---|---|---|
      | db | 424 | isolation for both tables and the tasks scan; tasks and devices 12 |
      | appointments | 125 | |
      | core | 93 | tasks 10, push 10 |
      | api | 62 | booking page push through the real api |
      | worker | 4 | |
      | runtime | 2 | |
      | testing | 2 | |

    - Playwright **60/60 green** (phone and desktop), incl. `tasks.spec.ts` and `notifications.spec.ts` (the switch with a stand-in browser subscription), against api, worker and `next start` on Compose Postgres, Redis and Mailpit (project `pepper-s21`), `--workers=2`. Afterwards the outbox held 30 emails, all sent on the first attempt; the worker logged no warnings.
    - `pnpm audit --prod`: no known vulnerabilities.
  - **Not done / for later:**
    - Docker image builds were not run here; CI builds them.
    - A real push to a real phone (needs a device; the encryption and signature are proven by decrypting and verifying in tests).
    - Per-business send quotas and refusing local secrets in production (Phase 11).
    - Recurring to-dos, AI-created to-dos (Phase 6), notification preferences per event.
  - **Note:** Docker Hub answered 429 in S18; this time the images pulled normally.

- **M1 maintenance (2026-10-20): cheaper, restart-safe sessions.** The user approved the plan after S21 (choices 1 STATUS size, 2a, 3a, 4a, 5a, 6a). `STATUS.md` split into this log, `decisions.md` and a short status (from ~730 lines / 105 KB to under 150 lines); a checkpoint rule in `CLAUDE.md` (after each finished task: commit and update "In progress" in `STATUS.md`, so `/compact`, restarts and usage limits lose nothing); a testing rule for generous time limits; in cloud sessions local Playwright uses CI's headless shell; when the session-start hook starts Docker it pulls through Google's mirror (`registry-mirrors: mirror.gcr.io`, same pinned digests), so Docker Hub's anonymous rate limit no longer stops `docker compose up`. No product code changed.

- **S22 Phase 6a (2026-10-20): Phase 6 plan, provider adapter, eval runner skeleton** ([ADR-0027](../adr/0027-llm-provider-port-and-evals.md), proposed by Claude, accepted by the user).
  - **Session Brief:** the user asked for careful planning of the most important layer, with Claude as senior advisor and a clear difference from the market.
    - Desk research (October 2026): competitors' AI is paid add-on receptionists for clients (Boulevard "Beau", Fresha AI Concierge), "ask your data" assistants (Vagaro "Vera", GlossGenius "Growth Analyst") and copy writers. None acts inside the business with permissions, previews, reasons, undo and per-action trust.
    - Decisions: a **$5 OpenAI budget for all of Phase 6, real calls only at the final testing stage (S27)**; the official `openai` SDK; Sentry deferred again.
  - **[Phase 6 playbook](phase-6-playbook.md)** (confirmed by the user):
    - the gap and differentiators D-1 exact previews, D-2 receipts (Why + Undo), D-3 follow-through, D-4 team-aware, D-5 private and dependable;
    - the measured quality bar and 15 design principles;
    - the budget policy and the eval strategy (scripted fake, hostile fake, cassettes, pass^k);
    - the OWASP LLM Top 10 mapping;
    - guides for S22–S27;
    - §9 "Keep getting better" with an improvement log (added at the user's request);
    - references.
  - **Built:**
    - `contracts/ai.ts` (additive).
    - `@pepper/ai`:
      - the `LlmProvider` port and `LlmError` (codes with `retryable`, optional billed usage);
      - `OpenAiProvider`: Responses API, `openai` 7.32.0 pinned, `store: false`, `include: reasoning.encrypted_content` with replay, `prompt_cache_key`, `safety_identifier`, strict function tools, `maxRetries: 0`, 30 s timeout, error mapping without provider text;
      - `loadOpenAiConfig`: `OPENAI_API_KEY`, `OPENAI_MODEL_ROUTINE` and `OPENAI_MODEL_STRONG` required with a key, an https base URL, the timeout;
      - `ScriptedProvider`;
      - `strictToolParameters` (closed objects, all fields required, an allow-list of keywords);
      - `meteredProvider`;
      - `businessClock` (a 14-day date table on the business clock).
    - **The eval runner** (`src/evals`, `evals/`):
      - Zod cases and deterministic graders: ordered tool calls with argument matchers, forbidden calls, the offered tools and their schemas, reply patterns;
      - pass^k, with gates per set;
      - cassettes, where recorded steps carry request fingerprints and fail as stale when the request changes;
      - a budget guard: price table, estimate, a per-run cap of $1.50, at most $4.50, refused without a key or price;
      - Markdown and JSON reports and the CLI;
      - three reference cases with hand-written cassettes.
    - `.env.example` has the OpenAI lines, empty.
  - **Checks:**
    - `pnpm check` green:

      | Package | Unit tests |
      |---|---|
      | contracts | 492 (+17) |
      | ai | 81, then 87 after the cap fix (~99.7% lines, gate 80%) |
      | core | 562 |
      | web | 247 |
      | api | 263 |
      | runtime | 90 |
      | appointments | 79 |
      | worker | 26 |
      | db | 43 |
      | ui | 79 |
      | templates | 96 |
      | testing | 13 |

    - `pnpm test:integration` green, 712 (unchanged).
    - `pnpm --filter @pepper/ai eval`: all gates met, $0.
    - The record path refused without a key, without a price and with a non-numeric cap.
    - **No real OpenAI call was made.**
  - **Found and fixed during the session:**
    - the SDK raises an in-stream `error` event as an `APIError` without a status, which first mapped to `bad_request` and now maps to `unavailable` (a fixture test caught it);
    - `--max-cost abc` (NaN) would have passed the cap check; `refuseRun` now refuses caps that are not a positive number of at most $4.50.
  - **Not done / for later:**
    - The adapter is proven only against documented response shapes. S27's smoke step (≤ $0.10) confirms it live, including that `include: reasoning.encrypted_content` and sending reasoning items back with their ids work with `store: false` on the chosen models.
    - The apps don't wire the provider or metering yet (S25).
    - The hostile fake and the seeded-world graders come with the tools (S24).
    - The budget ledger (S27).

- **S23 Phase 6b (2026-10-21): trust-layer data and decisions** ([ADR-0028](../adr/0028-trust-layer-proposals-executions-and-autonomy.md), proposed by Claude, accepted by the user; [PCR-003](changes/PCR-003.md), approved).
  - **Session Brief:** the user confirmed all of Claude's recommendations ("Go ahead with your recommendations").
    - PCR-003: `booking.cancel` and `task.create` on the dial, the strictest-action rule, the bulk lock by recipients.
    - A 2-minute "undo send" grace on AI-queued client emails.
    - Undo windows per action.
    - An "Ask me first for everything" switch.
    - Re-checks before building: OWASP published the 2026 LLM Top 10 (Excessive Agency is now LLM03); OpenAI's agent guidance pauses side effects for approval; current practice binds an approval to an argument fingerprint, and Pepper's fingerprint also covers the state the preview read.
  - **Built:**
    - **Contracts:**
      - `trust.ts`: the dial with each action's approval permission and undo window, `BULK_RECIPIENT_LIMIT`, `AI_EMAIL_GRACE_SECONDS`;
      - the decision, request, proposal, execution and explanation schemas;
      - `TrustJsonSchema` and `looksLikeContact` (ids-only guard);
      - `audit.ts`: actor `ai_on_behalf_of` and five trust actions;
      - `outbox.ts`: status `cancelled`.
    - **Database** (migrations 0032–0033):
      - `autonomy_settings`, `ai_action_proposals`, `ai_action_executions`, with RLS, staff `member_scope`, checks, guard triggers and no DELETE;
      - the trust repository, `cancelOutboxMessages`, `deleteTask`;
      - isolation-suite entries (new `noDelete`/`guarded` kinds).
    - **Core:**
      - `decideAutonomy`, `resolveAutonomy`, `stateFingerprint`/`canonicalJson`, `undoUntil`;
      - `auditActorOf` with `Actor.via` (all 21 audit writes in core and appointments use it);
      - services `requestAction`, `approveProposal`, `rejectProposal`, `undoAction`, `listPendingProposals`, `listRecentActions`, `getAutonomy`, `changeAutonomy`, `expireProposals`;
      - the `ActionRunner` port for S24 tools;
      - new errors (`ProposalNotFound`, `ProposalNotPending`, `ActionNotFound`, `UndoWindowClosed`, `UndoRefused` with a reason, `ActionTooLate`).
    - **Worker:** the daily clean-up marks expired proposals (audited as the system) and deletes cancelled outbox rows after 30 days.
  - **Checks:**
    - `pnpm check` green:

      | Package | Unit tests |
      |---|---|
      | contracts | 530 (+38) |
      | core | 1,172 (+610: the full action × level × tier × context table and the property tests) |
      | db | 44 (+1) |
      | others | unchanged |

      Coverage gates met.
    - `pnpm test:integration` green, 790 (+78). Among them:
      - isolation 253 with the three tables;
      - db trust 21;
      - core trust 31, including concurrent approve, concurrent undo, and undo racing the worker (5 rounds).
    - Mutation check: removing the bulk lock or the untrusted demotion from `decideAutonomy` fails 37 / 43 tests.
    - No real OpenAI call; no screens changed, so no Playwright run.
  - **Found and fixed during the session:**
    - **Self-review:**
      - the AI could have approved its own proposal, or used undo (a cancellation) to get around the dial; now people-only;
      - the trust layer now verifies each outbox link a tool returns (this business's, pending, and held for the grace on message actions);
      - pending proposals are filtered by expiry in SQL, not after the limit;
      - the ids-only guard's email pattern was quadratic (2.2 s on 40 KB); it is now bounded and size is checked first.
    - **Tests:**
      - an `undo_reason` check that refused `NULL` (caught by the isolation seed);
      - mixed fake and real clocks in an outbox test.
    - **Earlier tests that failed under full parallel load:**
      - the worker's outbox test read "sent" before the worker recorded it (now waits for it);
      - the api process test waited 30 s for start-up, which took longer (now 90 s).
  - **Not done / for later:**
    - S24 gives the booking services transaction-taking variants and implements `ActionRunner` per tool (the hostile fake attacks approve/undo/outbox links).
    - S25 wires `requestAction` into the loop and adds the HTTP endpoints and error codes.
    - S26 builds the cards, the Why sheet, Undo and the Autonomy settings page.
    - When a lead approves a staff member's proposal the receipt is the lead's (the staff member doesn't list it); logged for S26.
    - One runtime unit test failed once inside a full `pnpm check` early in the session and did not reproduce in 8 runs, including later full checks; logs are kept to name it if it returns.

- **S24 Phase 6c (2026-10-21): tool registry and the first ten tools** ([ADR-0029](../adr/0029-tool-registry-and-tools.md), proposed by Claude, pre-approved by the user).
  - **Session Brief:** the user confirmed all of Claude's recommendations ("Go ahead with your recommendations, ADR-0029 is fine"), pre-approved the ADR, and asked Claude to open the PR, merge it and end with the prompt for the next session.
    - ADR-0029 for S24 (S25's becomes ADR-0030).
    - `emailClient` on writes: `null` means the screens' default; the email stays on the dial.
    - Undo never emails the client.
    - Staff find only their own clients.
    - Re-checks before building: OpenAI's function-calling guide (strict schemas, fewer than 20 tools, the "intern test", don't make the model fill what code knows) and OWASP's 2026 LLM Top 10 (LLM01–03: injection, disclosure, excessive agency). The OpenAI and OWASP pages were not reachable from the container, so the check went through search results.
  - **Weak spots in S22–S23 named at the brief, all handled:**
    - previews ran in the committing transaction (now a rolled-back savepoint);
    - an overlap aborted the whole transaction (savepoints in the booking writes);
    - `ActionRunner.actions` was fixed per tool (the runner is built from the payload);
    - the S23 fake fingerprinted every open task (only touched rows now);
    - client search matched emails (name-only for the AI);
    - the email hold lived in the api (`queueBookingEmail`).

    Logged: undoing a notified move leaves the client's earlier link dead.
  - **Built:**
    - T1: the `*In` variants of the booking, availability, time-off, services, staff, task and client services; `reinstateBookingIn`; `withdrawTaskIn` with `task.deleted`; `findClientsByNameIn`.
    - T2: `queueBookingEmail` with `holdSeconds`.
    - T3: `dryRun` in the trust layer and the `refused` approval result.
    - T4–T6: the registry and the ten tools.
      - Guides with a lint; errors as stable codes; cards.
      - Short client names; local-time helpers.
      - `writeRunner`; approve and undo by id.
    - T7: the hostile fake (92 attacks per role) and the trust-layer attacks.
    - T8: `toolEvalCases` (20 generated cases) and per-tool budgets.
  - **Checks:**
    - `pnpm check` green. Unit tests: contracts 530, core 1,172, db 44, appointments 83, ai 146, api 263, web 247, others unchanged.
    - `pnpm test:integration` green, 862 (+72):
      - ai 57: reads 10, writes 26, hostile 11, latency 10;
      - appointments 136; core 129; db 470; api 62; worker 4; runtime 2; testing 2.
    - Mutation checks:
      - a preview that differs from the execution fails 5 tests;
      - a move undo that doesn't move back fails;
      - a preview run without the rollback fails the trust test.
    - Per-tool p95 on 2,000 bookings: reads 7–21 ms, writes 22–63 ms (target 300 ms); statements 6–44.
    - No OpenAI call; no screen changed, so no Playwright run.
  - **Found and fixed:**
    - by the hostile fake: `alternativesRange` built an inverted range for a time long past (a pre-existing 500 on the calendar screen; failing test first); `get_day` answered an empty day for another business's staff member (now `not_found`);
    - by the self-review: approve and undo took the proposal or receipt object from the caller (now ids, loaded from the database); a racing copy of a tool call answered `internal` (now `ConcurrentActionError`, retried once, so every copy gets the one execution);
    - lint: the `packages/ai` layer rule allowed only contracts and core (widened per ADR-0029).
  - **Not done / for later:**
    - S25: replay `hostileProvider` through the real loop; `toolDefinitions()` as the static prefix; run writes one at a time; seeded worlds for `toolEvalCases`; mark turns untrusted from `untrustedText`.
    - S26: "the client was already emailed" on Undo; expire proposals whose tool version changed; show the staff member the receipt when a lead approved their proposal (from S23).
    - A service or staff name typed with a phone number in it would fail the ids-only guard on a preview (`internal`): rare, logged.
    - The eval CLI still uses the S22 sample tools until S25 brings seeded worlds.

## Planned sessions as they stood at M1 (finished rows)
Phases 2, 3 and 4 are done and merged. Phase 5 (messaging + jobs) was split into S19–S21 (user, S19 Session Brief); all three are done and merged. Phase 6 (AI agent + trust layer) is split at the S22 Session Brief.

| # | Session target | Phase | Done when |
|---|---|---|---|
| S14 | ~~Design system + app shell + calendar day view; response caps~~ **done** | 4a | — |
| S15 | ~~**Booking screens:** create a booking from the calendar (service, staff member, free times from `/v1/availability`, client picker; staff find clients by exact email or phone), the booking sheet (details, move, status, cancel) with Radix dialogs, the 409 alternatives, the waitlist entry; booking outcomes rule (b) unless the user says otherwise; staff journey in Playwright~~ **done** | 4b | — |
| S16 | ~~**Clients, services and team screens:** client list and profile, service menu, staff members with hours, time off and services, booking rules; batch client lookup if needed; Team screen moved to the design system~~ **done** (ADR-0021 accepted) | 4c | — |
| S17 | ~~**Public booking page with email verification**~~ **done** (ADR-0022 accepted) | 4d | — |
| S18 | ~~**Phase 4 exit:** concurrent last slot in Playwright (AC-W8-1), PWA manifest and offline shell, accessibility pass (axe), security review of S14–S17~~ **done** (ADR-0023 accepted; Phase 4 complete) | 4e | — |
| S19 | ~~**Phase 5 planning + outbox**~~ **done** (ADR-0024 accepted; D4: Resend) | 5a | — |
| S20 | ~~**Confirmations and reminders**~~ **done** (ADR-0025 accepted) | 5b | — |
| S21 | ~~**Tasks + push notifications (Phase 5 exit)**~~ **done** (ADR-0026 accepted; Phase 5 complete) | 5c | — |

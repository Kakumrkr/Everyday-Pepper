# Dependency Map

Use this before any change: find the part you're changing, then check everything in "Consumed by" for impact (required in every PCR).

| Part | Depends on | Consumed by |
|---|---|---|
| **contracts** (Zod schemas, events, cards) | — | everything |
| **db** (`@floty/db`: Drizzle schema incl. Better Auth's global tables, SQL migrations + migrate CLI, roles, RLS, `withTenant`/`withUser`, repositories, `authDatabaseAdapter`, readiness probe) | contracts, Postgres, better-auth (Drizzle adapter only) | core, modules, ai, runtime, apps/api (migrate CLI in the image), worker |
| **core: tenancy/auth/RBAC** (`decideTenantAccess`, owners and managers need MFA; S8: `PERMISSION_MATRIX`/`can`, `decideMembershipChange`, team services `listMembers`/`changeMemberRole`/`removeMember`, `createBusiness` with the per-owner limit) | db, contracts | every API endpoint, AI tools, worker, web (`roleRequiresMfa` from contracts) |
| **api: auth** (`apps/api/src/auth`: Better Auth at `/api/auth`, `AuthService`, `SessionGuard`/`TenantGuard` (+ `@RequirePermission`)/`SameOriginGuard`; `/v1/me`, `/v1/tenants`, `/v1/tenant`) | db, core, contracts, runtime, better-auth | every tenant-scoped endpoint, web, e2e |
| **api: team** (`apps/api/src/team`, S8: `/v1/members`, `/v1/audit-log`) | core, contracts, runtime, api auth | web (Team screen, S9), e2e |
| **core: audit log** (S8: `audit_log` + `appendAuditEntry` in db, `readAuditLog` in core, per-action schemas in contracts) | db, contracts | all write services, trust layer |
| **core: customers** | db, RBAC | appointments, memory, messaging, feed, import |
| **core: messaging + outbox** | db, worker, integrations/email | reminders, feed drafts, waitlist offers, booking page |
| **core: tasks** | db, worker | AI tools, feed |
| **core: metering** (S8: `usage_meters`, `addUsage`, `recordUsage`/`usageFor`, `usagePeriodOf`) | db, contracts | AI agent (budgets), email sending (Phase 5), billing (future) |
| **modules/appointments** (rules, availability, bookings, waitlist) | core, contracts | AI tools, PWA calendar, booking page, feed insights, calendar sync, reminders |
| **templates/*** | template schema (contracts), appointments extension schema | tenant setup, onboarding, AI prompts, insights thresholds, UI terminology |
| **ai: provider adapter** | OpenAI SDK | agent loop, onboarding extraction, memory embeddings |
| **ai: tool registry + agent loop** | adapter, all domain services, trust layer, memory | chat, feed, onboarding, voice (V2) |
| **trust layer** (proposals, executions, undo, autonomy, explanations) | db, audit, outbox | AI tools, feed, settings UI |
| **memory** | db (pgvector), adapter | agent loop, "What I know", rules engine (learned rules) |
| **feed / insights** | appointments, customers, memory, trust layer, messaging | PWA home, daily briefing |
| **onboarding** | adapter, templates, appointments, import | signup flow |
| **integrations/google-calendar** | OAuth tokens, worker, appointments | availability (busy blocks), bookings (outbound) |
| **runtime** (Nest process wiring: config, redacting logger, request ids, OTel tracing, Sentry errors, health, connections incl. the `DATABASE` handle; `./instrument` preload entry) | contracts, core, db, NestJS, pino, OpenTelemetry, Sentry | apps/api, apps/worker |
| **testing** (test-only: Testcontainers Postgres/Redis using the Compose images, recording HTTP server, `postgresUrlAs`, RFC 6238 `totpCode`) | Testcontainers, docker-compose.yml | integration tests of db, runtime, apps; e2e (devDependency only) |
| **ui** (design system, cards) | contracts (card schemas) | web app, booking page |
| **apps/web** (S7: forwards `/api/auth/*` and `/v1/*` to the api; sign-in, sign-up, MFA setup, create business) | ui, API client (contracts), api (forwarding) | users |
| **apps/api** | core, modules, ai, runtime | web, booking page, webhooks, e2e |
| **apps/worker** | core, modules, integrations, runtime | jobs, e2e |

**High-blast-radius parts** (changes need extra review): contracts, db/RLS, tenancy/RBAC, trust layer, availability engine.

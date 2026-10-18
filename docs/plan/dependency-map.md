# Dependency Map

Use this before any change: find the part you're changing, then check everything in "Consumed by" for impact (required in every PCR).

| Part | Depends on | Consumed by |
|---|---|---|
| **contracts** (Zod schemas, events, cards) | — | everything |
| **db** (`@floty/db`: Drizzle schema incl. Better Auth's global tables, SQL migrations + migrate CLI, roles, RLS incl. the restrictive `member_scope` policies (S12), `withTenant`/`withUser`/`withMember`, repositories, `authDatabaseAdapter`, readiness probe) | contracts, Postgres, better-auth (Drizzle adapter only) | core, modules, ai, runtime, apps/api (migrate CLI in the image), worker |
| **core: tenancy/auth/RBAC** (`decideTenantAccess`, owners and managers need MFA; S8: `PERMISSION_MATRIX`/`can`, `decideMembershipChange`, team services `listMembers`/`changeMemberRole`/`removeMember`, `createBusiness` with the per-owner limit; S9: `permissionsOf` for the UI) | db, contracts | every API endpoint, AI tools, worker, web (`roleRequiresMfa` from contracts) |
| **api: auth** (`apps/api/src/auth`: Better Auth at `/api/auth`, `AuthService`, `SessionGuard`/`TenantGuard` (+ `@RequirePermission`)/`SameOriginGuard`; `/v1/me`, `/v1/tenants`, `/v1/tenant`) | db, core, contracts, runtime, better-auth | every tenant-scoped endpoint, web, e2e |
| **api: appointments** (`apps/api/src/appointments`, S10: `/v1/services`, `/v1/staff` with hours and time off; S11: `/v1/rules`; S12: `/v1/bookings`, `/v1/calendar/busy`, `/v1/availability`, `/v1/waitlist`) | modules/appointments, contracts, runtime, api auth | web (Phase 4 screens), e2e |
| **api: team** (`apps/api/src/team`, S8: `/v1/members`, `/v1/audit-log`; S9: `/v1/invites`, lookup and accept) | core, contracts, runtime, api auth | web (Team screen, invite page), e2e |
| **core: invites** (S9, ADR-0014: `invites` table + `withInviteTenant` in db, `createInvite`/`listInvites`/`revokeInvite`/`previewInvite`/`acceptInvite` and `canGrantRole` in core, invite schemas in contracts) | db, contracts, RBAC, audit log | api team, AI tools (Phase 6), email delivery of invites (Phase 5) |
| **core: audit log** (S8: `audit_log` + `appendAuditEntry` in db, `readAuditLog` in core, per-action schemas in contracts) | db, contracts | all write services, trust layer |
| **core: clients** (S12, ADR-0017: `clients` table, `listClients`/`getClient`/`createClient`, `/v1/clients` in `apps/api/src/clients`) | db, contracts, RBAC, audit log | appointments (bookings, waitlist; the clients `member_scope` policy reads bookings and waitlist entries), memory, messaging, feed, import |
| **core: messaging + outbox** | db, worker, integrations/email | reminders, feed drafts, waitlist offers, booking page |
| **core: tasks** | db, worker | AI tools, feed |
| **core: metering** (S8: `usage_meters`, `addUsage`, `recordUsage`/`usageFor`, `usagePeriodOf`) | db, contracts | AI agent (budgets), email sending (Phase 5), billing (future) |
| **modules/appointments** (`@floty/appointments`; S10: services, staff, hours, time off; S11: booking rules (`booking_rules`, `/v1/rules`), `resolveRules`, the pure availability engine and `Intl` time-zone helpers; S12: bookings with `booking_occupancy` and its exclusion constraint, `findAvailability`, the waitlist; S13: a `templateRuleDefaults` lookup passed in by the app) | core, db, contracts | AI tools, PWA calendar, booking page, feed insights, calendar sync, reminders |
| **templates** (`@floty/templates`, S13, ADR-0018: the eight V1 templates as data, parsed with the contracts' `TemplateSchema`; `templateRuleDefaults`, `templateSummaries`; imported only by apps) | contracts (`TemplateSchema`, `TemplateIdSchema`, `AutonomySettingsSchema`, rule and service limits) | tenant setup (`tenants.template_id`, `GET /v1/templates`), availability and booking (rule defaults via the api), onboarding, AI prompts and autonomy defaults, insights thresholds, UI terminology |
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
| **apps/web** (S7: forwards `/api/auth/*` and `/v1/*` to the api; sign-in, sign-up, MFA setup, create business; S9: Team screen, invite page) | ui, API client (contracts), api (forwarding) | users |
| **apps/api** | core, modules, ai, runtime | web, booking page, webhooks, e2e |
| **apps/worker** | core, modules, integrations, runtime | jobs, e2e |

**High-blast-radius parts** (changes need extra review): contracts, db/RLS (incl. the `member_scope` policies), tenancy/RBAC, trust layer, availability engine, the bookings exclusion constraint.

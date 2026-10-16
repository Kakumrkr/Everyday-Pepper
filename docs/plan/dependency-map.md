# Dependency Map

Use this before any change: find the part you're changing, then check everything in "Consumed by" for impact (required in every PCR).

| Part | Depends on | Consumed by |
|---|---|---|
| **contracts** (Zod schemas, events, cards) | — | everything |
| **db** (`@floty/db`: Drizzle schema, SQL migrations + migrate CLI, roles, RLS, `withTenant`, repositories, readiness probe) | contracts, Postgres | core, modules, ai, runtime, apps/api (migrate CLI in the image), worker |
| **core: tenancy/auth/RBAC** | db, contracts | every API endpoint, AI tools, worker |
| **core: audit log** | db | all write services, trust layer |
| **core: customers** | db, RBAC | appointments, memory, messaging, feed, import |
| **core: messaging + outbox** | db, worker, integrations/email | reminders, feed drafts, waitlist offers, booking page |
| **core: tasks** | db, worker | AI tools, feed |
| **core: metering** | db | AI agent (budgets), billing (future) |
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
| **testing** (test-only: Testcontainers Postgres/Redis using the Compose images, recording HTTP server, `postgresUrlAs`) | Testcontainers, docker-compose.yml | integration tests of db, runtime, apps (devDependency only) |
| **ui** (design system, cards) | contracts (card schemas) | web app, booking page |
| **apps/web** | ui, API client (contracts) | users |
| **apps/api** | core, modules, ai, runtime | web, booking page, webhooks, e2e |
| **apps/worker** | core, modules, integrations, runtime | jobs, e2e |

**High-blast-radius parts** (changes need extra review): contracts, db/RLS, tenancy/RBAC, trust layer, availability engine.

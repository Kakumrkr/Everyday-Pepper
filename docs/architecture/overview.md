# Architecture Overview

> Provides: system structure and layer rules · Depends on: product docs · Consumed by: every other architecture/engineering doc

## Layers
```
L4 Tenant customization   this business's rules, prices, preferences (owner/AI-set, validated)
L3 Industry templates     Salon, Barber, Nails, Spa, Trainer, Massage, Yoga… (config only)
L2 Business-model modules Appointments (V1) · Classes/Memberships · Quotes/Jobs · Orders · Invoicing (later)
L1 Platform core          tenancy, auth/RBAC, customers, conversations, AI agent, memory, trust layer,
                          tasks, messaging, notifications, files, audit, metering
```
**Rules**
- A layer depends only on layers below. L2 modules never import each other; they communicate via domain events and interfaces in `packages/contracts`.
- New industry = new L3 package. New business model = new L2 module. L1 is not modified for either.
- No industry conditionals in code; behaviour differences are data in templates.

## Containers
```
[Browser / PWA] ──HTTPS──> [apps/web  Next.js]  ──REST/WS──> [apps/api  NestJS]
                                                              │   ├─ domain services (L1/L2)
[Customer booking page] ─────────────────────────────────────┘   ├─ AI agent (packages/ai) ──> OpenAI API
                                                                  │
                     [PostgreSQL + pgvector] <────────────────────┤
                     [Redis] <── BullMQ ──> [apps/worker NestJS]  ├─ outbox relay, reminders, briefings,
                                                                  │  insights, calendar sync, imports
                     [S3-compatible storage]                      └─> Google Calendar, Email (SES/Resend)
Observability: Sentry + OpenTelemetry from web, api, worker
```
- `apps/web` holds no business logic; it renders, and calls the API. Server components may call the API server-side.
- `apps/api` is the only writer to the database. AI agent runs inside `apps/api` (and voice gateway in V2) and calls domain services in-process.
- `apps/worker` runs the same domain services for background work.

## Request lifecycle (AI turn)
1. User message → `POST /conversations/:id/messages` (auth → tenant context → rate limit).
2. Agent assembles context: tenant profile + template, active rules, recalled memory, relevant state.
3. OpenAI call with typed tool schemas; streamed to client over WebSocket/SSE.
4. Each tool call → domain service: permission check → rules validation → autonomy dial → either `ActionProposal` (needs approval) or `ActionExecution` (with undo record, explanation, audit, outbox events).
5. Result rendered as cards; side effects delivered by worker via outbox.

## Monorepo
pnpm + Turborepo. See `../../CLAUDE.md` for package list and rules. Shared Zod schemas in `packages/contracts` are the single source for API types, tool argument schemas, and event payloads.

## Related
`ai-agent-and-trust-layer.md` · `memory.md` · `modules-and-templates.md` · `data-model.md` · `jobs-messaging-integrations.md` · `voice-readiness.md`

# Dependency Map

Use this before any change: find the part you're changing, then check everything in "Consumed by" for impact (required in every PCR).

| Part | Depends on | Consumed by |
|---|---|---|
| **contracts** (Zod schemas, events, cards) | — | everything |
| **db** (schema, RLS, repositories) | contracts | core, modules, ai, worker |
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
| **ui** (design system, cards) | contracts (card schemas) | web app, booking page |
| **apps/web** | ui, API client (contracts) | users |
| **apps/api** | core, modules, ai | web, booking page, webhooks |
| **apps/worker** | core, modules, integrations | jobs |

**High-blast-radius parts** (changes need extra review): contracts, db/RLS, tenancy/RBAC, trust layer, availability engine.

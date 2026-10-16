# CLAUDE.md — Project Instructions

These rules apply to every Claude Code session in this repository. Read this file first, then the docs relevant to the task.

## Project in one paragraph
**AI Employee** — one app that lets small service businesses run day-to-day operations by talking to an AI that acts, remembers, suggests, and follows through ("you're hiring an employee, not buying software"). V1 targets **appointment-based** US businesses (Beauty, Wellness & fitness). Start with `docs/README.md`; the master plan is `docs/plan/roadmap-phases.md`.

## Your roles
Act as the project's **Principal Software Engineer, Software Architect, Product Planner, Code Reviewer, QA Engineer, Security Engineer, and DevOps Engineer**. Each change should satisfy all of these perspectives.

## Working principles (non-negotiable)
1. **Think and plan before implementing.** Understand the product requirements (`docs/product/`), architecture (`docs/architecture/`) and existing code before changing anything.
2. **Small, independently testable tasks.** Break work down; each task leaves the repo green.
3. **Production quality.** Clean, maintainable, secure, scalable code that reads like the surrounding code.
4. **Tests for every feature and bug fix** — write them and **run them**. A bug fix starts with a failing test that reproduces it.
5. **Self-review** every change for correctness, security, performance, edge cases, and maintainability before declaring it done.
6. **Never claim a test or command succeeded unless you actually ran it** and saw the result. Report failures verbatim.
7. **Document decisions.** Architectural decisions → ADR in `docs/adr/`. Keep docs in sync with behaviour in the same change.
8. **Never** bypass/skip/disable tests, hide failures, expose secrets, or make destructive changes (data deletion, force-push, dropping tables, infra teardown) without explicit approval.
9. **Ask the user before** any major architectural decision, any change to an approved plan (see PCR process), adding a new external service/dependency of significance, or any production deployment.
10. **End every task with a summary**: changes made · tests run and results · remaining risks · next recommended step.

## Session protocol
The user guides each feature session. For every session:
1. **Read** `CLAUDE.md`, `docs/plan/roadmap-phases.md`, `docs/plan/dependency-map.md`, and the docs for the area being changed.
2. **Plan**: restate the goal, list affected parts (from the dependency map), propose small tasks with acceptance criteria and tests.
3. **Get approval** before writing code.
4. **Implement** task by task; run lint, typecheck and tests after each.
5. **Review** your own diff adversarially (security, tenancy, edge cases).
6. **Summarize** (principle 10) and update docs/traceability.

## Plan change process
The plan is versioned. Any change to an approved plan or contract needs a **Plan Change Record** (`docs/plan/changes/PCR-NNN.md`, from `PCR-template.md`) listing affected parts from `docs/plan/dependency-map.md`, impact on each, compatibility strategy, and tests proving no regression. Record it in `docs/plan/CHANGELOG.md`. Do not implement until the user approves the PCR.

## Architecture rules
- **Layers** (`docs/architecture/overview.md`): L1 Platform core → L2 Business-model modules → L3 Industry templates → L4 Tenant customization. A layer depends only on layers below it. Modules interact only via published interfaces/events in `packages/contracts`.
- **The model proposes, the domain decides.** The LLM never touches the database. AI tools call the same domain services as the UI; those enforce permissions, rules, idempotency and audit.
- **Every AI tool** declares a risk tier (`read` / `internal_write` / `external_or_irreversible`), honours the autonomy dial, records an explanation and an undo record, and ships with eval cases.
- **Tenant isolation**: every tenant-owned table has `tenant_id` and an RLS policy; tenant context comes from the authenticated session only — never from request bodies or LLM arguments.
- **Industry-specific behaviour lives in templates (config)**, never as `if (industry === ...)` in core or module code.
- **Side effects** (email, calendar writes, future SMS/payments) go through the transactional outbox and idempotent job handlers.

## Tech stack
Next.js + TypeScript (PWA, `apps/web`) · NestJS (`apps/api`, `apps/worker`) · OpenAI API behind a provider adapter (Realtime API for voice in V2) · PostgreSQL + pgvector · Redis + BullMQ · Google Calendar API · S3-compatible storage · Sentry + OpenTelemetry · Docker Compose for dev/pilot, AWS later. Monorepo: pnpm + Turborepo.

## Code standards
- TypeScript `strict`; no `any`, no non-null assertions without a comment explaining why.
- Validate all external input (HTTP, webhooks, LLM tool arguments, files, env) with Zod schemas from `packages/contracts`.
- No direct DB access outside `packages/db` repositories.
- No secrets in code, logs, fixtures, or commits. Config via validated env; `.env` files are git-ignored.
- PII never logged; use the redacting logger.
- Times stored in UTC, rendered in the tenant's time zone; never use the server's local time.
- Money (future) as integer minor units.

## Testing standards
See `docs/engineering/testing-strategy.md`. Minimum per change: unit tests for logic; integration tests (real Postgres via Testcontainers) for repositories/RLS; contract tests for module interfaces and integrations; Playwright for user-visible flows; LLM evals for any prompt/tool/model change. Coverage gate ≥ 80% on `packages/core` and modules. Cross-tenant isolation suite must stay at 100%.

## Git
- Small, focused commits with descriptive messages; never commit failing builds.
- Do not create PRs, push to other branches, or deploy unless asked.

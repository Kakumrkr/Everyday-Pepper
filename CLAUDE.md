# CLAUDE.md — Project Instructions

These rules apply to every Claude Code session in this repository. Read this file first, then the docs relevant to the task.

## Project in one paragraph
**Pepper** (working name; the "AI Employee") — one app that lets small service businesses run day-to-day operations by talking to an AI that acts, remembers, suggests, and follows through ("you're hiring an employee, not buying software"). V1 targets **appointment-based** US businesses (Beauty, Wellness & fitness). Start with `docs/README.md`; the master plan is `docs/plan/roadmap-phases.md`.

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
The user guides each feature session. **One session = one feature-sized goal** (one big feature, or a few small related tasks). Big phases are split across several sessions; unrelated small fixes are batched into a separate maintenance session. If a session's goal turns out larger than expected, finish a clean, tested sub-part, commit, and move the rest to the next planned session.

For every session:
1. **Read** `CLAUDE.md`, **`docs/plan/STATUS.md` (where the last session stopped, what is in progress, and the planned sessions list)**, `docs/plan/roadmap-phases.md`, `docs/plan/dependency-map.md`, and the docs for the area being changed. Open `docs/plan/session-log.md` (every past session in full) and `docs/plan/decisions.md` (every decision made in chat) only when the task needs that history.
2. **Before doing any work, present a Session Brief** and wait for the user to confirm or adjust it:
   ```
   ## Session Brief
   - Where we are: <phase, what the last session finished>
   - Target of this session: <one sentence>
   - In scope: <bullets>        - Out of scope: <bullets>
   - Tasks: <small ordered tasks, each with its test>
   - Done when: <measurable acceptance criteria / AC IDs>
   - Affected parts: <from dependency-map>
   - Decisions needed from you: <questions with options, or "none">
   - Risks: <bullets>
   ```
   Take the target from the next entry in STATUS.md "Planned sessions" unless the user says otherwise.
3. **Plan detail and get approval** before writing code.
4. **Implement** task by task; run lint, typecheck and tests after each.
5. **Review** your own diff adversarially (security, tenancy, edge cases).
6. **Summarize** (principle 10) and update docs/traceability.
7. **Update `docs/plan/STATUS.md`** (done, decisions made in conversation, next steps) and commit it, so the next session can continue exactly where this one stopped. Decisions that exist only in chat are lost — always write them down. Keep `STATUS.md` short (under ~150 lines): move this session's summary into "Last sessions" (dropping the older one there), append the full entry to `docs/plan/session-log.md` and new decisions to `docs/plan/decisions.md`.

**Checkpoints.** After each finished task (code committed, checks green), commit and update the "In progress" section at the top of `STATUS.md`: what is done, the next step, open questions, and any decision made in chat. Then `/compact`, a worker restart or a usage limit loses nothing, and a new session can continue from the file alone. Clear "In progress" when the session ends.

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
- **Tests that pass here must pass on GitHub.** CI runners are slower and run every suite at once, so any test that waits on time (polling, property runs, start-up) uses generous limits (e.g. `expect.poll`/`vi.waitFor` with an explicit `timeout`, never the 1 s default). In cloud sessions run Playwright with CI's browser, the headless shell (the session-start hook sets `PLAYWRIGHT_CHROMIUM_EXECUTABLE`). CI has no retries: a failure is fixed, never retried away.

## Git
- Small, focused commits with descriptive messages; never commit failing builds.
- Do not create PRs, push to other branches, or deploy unless asked.
- **Save GitHub Actions minutes** (private repo, 2,000 minutes a month; one CI run is ~18 minutes). Pushing a session branch without a PR runs nothing; every push to an open PR runs full CI. So: run all checks locally first (`pnpm check`, `pnpm test:integration`, Playwright when screens or flows change); put every commit in before opening the PR, including the docs and the "ADR accepted" and STATUS updates; then open the PR once and merge after one green run. Push to an open PR only to fix a CI failure, and group fixes into one push. CI runs on PRs (not again on `main` after merge), weekly on `main`, and skips its jobs for docs-only PRs (`.github/workflows/ci.yml`).

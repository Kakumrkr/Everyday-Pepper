# Developer Setup & Workflow

How to run the monorepo locally and how work reaches `main`. Keep this file in sync with `package.json`, `turbo.json`, `eslint.config.js`, `Dockerfile`, `docker-compose.yml` and `.github/workflows/ci.yml`.

## Prerequisites
- **Node 22** (`.nvmrc`; `engines` allows `>=22.12 <23`, enforced via `.npmrc` `engine-strict`).
- **pnpm 10** via Corepack: `corepack enable` (version pinned in `package.json` `packageManager`).
- **Docker** with Compose v2 (for the stack and the E2E smoke test).

## Commands (run from the repo root)
| Command | What it does |
|---|---|
| `pnpm install` | Install all workspace dependencies |
| `pnpm check` | Everything CI runs: format check → lint → typecheck → tests with coverage gate → build |
| `pnpm lint` / `pnpm lint:fix` | ESLint over the whole repo (zero warnings allowed) |
| `pnpm format` / `pnpm format:check` | Prettier |
| `pnpm typecheck` | `tsc` per package (Turborepo) |
| `pnpm test` / `pnpm test:coverage` | Vitest unit tests per package; coverage gate ≥ 80% lines/branches/functions/statements |
| `pnpm test:integration` | Builds, then runs `*.int.test.ts` against real Postgres + Redis in throwaway containers (Testcontainers; needs Docker) |
| `pnpm build` | Compile packages to `dist/` and the web app to `.next/` (Turborepo, dependency order, cached) |
| `pnpm dev` | Builds the packages, then runs api (:4000), worker (:4100) and web (:3000) in watch mode. Needs the infra containers and a `.env` (copy `.env.example`) |
| `pnpm test:e2e` | Playwright smoke test against a running stack (see below) |
| `pnpm db:migrate` | Builds `@pepper/db`, applies migrations as `MIGRATION_DATABASE_URL`, then creates/updates the login role in `DATABASE_URL` (reads `.env`) |
| `pnpm db:generate` | After changing `packages/db/src/schema.ts`: writes the next SQL migration (drizzle-kit; no database needed). Review it and commit it with the schema |

`pnpm check` does not run integration tests (they need Docker); CI runs them in their own job.

Run `pnpm check` before every push.

## Running the stack
| Goal | Command |
|---|---|
| Everything in containers | `docker compose up --build --wait` → web http://localhost:3000, api http://localhost:4000, worker http://localhost:4100 |
| Infra only, apps via `pnpm dev` | `docker compose up -d --wait postgres redis mailpit`, `cp .env.example .env`, `pnpm db:migrate`, `pnpm dev` |
| Fake inbox (Mailpit) | http://localhost:8025 (SMTP `localhost:1025`) |
| E2E smoke | stack up, then `pnpm test:e2e` (first time: `pnpm --filter @pepper/e2e exec playwright install chromium`) |
| Stop and wipe data | `docker compose down --volumes` |

- Health: `GET /health/live` (process up, no dependency calls) and `GET /health/ready` (Postgres and Redis reachable; **503** with the same body when not) on api and worker; web has `GET /health/live`. Bodies follow `HealthReportSchema` (`@pepper/contracts`) and say only `up`/`down` per check; error details go to the server log.
- **After the Floty → Pepper rename ([PCR-002](../plan/changes/PCR-002.md)):** a database created before it still has the old role and database names. Rebuild it once with `docker compose down --volumes` (local data only) and copy the new names from `.env.example` into your `.env`.
- Compose credentials are local-only defaults (override in a git-ignored `.env`); every port binds to `127.0.0.1`.
- **Database roles** ([ADR-0010](../adr/0010-database-roles-and-migrations.md)): the one-shot `migrate` service (api image, `node node_modules/@pepper/db/dist/migrate-cli.js`) runs migrations as the `POSTGRES_USER` superuser and creates the `APP_DB_USER` login role (`pepper_service`); api and worker start after it exits successfully and connect as `pepper_service`, which RLS applies to. Readiness reports the database `down` if `DATABASE_URL` uses a superuser or `BYPASSRLS` role. To inspect data as the owner: `docker compose exec postgres psql -U pepper`.
- One `Dockerfile` builds all apps (`--target api|worker|web`): pinned base image digest, production-only dependencies (`pnpm deploy`), Next.js standalone output, non-root `node` user, `HEALTHCHECK` per app.
- **Sign-in (S7, [ADR-0012](../adr/0012-auth-sessions-and-tenant-context.md)):**
  - Open http://localhost:3000 and create an account. You then create a business and set up two-step verification with any authenticator app.
  - The web app forwards `/api/auth/*` and `/v1/*` to the api, so the browser uses one origin.
  - The api needs `AUTH_SECRET` (≥ 32 characters; Compose has a local-only default) and `AUTH_BASE_URL` (the browser's origin, `http://localhost:3000`).
  - Changing `AUTH_SECRET` signs everyone out and makes stored TOTP secrets unreadable.
  - Sign-in is rate limited per client address (3 tries per 10 s per endpoint).
- **Team and audit log (S8, [ADR-0013](../adr/0013-roles-audit-log-and-metering.md)):** `GET /v1/members`, `PATCH /v1/members/:userId` `{ role }`, `DELETE /v1/members/:userId` (your own id: leave the business), `GET /v1/audit-log?limit=&before=`. Managers, like owners, must set up two-step verification. One account can own at most 5 businesses. There is no invite flow until S9; to add a member locally, insert a `memberships` row as the owner (`docker compose exec postgres psql -U pepper`).
- **`.pnpmfile.cjs`** trims better-auth's optional framework peers, which pnpm would otherwise install into the api image. Change it if we start using another Better Auth integration.
- **Object storage is not in Compose yet.** MinIO no longer publishes community images; the replacement is SeaweedFS ([ADR-0011](../adr/0011-dev-object-storage-seaweedfs.md)), added in Phase 4 when the first feature needs storage.
- **Screens and styling (S14, [ADR-0019](../adr/0019-design-system-and-app-shell.md)):**
  - Tailwind v4 with the theme from `@pepper/ui/theme.css` (colors such as `bg-surface`, `text-ink-2`, `bg-brand-soft`; `font-display`; radii `rounded-sm/md/lg`; the `desk:` breakpoint at 960 px). Colors come only from the tokens in `packages/ui/src/tokens.ts`; a new one needs a token, and the contrast test checks it.
  - Signed-in screens live in the route group `apps/web/app/(app)` and get the app shell (bottom tabs, sidebar from 960 px). Pages outside it (sign-in, setup) keep the centered card.
  - Fonts are self-hosted (Fontsource); the build needs no request to Google.
  - Calendar: http://localhost:3000/calendar (`?date=YYYY-MM-DD&staff=<id>`). Setup screens (S16, [ADR-0021](../adr/0021-setup-screens.md)): `/services` (menu) and `/services/rules`, `/team` and `/team/<staffMemberId>` (details, weekly hours, time off), `/clients` and `/clients/<clientId>`.
- **Playwright without Docker images** (when `docker build` cannot reach npm): `docker compose up -d --wait postgres redis mailpit`, `cp .env.example .env`, `pnpm db:migrate`, `pnpm build`, then start the api (`node --env-file=../../.env --import ./dist/instrument.js dist/main.js` in `apps/api`) the worker (the same command in `apps/worker`; it sends the queued emails) and the web app (`API_INTERNAL_URL=http://localhost:4000 pnpm --filter @pepper/web start`), and run `pnpm --filter @pepper/e2e test:e2e`. On a laptop, `--workers=2` or `3` avoids sign-up timeouts from parallel password hashing.
- **Public booking page** (S17, [ADR-0022](../adr/0022-public-booking-page.md)): `http://localhost:3000/book/<slug>`; codes and confirmations land in Mailpit (http://localhost:8025). The api needs `SMTP_URL` (`.env.example`: `smtp://localhost:1025`; Compose: `smtp://mailpit:1025`); without it the page answers 503 when asked for a code. Since S19 the confirmation, moved and cancelled emails go through the outbox and **the worker sends them** (next item), so run the worker too. The Playwright journey reads Mailpit's API at `MAILPIT_URL` (default `http://localhost:8025`). Owners set the page's color on Services.
- **Outbox and email delivery** (S19, [ADR-0024](../adr/0024-transactional-outbox-and-email-delivery.md)):
  - api and worker both need `OUTBOX_SECRET` (≥ 32 characters, the same value; Compose and `.env.example` have a local-only default). The api seals queued emails with it, and the worker opens them. Changing it gives up emails still queued.
  - The worker needs `SMTP_URL` (and `MAIL_FROM`) as well. Without it the worker logs that queued emails wait, and sends nothing.
  - The relay polls every `OUTBOX_POLL_MS` (default 1000).
  - The worker queues due booking reminders every `REMINDER_POLL_MS` (default 60000) and cleans up old booking requests and outbox rows every `CLEANUP_INTERVAL_MS` (default one day, and once at start-up), ADR-0025. Both run without `SMTP_URL` too; the reminder emails then wait in the outbox.
  - To look at planned reminders: `docker compose exec postgres psql -U pepper -c 'SELECT id, due_at, starts_at FROM booking_reminders ORDER BY due_at LIMIT 20'`.
  - Without Docker images, start the worker like the api: `node --env-file=../../.env --import ./dist/instrument.js dist/main.js` in `apps/worker`.
  - To look at queued messages: `docker compose exec postgres psql -U pepper -c 'SELECT id, status, attempts, last_error, available_at FROM outbox_messages ORDER BY created_at DESC LIMIT 20'`. Content is encrypted and cleared once sent.
- **Installable app and offline page** (S18, [ADR-0023](../adr/0023-pwa-offline-and-phase-4-exit.md)): the service worker registers only in production builds (`pnpm build` + `start`, or Compose), from the signed-in app. To see the offline page, open the app once, then turn the network off in DevTools (or open `/offline.html`). To drop the worker: DevTools → Application → Service workers → Unregister. axe runs in `e2e/tests/accessibility.spec.ts`; a failure lists each rule, impact and element.
- **Docker Hub rate limit** (`429 Too Many Requests` on `docker compose up`): pull the same pinned digests from Google's mirror, e.g. `docker pull mirror.gcr.io/library/redis@sha256:…`, and point a git-ignored compose override at them (`image: mirror.gcr.io/library/redis@sha256:…`), then `docker compose -f docker-compose.yml -f <override> up`.
- **Playwright with a preinstalled browser** (e.g. a sandbox without browser downloads): set `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome`.
- **Claude Code cloud sessions** run `.claude/hooks/session-start.sh` at start-up (registered in `.claude/settings.json`): `pnpm install` and, if needed, start `dockerd`. Unit tests, lint and integration tests work right away; it does nothing outside cloud sessions.
- **Docker build behind a TLS-inspecting proxy** (some cloud dev sandboxes): the build container needs the proxy CA and `HTTPS_PROXY`; CI and normal machines need nothing extra. If `docker info` says the daemon is not running, start `dockerd` first (integration tests need it too).

## Layout
```
packages/
  config/      shared tsconfig presets (@pepper/config)
  contracts/   Zod schemas, events, cards — the only cross-module interface (@pepper/contracts)
  core/        L1 platform core, framework-free: rules (permission matrix, membership rules) and domain services over db (@pepper/core)
  db/          Drizzle schema, SQL migrations + migrate CLI, withTenant (RLS), repositories (@pepper/db)
  modules/
    appointments/  L2 appointments module: services, staff, hours, time off, rules, availability, bookings, waitlist (@pepper/appointments)
  templates/   L3 industry templates, data only; imported by apps only (@pepper/templates)
  ui/          design system: tokens (light/dark), Tailwind theme, shared React components; imported by apps only (@pepper/ui)
  runtime/     process wiring shared by api + worker: config, logging, telemetry, health, connections (@pepper/runtime)
  testing/     test-only helpers: Testcontainers Postgres/Redis, recording HTTP server (@pepper/testing)
apps/
  api/         NestJS HTTP API (@pepper/api)
  worker/      NestJS background worker; serves only health over HTTP until Phase 5 (@pepper/worker)
  web/         Next.js PWA + booking page (@pepper/web)
e2e/           Playwright tests against a running stack (@pepper/e2e)
```
Planned packages (more `modules/*`, `ai`, `integrations`) follow `../architecture/overview.md` and `../plan/dependency-map.md`.

## Conventions
- **ESM + TypeScript strict** (`packages/config/tsconfig.base.json`): `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. Relative imports use the `.js` extension (NodeNext).
- **Package entry points.** Each package exports `.` only, except `@pepper/runtime/instrument` (see Observability). The `@pepper/source` export condition points at `src/index.ts`; typecheck, lint and editors use it (`customConditions`), so no build is needed while developing. Builds (`tsconfig.build.json`) and Node at runtime use `dist/`.
- **Layer boundaries are lint errors.** `eslint.config.js` lists which `@pepper/*` packages each package may import (from the dependency map) and forbids deep imports (`@pepper/x/src/...`). Add a row when creating a package.
- **No `any`, no unexplained `!`.** A non-null assertion needs `// eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- <why>`; every disable comment must have a `-- reason`.
- **Time:** domain code takes a `Clock` (`@pepper/core`), never `new Date()` directly; tests use `ManualClock`. Instants cross boundaries as `UtcDateTime` (`@pepper/contracts`).
- **Tests** live next to code as `*.test.ts` (unit) and `*.int.test.ts` (integration: real Postgres/Redis via `@pepper/testing`, own `vitest.int.config.ts`, no coverage gate); both are excluded from `dist/`. `@pepper/testing` is a devDependency only; it reads the Postgres and Redis images from `docker-compose.yml`, so tests and the dev stack always run the same pinned images. Unit tests import other workspace packages from `dist/` (Turborepo builds them first), so run a package's tests via `pnpm test` or after `pnpm build`.
- **Database access** goes through `@pepper/db` only. Tenant data is read and written inside `withTenant(db, tenantId, tx => ...)` using repository functions, which never take a tenant id: `tenant_id` defaults to the transaction's tenant and RLS hides everything else. `tenantId` comes from the authenticated session or a job's stored context, never from request bodies or LLM arguments. A new table needs: the Drizzle table with the `tenantIsolation` policy (or a reason it is global), `pnpm db:generate`, a custom migration with `FORCE ROW LEVEL SECURITY` and the `set_updated_at` trigger, and an entry in the isolation suite (`packages/db/src/isolation.int.test.ts`), which fails until the table is classified. A reference to another tenant table is a composite foreign key on `(tenant_id, id)` (the parent has `UNIQUE (tenant_id, id)`), because foreign key checks bypass RLS (ADR-0015). Repositories, migrations and RLS are tested against real Postgres (`*.int.test.ts`) and excluded from the unit coverage gate.
- **Domain services** (`packages/core/src/services/`, and per module in `packages/modules/<name>/src/services/`) take an `Actor` (the session's tenant context and the request id), check the permission matrix, and write their audit entries in the same transaction as the change; the api and (Phase 6) AI tools call them, never repositories for writes. A new write needs an action in `AuditChangeSchema` (contracts) with a strict before/after schema. Core's services are integration-tested (`pnpm test:integration`) and excluded from its unit coverage gate; the pure rules they apply are unit-tested at 100%.
- **NestJS (api, worker, runtime)** is ESM (Nest 12 ships ESM) on Express 5, compiled by `tsc` with `@pepper/config/tsconfig.nest.json` (decorator metadata on). Vitest compiles Nest code with SWC (`unplugin-swc`) because esbuild cannot emit decorator metadata. Inject by token (`@Inject(TOKEN)`) for interfaces and values.
- **Next.js (web)** uses bundler resolution: imports inside `apps/web` have no `.js` extension. `next-env.d.ts` and `.next/` are generated (`next typegen` runs in `typecheck`) and git-ignored. Env is read per request so one image runs everywhere.

## Configuration, logging and observability (api, worker)
- **Config** is read once at startup by `loadServiceConfig` (`@pepper/runtime`) and validated with Zod. An invalid variable stops the process with an error that names the variable but never its value. An empty variable counts as unset. Variables: `PORT`, `DATABASE_URL` (the services' login role, never the migration role), `REDIS_URL` (required), `LOG_LEVEL` (`info`), `DEPLOYMENT_ENVIRONMENT` (`local`), `RELEASE`, `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT` (optional). `OTEL_EXPORTER_OTLP_HEADERS` is read by the OTLP exporter itself (collector auth). See `.env.example`.
- **Start-up:** `node --import ./dist/instrument.js dist/main.js` (`pnpm dev`, `start`, the Docker image). `src/instrument.ts` imports only `@pepper/runtime/instrument` and `./config.js`, so tracing is set up before NestJS, pg or ioredis load. Never import those from the preload.
- **Logs:** JSON lines on stdout (pino) with `service`, `env`, `release`, `request_id`, and `trace_id`/`span_id` when tracing is on. Use Nest's `Logger`; it goes through the same logger. Everything passes through `redact` (sensitive keys, emails, phones, URL credentials, bearer tokens), but **never log personal data on purpose**: log ids, not names, emails or phone numbers. Each request gets `x-request-id` (a safe incoming value is reused) and one log line (method, path without query string, status, duration; health probes at `debug`). For readable local logs, pipe through `npx pino-pretty`.
- **Traces** (OpenTelemetry → OTLP/HTTP) are on only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set: http, express, pg and ioredis spans; `/health/live` is not traced. Query strings and pg bound values are never exported.
- **Errors** go to Sentry only when `SENTRY_DSN` is set. Only unexpected errors (not `HttpException`s) are reported, all data collection is off, and events pass through `redact`. Decision record: [ADR-0009](../adr/0009-observability-wiring.md).
- **Shutdown:** SIGTERM runs Nest's shutdown hooks (close Postgres/Redis, flush spans and error reports), then re-raises the signal.

## Tooling versions and known constraints
- **TypeScript is pinned to 6.0.x** because typescript-eslint supports `< 6.1`. Dependabot ignores TypeScript ≥ 6.1; lift this when typescript-eslint supports TypeScript 7.
- `@types/node` and the Docker `node` base image track Node 22 LTS (major updates ignored by Dependabot; a Node upgrade is a planned change).
- GitHub Actions are pinned to commit SHAs and Docker images to digests; Dependabot (`.github/dependabot.yml`: npm, docker, docker-compose, github-actions) proposes updates weekly.
- `@swc/core`'s install script is not run (`ignoredBuiltDependencies` in `pnpm-workspace.yaml`); its prebuilt binary comes from the optional platform package. The same goes for Testcontainers' optional native extras (`ssh2`, `cpu-features`) and `protobufjs`'s version-check script.
- `@opentelemetry/instrumentation-nestjs-core` supports Nest < 12 only, so it is not installed; add it back when it supports Nest 12.

## Branches, PRs and CI
- `main` is the integration branch and holds only reviewed work. Nobody pushes to it directly.
- Each Claude Code session works on its own `claude/*` branch and opens a PR into `main`; **the user reviews and merges**.
- CI (`.github/workflows/ci.yml`) runs on every PR and on pushes to `main`. Job **Lint, typecheck, test, build** runs format, lint, typecheck, tests with the coverage gate, and build. Job **Integration (Testcontainers)** runs `pnpm test:integration`. Job **E2E smoke (Docker Compose)** builds the images, runs `docker compose up --wait`, and runs Playwright on phone and desktop viewports, with logs and the report on failure. Later phases add evals and image publishing (`deployment-and-costs.md`).
- After merge the head branch is deleted (GitHub setting "Automatically delete head branches"); its history stays in `main`.
- Recommended GitHub settings (done by the repo owner): default branch `main`; branch protection on `main` requiring the **CI / Lint, typecheck, test, build**, **CI / Integration (Testcontainers)** and **CI / E2E smoke (Docker Compose)** checks and a PR.

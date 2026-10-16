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
| `pnpm test` / `pnpm test:coverage` | Vitest per package; coverage gate ≥ 80% lines/branches/functions/statements |
| `pnpm build` | Compile packages to `dist/` and the web app to `.next/` (Turborepo, dependency order, cached) |
| `pnpm dev` | Builds the packages, then runs api (:4000), worker (:4100) and web (:3000) in watch mode. Needs the infra containers and a `.env` (copy `.env.example`) |
| `pnpm test:e2e` | Playwright smoke test against a running stack (see below) |

Run `pnpm check` before every push.

## Running the stack
| Goal | Command |
|---|---|
| Everything in containers | `docker compose up --build --wait` → web http://localhost:3000, api http://localhost:4000, worker http://localhost:4100 |
| Infra only, apps via `pnpm dev` | `docker compose up -d --wait postgres redis mailpit`, `cp .env.example .env`, `pnpm dev` |
| Fake inbox (Mailpit) | http://localhost:8025 (SMTP `localhost:1025`) |
| E2E smoke | stack up, then `pnpm test:e2e` (first time: `pnpm --filter @floty/e2e exec playwright install chromium`) |
| Stop and wipe data | `docker compose down --volumes` |

- Health: `GET /health/live` (process up, no dependency calls) and `GET /health/ready` (Postgres and Redis reachable; **503** with the same body when not) on api and worker; web has `GET /health/live`. Bodies follow `HealthReportSchema` (`@floty/contracts`) and say only `up`/`down` per check; error details go to the server log.
- Compose credentials are local-only defaults (override in a git-ignored `.env`); every port binds to `127.0.0.1`.
- One `Dockerfile` builds all apps (`--target api|worker|web`): pinned base image digest, production-only dependencies (`pnpm deploy`), Next.js standalone output, non-root `node` user, `HEALTHCHECK` per app.
- **Object storage is not in Compose yet.** MinIO no longer publishes community images; choosing a replacement is open decision D10 (`../plan/open-decisions.md`). Nothing uses storage before Phase 4.
- **Playwright with a preinstalled browser** (e.g. a sandbox without browser downloads): set `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome`.
- **Docker build behind a TLS-inspecting proxy** (some cloud dev sandboxes): the build container needs the proxy CA and `HTTPS_PROXY`; CI and normal machines need nothing extra.

## Layout
```
packages/
  config/      shared tsconfig presets (@floty/config)
  contracts/   Zod schemas, events, cards — the only cross-module interface (@floty/contracts)
  core/        L1 platform core, framework-free (@floty/core)
  runtime/     process wiring shared by api + worker: health, connections, env helpers (@floty/runtime)
apps/
  api/         NestJS HTTP API (@floty/api)
  worker/      NestJS background worker; serves only health over HTTP until Phase 5 (@floty/worker)
  web/         Next.js PWA + booking page (@floty/web)
e2e/           Playwright tests against a running stack (@floty/e2e)
```
Planned packages (`db`, `modules/*`, `templates/*`, `ai`, `integrations`, `ui`) follow `../architecture/overview.md` and `../plan/dependency-map.md`.

## Conventions
- **ESM + TypeScript strict** (`packages/config/tsconfig.base.json`): `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. Relative imports use the `.js` extension (NodeNext).
- **Package entry points.** Each package exports `.` only. The `@floty/source` export condition points at `src/index.ts`; typecheck, lint and editors use it (`customConditions`), so no build is needed while developing. Builds (`tsconfig.build.json`) and Node at runtime use `dist/`.
- **Layer boundaries are lint errors.** `eslint.config.js` lists which `@floty/*` packages each package may import (from the dependency map) and forbids deep imports (`@floty/x/src/...`). Add a row when creating a package.
- **No `any`, no unexplained `!`.** A non-null assertion needs `// eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- <why>`; every disable comment must have a `-- reason`.
- **Time:** domain code takes a `Clock` (`@floty/core`), never `new Date()` directly; tests use `ManualClock`. Instants cross boundaries as `UtcDateTime` (`@floty/contracts`).
- **Tests** live next to code as `*.test.ts`; they are excluded from `dist/`. Unit tests import other workspace packages from `dist/` (Turborepo builds them first), so run a package's tests via `pnpm test` or after `pnpm build`.
- **NestJS (api, worker, runtime)** is ESM (Nest 12 ships ESM) on Express 5, compiled by `tsc` with `@floty/config/tsconfig.nest.json` (decorator metadata on). Vitest compiles Nest code with SWC (`unplugin-swc`) because esbuild cannot emit decorator metadata. Inject by token (`@Inject(TOKEN)`) for interfaces and values.
- **Next.js (web)** uses bundler resolution: imports inside `apps/web` have no `.js` extension. `next-env.d.ts` and `.next/` are generated (`next typegen` runs in `typecheck`) and git-ignored. Env is read per request so one image runs everywhere.

## Tooling versions and known constraints
- **TypeScript is pinned to 6.0.x** because typescript-eslint supports `< 6.1`. Dependabot ignores TypeScript ≥ 6.1; lift this when typescript-eslint supports TypeScript 7.
- `@types/node` tracks Node 22 (major updates ignored by Dependabot).
- GitHub Actions are pinned to commit SHAs and Docker images to digests; Dependabot (`.github/dependabot.yml`: npm, docker, docker-compose, github-actions) proposes updates weekly.
- `@swc/core`'s install script is not run (`ignoredBuiltDependencies` in `pnpm-workspace.yaml`); its prebuilt binary comes from the optional platform package.

## Branches, PRs and CI
- `main` is the integration branch and holds only reviewed work. Nobody pushes to it directly.
- Each Claude Code session works on its own `claude/*` branch and opens a PR into `main`; **the user reviews and merges**.
- CI (`.github/workflows/ci.yml`) runs on every PR and on pushes to `main`: job **Lint, typecheck, test, build** (format, lint, typecheck, tests + coverage gate, build) and job **E2E smoke (Docker Compose)** (builds the images, `docker compose up --wait`, Playwright on phone + desktop viewports, logs and report on failure). Later phases add integration (Testcontainers), evals and image publishing (`deployment-and-costs.md`).
- After merge the head branch is deleted (GitHub setting "Automatically delete head branches"); its history stays in `main`.
- Recommended GitHub settings (done by the repo owner): default branch `main`; branch protection on `main` requiring the **CI / Lint, typecheck, test, build** and **CI / E2E smoke (Docker Compose)** checks and a PR.

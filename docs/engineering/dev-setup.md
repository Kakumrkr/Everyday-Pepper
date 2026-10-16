# Developer Setup & Workflow

How to run the monorepo locally and how work reaches `main`. Keep this file in sync with `package.json`, `turbo.json`, `eslint.config.js` and `.github/workflows/ci.yml`.

## Prerequisites
- **Node 22** (`.nvmrc`; `engines` allows `>=22.12 <23`, enforced via `.npmrc` `engine-strict`).
- **pnpm 10** via Corepack: `corepack enable` (version pinned in `package.json` `packageManager`).

## Commands (run from the repo root)
| Command | What it does |
|---|---|
| `pnpm install` | Install all workspace dependencies |
| `pnpm check` | Everything CI runs: format check → lint → typecheck → tests with coverage gate → build |
| `pnpm lint` / `pnpm lint:fix` | ESLint over the whole repo (zero warnings allowed) |
| `pnpm format` / `pnpm format:check` | Prettier |
| `pnpm typecheck` | `tsc` per package (Turborepo) |
| `pnpm test` / `pnpm test:coverage` | Vitest per package; coverage gate ≥ 80% lines/branches/functions/statements |
| `pnpm build` | Compile packages to `dist/` (Turborepo, dependency order, cached) |

Run `pnpm check` before every push.

## Layout
```
packages/
  config/      shared tsconfig presets (@floty/config)
  contracts/   Zod schemas, events, cards — the only cross-module interface (@floty/contracts)
  core/        L1 platform core, framework-free (@floty/core)
apps/          (S4) web (Next.js), api + worker (NestJS)
```
Planned packages (`db`, `modules/*`, `templates/*`, `ai`, `integrations`, `ui`) follow `../architecture/overview.md` and `../plan/dependency-map.md`.

## Conventions
- **ESM + TypeScript strict** (`packages/config/tsconfig.base.json`): `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. Relative imports use the `.js` extension (NodeNext).
- **Package entry points.** Each package exports `.` only. The `@floty/source` export condition points at `src/index.ts`; typecheck, lint and editors use it (`customConditions`), so no build is needed while developing. Builds (`tsconfig.build.json`) and Node at runtime use `dist/`.
- **Layer boundaries are lint errors.** `eslint.config.js` lists which `@floty/*` packages each package may import (from the dependency map) and forbids deep imports (`@floty/x/src/...`). Add a row when creating a package.
- **No `any`, no unexplained `!`.** A non-null assertion needs `// eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- <why>`; every disable comment must have a `-- reason`.
- **Time:** domain code takes a `Clock` (`@floty/core`), never `new Date()` directly; tests use `ManualClock`. Instants cross boundaries as `UtcDateTime` (`@floty/contracts`).
- **Tests** live next to code as `*.test.ts`; they are excluded from `dist/`.

## Tooling versions and known constraints
- **TypeScript is pinned to 6.0.x** because typescript-eslint supports `< 6.1`. Dependabot ignores TypeScript ≥ 6.1; lift this when typescript-eslint supports TypeScript 7.
- `@types/node` tracks Node 22 (major updates ignored by Dependabot).
- GitHub Actions are pinned to commit SHAs; Dependabot (`.github/dependabot.yml`) proposes updates weekly.

## Branches, PRs and CI
- `main` is the integration branch and holds only reviewed work. Nobody pushes to it directly.
- Each Claude Code session works on its own `claude/*` branch and opens a PR into `main`; **the user reviews and merges**.
- CI (`.github/workflows/ci.yml`) runs on every PR and on pushes to `main`: format, lint, typecheck, tests + coverage gate, build. Later phases add integration (Testcontainers), E2E (Playwright), evals and image builds (`deployment-and-costs.md`).
- After merge the head branch is deleted (GitHub setting "Automatically delete head branches"); its history stays in `main`.
- Recommended GitHub settings (done by the repo owner): default branch `main`; branch protection on `main` requiring the **CI / Lint, typecheck, test, build** check and a PR.

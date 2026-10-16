# ADR-0001: TypeScript monorepo — Next.js web, NestJS API and worker

- **Status:** Proposed · **Date:** 2026-10-16

## Context
Solo developer with AI assistance; need one language end to end, shared types, and clear module boundaries for a layered, multi-industry product. User selected Next.js + NestJS.

## Decision
pnpm + Turborepo monorepo. `apps/web` (Next.js App Router, PWA), `apps/api` (NestJS HTTP/SSE), `apps/worker` (NestJS standalone, BullMQ). Shared packages: `contracts` (Zod), `db`, `core`, `modules/*`, `templates/*`, `ai`, `integrations`, `ui`. Business logic lives in framework-free packages so it is testable and reusable by api and worker.

## Consequences
+ One toolchain, shared types, atomic changes across layers.
+ NestJS DI/modules give structure for permissions and workflows.
− Two server frameworks to learn/configure (Next.js and NestJS); mitigated by keeping Next.js free of business logic.

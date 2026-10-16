# AI Employee — Planning Docs

> Status: **Draft for review** · Phase: planning only (no application code yet)

An AI Employee for small businesses, starting with independent US salons. Owners and staff run day-to-day operations through natural-language conversation; the AI executes tasks, remembers business preferences, surfaces opportunities, and follows through on scheduled work.

## Index

### Product
- [01 — Vision & problems](product/01-vision-and-problems.md)
- [02 — Personas & workflows](product/02-personas-and-workflows.md)
- [03 — V1 scope](product/03-v1-scope.md)
- [04 — Acceptance criteria](product/04-acceptance-criteria.md)

### Architecture
- [00 — Overview](architecture/00-overview.md)
- [01 — AI orchestration](architecture/01-ai-orchestration.md)
- [02 — Memory](architecture/02-memory.md)
- [03 — Core domain & industry packs](architecture/03-core-domain-and-industry-packs.md)
- [04 — Data model](architecture/04-data-model.md)
- [05 — Jobs & integrations](architecture/05-jobs-and-integrations.md)

### Engineering
- [Security & tenancy](engineering/security-and-tenancy.md)
- [Reliability](engineering/reliability.md)
- [Testing strategy](engineering/testing-strategy.md)
- [Observability](engineering/observability.md)
- [Deployment & environments](engineering/deployment-and-environments.md)
- [AI-assisted development](engineering/ai-assisted-development.md)

### Delivery
- [Roadmap & phases](delivery/roadmap-phases.md)
- [Risks](delivery/risks.md)
- [Open decisions](delivery/open-decisions.md)
- [Assumptions](delivery/assumptions.md)

### Architecture Decision Records
- [ADR-0001 — TypeScript monorepo with Next.js](adr/0001-typescript-monorepo-nextjs.md)
- [ADR-0002 — Postgres with Row-Level Security](adr/0002-postgres-with-rls.md)
- [ADR-0003 — Postgres-backed job queue (pg-boss)](adr/0003-postgres-job-queue.md)
- [ADR-0004 — Provider-agnostic LLM adapter, Claude default](adr/0004-llm-adapter.md)
- [ADR-0005 — LLM proposes, domain decides](adr/0005-llm-proposes-domain-decides.md)

## How these docs are maintained
- Docs live with the code and change in the same PR as the behaviour they describe.
- Any significant decision gets an ADR (`docs/adr/NNNN-title.md`, status: Proposed → Accepted → Superseded).
- Acceptance criteria in `product/04` are the source for E2E tests and LLM evals; a criterion without a test is a gap.
- Open decisions move from `delivery/open-decisions.md` into an ADR once resolved.

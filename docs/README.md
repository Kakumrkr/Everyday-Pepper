# AI Employee — Planning Docs

> Status: **Draft for review** · Plan version 0.2 · Phase 0 (planning; no application code yet)

One app that lets small service businesses run day-to-day operations by talking to an AI employee that acts, remembers, suggests, and follows through. V1: appointment-based US businesses (Beauty, Wellness & fitness). Project rules for every Claude Code session: [`../CLAUDE.md`](../CLAUDE.md).

## Research
- [Competitor audit](research/competitor-audit.md)
- [Owner interview script](research/owner-interview-script.md)

## Product
- [Vision & differentiation](product/vision-and-differentiation.md)
- [Personas & workflows](product/personas-and-workflows.md)
- [V1 scope & roadmap](product/v1-scope.md)
- [Acceptance criteria](product/acceptance-criteria.md)
- [UX principles](product/ux-principles.md)

## Architecture
- [Overview & layers](architecture/overview.md)
- [AI agent & trust layer](architecture/ai-agent-and-trust-layer.md)
- [Memory](architecture/memory.md)
- [Modules & industry templates](architecture/modules-and-templates.md)
- [Data model](architecture/data-model.md)
- [Jobs, messaging & integrations](architecture/jobs-messaging-integrations.md)
- [Voice readiness](architecture/voice-readiness.md)

## Engineering
- [Security & tenancy](engineering/security-and-tenancy.md)
- [Testing strategy](engineering/testing-strategy.md)
- [Reliability & observability](engineering/reliability-and-observability.md)
- [Deployment & costs](engineering/deployment-and-costs.md)

## Plan
- [Roadmap & phases](plan/roadmap-phases.md)
- [Dependency map](plan/dependency-map.md)
- [Traceability](plan/traceability.md)
- [Risks](plan/risks.md)
- [Open decisions](plan/open-decisions.md)
- [Changelog](plan/CHANGELOG.md)
- [PCR template](plan/changes/PCR-template.md)

## Architecture Decision Records (all Proposed)
- [ADR-0001 TypeScript monorepo](adr/0001-typescript-monorepo.md)
- [ADR-0002 Postgres + RLS](adr/0002-postgres-rls.md)
- [ADR-0003 BullMQ + outbox](adr/0003-bullmq-outbox.md)
- [ADR-0004 LLM provider adapter](adr/0004-llm-provider-adapter.md)
- [ADR-0005 Model proposes, domain decides](adr/0005-model-proposes-domain-decides.md)
- [ADR-0006 Lean deployment](adr/0006-lean-deployment.md)

## How these docs are maintained
- Docs change in the same commit as the behaviour they describe.
- Changes to the approved plan go through a PCR (`plan/changes/`), checked against the dependency map, and are logged in the changelog.
- Every acceptance criterion maps to automated tests in `plan/traceability.md`.

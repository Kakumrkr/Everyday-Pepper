# ADR-0005: The model proposes, the domain decides

- **Status:** Accepted (2026-10-16) · **Date:** 2026-10-16

## Context
The AI executes real business operations. Mistakes and prompt injection must not corrupt data or message customers wrongly.

## Decision
AI tools are thin adapters over the same domain services the UI uses. Every tool has a risk tier; the autonomy dial decides whether it executes or creates an `ActionProposal`. Executions record actor, idempotency key, before/after, explanation and an undo record. Tenant and user context come only from the session. The LLM never accesses the database directly.

## Consequences
+ One validated code path; behaviour testable without the LLM.
+ Trust features (explanations, undo) come for free for every tool.
− Each tool needs an inverse operation and card renderer — more upfront work per tool.

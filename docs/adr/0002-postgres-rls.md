# ADR-0002: PostgreSQL + pgvector with Row-Level Security for tenant isolation

- **Status:** Accepted (2026-10-16) · **Date:** 2026-10-16

## Context
Multi-tenant SaaS holding customer PII; AI agent issues queries on behalf of users; isolation failures are the highest-impact risk.

## Decision
Single PostgreSQL database (shared schema) with `tenant_id` on every tenant table and RLS policies keyed on `current_setting('app.tenant_id')`, set with `SET LOCAL` per transaction by the request/job context. App role lacks `BYPASSRLS`; a separate migration role owns schema. pgvector stores memory embeddings. Booking overlaps prevented by a GiST exclusion constraint.

## Consequences
+ Defence in depth: a missed `WHERE tenant_id` cannot leak data.
+ One database for data, vectors, outbox — simple ops and transactional side effects.
− Requires discipline in connection handling (transaction-scoped settings) and RLS-aware tests.

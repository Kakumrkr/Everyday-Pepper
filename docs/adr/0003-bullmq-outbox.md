# ADR-0003: Redis + BullMQ for jobs, with a Postgres transactional outbox

- **Status:** Accepted (2026-10-16) · **Date:** 2026-10-16

## Context
Reminders, briefings, waitlist offers, sync and imports need scheduling, retries and delays. Side effects must never be lost or duplicated. User selected Redis + BullMQ.

## Decision
BullMQ on Redis for queues and delayed/repeatable jobs. All side effects are first written as `OutboxMessage` rows in the same transaction as the business change; a relay enqueues them. Handlers are idempotent via dedupe keys. Jobs carry IDs only; Postgres is the source of truth, and reconciliation jobs rebuild schedules if Redis data is lost.

## Consequences
+ Mature tooling, delayed jobs, rate limiting, dashboards.
+ Exactly-once *effects* despite at-least-once delivery.
− One more service (Redis) to run; acceptable in Docker Compose and managed later (ElastiCache).

# Reliability & Observability

## SLOs (pilot)
| SLO | Target |
|---|---|
| API availability | 99.5% monthly |
| Booking page p95 load | < 2 s |
| AI chat turn p95 (with tools) | < 5 s to first useful output (streaming starts < 1.5 s) |
| Reminder delivery | within 5 min of schedule, 99% |
| Calendar sync lag | < 5 min |

## Reliability patterns
- Idempotency keys on every write endpoint and AI action.
- Transactional outbox; idempotent job handlers; retries with backoff; dead-letter + alert. Built for email in S19 ([ADR-0024](../adr/0024-transactional-outbox-and-email-delivery.md)): retries in Postgres (30 s doubling to 1 h, 8 attempts), a message given up stays `dead` and raises an error log and a Sentry alert (ids only).
- Scheduled work lives in Postgres, not Redis (S20, [ADR-0025](../adr/0025-booking-reminders-team-emails-and-cleanup.md)): booking reminders are rows kept in step with each booking, checked every minute; the clean-up runs at start-up and daily. Restarting Redis or the worker loses nothing; a reminder backlog after downtime clears in one pass. A failing pass is logged once (error name only) until it recovers.
- Graceful degradation: LLM outage → AI features show a clear message; all manual screens keep working. Redis outage → jobs resume from Postgres reconciliation.
- Timeouts and circuit breakers on all external calls.
- Forward-only migrations (expand/contract) so deploys never need downtime.
- Backups: nightly encrypted dumps to object storage + restore drill each quarter (RPO ≤ 24 h pilot; tighten with managed DB later).

## Observability
Wiring (Phase 1, S5): `@pepper/runtime` — see [ADR-0009](../adr/0009-observability-wiring.md) and `dev-setup.md` → *Configuration, logging and observability*. Built so far: JSON logs with `request_id` and trace ids, redaction, OTLP tracing (http, express, pg, ioredis), Sentry errors. Still to come: `tenant_id`/`user_id` on log lines (Phase 2, from the request context), log shipping, metrics, alerts.
- **Logs**: structured JSON (pino) with `request_id`, `tenant_id`, `user_id` (no PII), shipped to Grafana Cloud free tier (Loki).
- **Traces**: OpenTelemetry across web → api → worker → external calls; AI turns traced per tool call with latency and token counts.
- **Errors**: Sentry (free tier) for web, api, worker; release tagging.
- **Metrics**: request rates/latency, queue depth, job failures, DLQ size, email bounces, sync errors, LLM tokens & cost per tenant.
- **Alerts**: SLO burn, DLQ > 0, job failure spikes, cost spikes per tenant, backup failure.
- **Runbooks** in `docs/runbooks/` (created in Phase 11) for each alert.

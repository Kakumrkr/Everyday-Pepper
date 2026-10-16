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
- Transactional outbox; idempotent job handlers; retries with backoff; dead-letter + alert.
- Graceful degradation: LLM outage → AI features show a clear message; all manual screens keep working. Redis outage → jobs resume from Postgres reconciliation.
- Timeouts and circuit breakers on all external calls.
- Forward-only migrations (expand/contract) so deploys never need downtime.
- Backups: nightly encrypted dumps to object storage + restore drill each quarter (RPO ≤ 24 h pilot; tighten with managed DB later).

## Observability
- **Logs**: structured JSON (pino) with `request_id`, `tenant_id`, `user_id` (no PII), shipped to Grafana Cloud free tier (Loki).
- **Traces**: OpenTelemetry across web → api → worker → external calls; AI turns traced per tool call with latency and token counts.
- **Errors**: Sentry (free tier) for web, api, worker; release tagging.
- **Metrics**: request rates/latency, queue depth, job failures, DLQ size, email bounces, sync errors, LLM tokens & cost per tenant.
- **Alerts**: SLO burn, DLQ > 0, job failure spikes, cost spikes per tenant, backup failure.
- **Runbooks** in `docs/runbooks/` (created in Phase 11) for each alert.

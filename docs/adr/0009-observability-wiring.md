# ADR-0009: Observability wiring — pino logs, OpenTelemetry traces, Sentry errors

- **Status:** Proposed (Claude default in S5, user to confirm) · **Date:** 2026-10-16

## Context
The plan names pino (logs), OpenTelemetry (traces) and Sentry (errors) for api and worker (`../engineering/reliability-and-observability.md`). These need wiring that never leaks secrets or personal data, works with ESM NestJS 12, and costs nothing until an endpoint is configured. Since v8 the Sentry SDK has been built on OpenTelemetry, so the two can end up competing for the global tracer provider.

## Decision
- **One process wiring in `@floty/runtime`.** `createServiceApp` gives every Nest service the same logger, request ids, error reporting and shutdown; `loadServiceConfig` validates the shared environment once at startup.
- **Logs: pino directly** (no `nestjs-pino`). The output is JSON on stdout. Every object and message passes through one `redact` function: sensitive keys are dropped, and emails, phone numbers, URL credentials and bearer tokens are scrubbed from free text. Lines carry `service`, `env`, `release`, `request_id` (AsyncLocalStorage) and `trace_id`/`span_id` (active span). Request logs carry method, path *without query string*, status and duration.
- **Traces: OpenTelemetry owns tracing.** We run a lean `NodeTracerProvider` with explicit instrumentations (http, express, pg, ioredis), not the auto-instrumentation bundle. Traces are exported over OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set and are off otherwise. Query strings and pg bound values are never exported.
- **Errors: Sentry for errors only** (`enableOpenTelemetrySetup: false`, no load-time module rewriting). Turned on by `SENTRY_DSN`. Every `dataCollection` option is off (users, headers, cookies, bodies, query, local variables), and events pass through `redact` in `beforeSend`. Only unexpected errors (not `HttpException`s) are reported.
- **Start-up order:** `node --import ./dist/instrument.js dist/main.js`. The preload imports only `@floty/runtime/instrument` (config + telemetry; no Nest, pg or ioredis) and registers the OpenTelemetry ESM loader hook before the app's modules load. Without the hook, no ESM module is patched; an integration test proves both cases.

## Consequences
+ Vendor-neutral traces (Grafana Cloud free tier now, any OTLP backend later). Errors and logs work offline, and nothing is sent until configured.
+ A single redaction path for logs and error reports, unit-tested and proven end to end (the api integration test asserts no email, URL credentials or query string leave the process).
− Two SDKs to keep in step (Dependabot). `@sentry/node` 11 is heavy (~65 MB with its CLI dependency) for an errors-only use; revisit if the image size matters.
− `@opentelemetry/instrumentation-nestjs-core` does not support Nest 12 yet, so there are no Nest controller spans; express route spans cover routes until it does.
− Pattern-based redaction can over-redact (a 10-digit number reads as a phone) or miss unusual formats. Domain code must still avoid logging personal data in the first place.

import { register } from 'node:module';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import * as Sentry from '@sentry/node';
import type { ServiceConfig } from './config.js';
import { redact, REDACTED } from './redact.js';
import { withoutSecrets } from './request-logging.js';

type ObservabilityConfig = Pick<
  ServiceConfig,
  'service' | 'environment' | 'release' | 'sentryDsn' | 'otlpEndpoint'
>;

/** What `startObservability` turned on, and how to flush and stop it. */
export interface Observability {
  readonly tracing: boolean;
  readonly errorReporting: boolean;
  shutdown(): Promise<void>;
}

let active: Observability | undefined;

/** Sentry collects personal data by default (users, headers, bodies, local variables): off. */
const SENTRY_DATA_COLLECTION: NonNullable<Sentry.NodeOptions['dataCollection']> = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
};

/**
 * Starts tracing (OpenTelemetry → OTLP/HTTP) when `otlpEndpoint` is set and error reporting
 * (Sentry, errors only) when `sentryDsn` is set; each is off otherwise. Call it once, before the
 * app's modules load, from the file passed to `node --import`: instrumentation patches modules
 * as they are imported. Later calls return the running instance.
 */
export function startObservability(config: ObservabilityConfig): Observability {
  if (active) return active;
  const stops: (() => Promise<unknown>)[] = [];

  if (config.otlpEndpoint !== undefined) {
    stops.push(startTracing(config, config.otlpEndpoint));
  }
  if (config.sentryDsn !== undefined) {
    Sentry.init({
      dsn: config.sentryDsn,
      environment: config.environment,
      ...(config.release !== undefined && { release: config.release }),
      // Errors only: tracing belongs to OpenTelemetry, and no module rewriting at load time.
      enableOpenTelemetrySetup: false,
      enableRuntimeChannelInjection: false,
      // Collect nothing about people or payloads; what remains still passes `redact` below.
      dataCollection: SENTRY_DATA_COLLECTION,
      beforeSend: scrubSentryEvent,
      beforeBreadcrumb: (breadcrumb) => redact(breadcrumb) as Sentry.Breadcrumb,
    });
    stops.push(() => Sentry.close(2_000));
  }

  const instance: Observability = {
    tracing: config.otlpEndpoint !== undefined,
    errorReporting: config.sentryDsn !== undefined,
    shutdown: async () => {
      if (active === instance) active = undefined;
      await Promise.allSettled(stops.map((stop) => stop()));
    },
  };
  active = instance;
  return instance;
}

/** Flushes and stops whatever `startObservability` started (no-op when nothing runs). */
export async function shutdownObservability(): Promise<void> {
  await active?.shutdown();
}

/** Sentry events pass through the same redaction as logs before they leave the process. */
export function scrubSentryEvent<T extends Sentry.Event>(event: T): T {
  return redact(event) as T;
}

function startTracing(config: ObservabilityConfig, endpoint: string): () => Promise<void> {
  // ESM modules are only patchable through a loader hook registered before they are imported.
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: `pepper-${config.service}`,
      ...(config.release !== undefined && { [ATTR_SERVICE_VERSION]: config.release }),
      'deployment.environment.name': config.environment,
    }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: tracesUrl(endpoint) }))],
  });
  provider.register();
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new HttpInstrumentation({
        // Liveness is polled constantly and touches nothing; readiness stays traced.
        ignoreIncomingRequestHook: (request) => request.url === '/health/live',
        requestHook: (span, request) => {
          if ('url' in request && request.url !== undefined) {
            span.setAttributes(httpSpanOverrides(request.url));
          }
        },
      }),
      // Express spans carry the route. @opentelemetry/instrumentation-nestjs-core does not
      // support Nest 12 yet (it patches < 12); add it back when it does.
      new ExpressInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new IORedisInstrumentation(),
    ],
  });
  return () => provider.shutdown();
}

/**
 * What an incoming request's span must not export, overridden: a query string can carry
 * personal data (an email in a lookup), and a path can carry a secret (S36: an unsubscribe
 * link's token, `withoutSecrets`). Both the old and the stable HTTP attributes are covered.
 */
export function httpSpanOverrides(url: string): Record<string, string> {
  const at = url.indexOf('?');
  const path = at === -1 ? url : url.slice(0, at);
  const safe = withoutSecrets(path);
  if (at === -1 && safe === path) return {};
  return {
    ...(at !== -1 && { 'url.query': REDACTED }),
    ...(safe !== path && { 'url.path': safe }),
    'http.target': safe,
    'http.url': safe,
    'url.full': safe,
  };
}

/** The OTLP/HTTP traces URL for a collector base URL (`<base>/v1/traces`). */
export function tracesUrl(endpoint: string): string {
  return new URL('v1/traces', endpoint.endsWith('/') ? endpoint : `${endpoint}/`).toString();
}

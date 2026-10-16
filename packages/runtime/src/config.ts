import { z } from 'zod';

/** A Postgres connection string (`postgres://` or `postgresql://`). Carries credentials. */
export const DatabaseUrlSchema = z.url({ protocol: /^postgres(ql)?$/ });
/** A Redis connection string (`redis://` or `rediss://`). May carry credentials. */
export const RedisUrlSchema = z.url({ protocol: /^rediss?$/ });
/** A TCP port, coerced from the environment string. */
export const PortSchema = z.coerce.number().int().min(1).max(65_535);

/** pino log levels; `silent` turns logging off (tests). */
export const LogLevelSchema = z.enum([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

/** Environment variables every Nest process (api, worker) reads. */
const ServiceEnvSchema = z.object({
  PORT: PortSchema.optional(),
  DATABASE_URL: DatabaseUrlSchema,
  REDIS_URL: RedisUrlSchema,
  LOG_LEVEL: LogLevelSchema.default('info'),
  /** Where this runs (`local`, `ci`, `pilot`, ...); tags errors and traces. */
  DEPLOYMENT_ENVIRONMENT: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/)
    .default('local'),
  /** Build identifier (version or git SHA); tags errors and traces. */
  RELEASE: z
    .string()
    .regex(/^[\w.+-]{1,64}$/)
    .optional(),
  /** Sentry project DSN. Unset: errors are only logged. */
  SENTRY_DSN: z.url({ protocol: /^https?$/ }).optional(),
  /** OTLP/HTTP collector base URL (e.g. Grafana Cloud). Unset: no tracing. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
});

export type NestServiceName = 'api' | 'worker';

/**
 * Validated configuration of one Nest process. Never log it: connection strings and the
 * Sentry DSN carry credentials.
 */
export interface ServiceConfig {
  service: NestServiceName;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  logLevel: LogLevel;
  environment: string;
  release?: string;
  sentryDsn?: string;
  otlpEndpoint?: string;
}

/**
 * Parses `env` with `schema`. The error names the invalid variables but never echoes their
 * values (connection strings carry credentials).
 */
export function loadEnv<T extends z.ZodType>(
  label: string,
  schema: T,
  env: NodeJS.ProcessEnv,
): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const invalid = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid ${label} environment: ${invalid.join(', ')}`);
  }
  return result.data;
}

/** Reads and validates the configuration of `service` from `env`, once at startup. */
export function loadServiceConfig(
  service: NestServiceName,
  env: NodeJS.ProcessEnv,
  defaults: { port: number },
): ServiceConfig {
  // An empty variable (`SENTRY_DSN=` in a .env or Compose file) means unset.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = loadEnv(service, ServiceEnvSchema, present);
  return {
    service,
    port: parsed.PORT ?? defaults.port,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    logLevel: parsed.LOG_LEVEL,
    environment: parsed.DEPLOYMENT_ENVIRONMENT,
    ...(parsed.RELEASE !== undefined && { release: parsed.RELEASE }),
    ...(parsed.SENTRY_DSN !== undefined && { sentryDsn: parsed.SENTRY_DSN }),
    ...(parsed.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined && {
      otlpEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT,
    }),
  };
}

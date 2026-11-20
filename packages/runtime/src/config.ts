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

const MailEnvSchema = z.object({
  /**
   * Where email goes (ADR-0022, ADR-0024): an `smtp://` or `smtps://` URL, credentials included
   * if any. Mailpit in development and CI (`smtp://localhost:1025`). Unset: no email is sent.
   * Never logged.
   */
  SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
  /** The sender of the emails, e.g. `Pepper <bookings@pepper.app>`. */
  MAIL_FROM: z.string().trim().min(3).max(200).default('Pepper <bookings@pepper.localhost>'),
});

export interface MailConfig {
  smtpUrl: string;
  from: string;
}

/** Reads `SMTP_URL` and `MAIL_FROM`; `null` when no `SMTP_URL` is set. Never log it. */
export function loadMailConfig(
  service: NestServiceName,
  env: NodeJS.ProcessEnv,
): MailConfig | null {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const mail = loadEnv(service, MailEnvSchema, present);
  return mail.SMTP_URL === undefined ? null : { smtpUrl: mail.SMTP_URL, from: mail.MAIL_FROM };
}

const OutboxEnvSchema = z.object({
  /**
   * Seals queued messages (ADR-0024): their content, which may carry a client's private link,
   * is encrypted with a key derived from it. At least 32 random characters, the same in api
   * and worker. Changing it makes queued messages unreadable (they are given up). Never logged.
   */
  OUTBOX_SECRET: z.string().min(32),
});

/** Reads `OUTBOX_SECRET` (required). Never log it. */
export function loadOutboxSecret(service: NestServiceName, env: NodeJS.ProcessEnv): string {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  return loadEnv(service, OutboxEnvSchema, present).OUTBOX_SECRET;
}

const base64urlBytes = (bytes: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'Expected base64url')
    .refine(
      (value) => Buffer.from(value, 'base64url').length === bytes,
      `Expected ${String(bytes)} bytes`,
    );

const PushEnvSchema = z
  .object({
    /**
     * The VAPID key pair that signs Web Push messages (ADR-0026): base64url, the public key an
     * uncompressed P-256 point (65 bytes), the private key 32 bytes (`npx web-push
     * generate-vapid-keys`). Both or neither; unset: no pushes. The private key is a secret.
     */
    VAPID_PUBLIC_KEY: base64urlBytes(65).optional(),
    VAPID_PRIVATE_KEY: base64urlBytes(32).optional(),
    /** Who push services may contact about our pushes: a `mailto:` or `https:` URL. */
    VAPID_SUBJECT: z
      .string()
      .regex(/^(mailto:\S+@\S+|https:\/\/\S+)$/, 'Use mailto:someone@example.com or an https URL')
      .default('mailto:bookings@pepper.localhost'),
  })
  .refine((env) => (env.VAPID_PUBLIC_KEY === undefined) === (env.VAPID_PRIVATE_KEY === undefined), {
    message: 'Set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or neither',
  });

export interface PushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** Reads the VAPID keys and subject; `null` when no keys are set. Never log the private key. */
export function loadPushConfig(
  service: NestServiceName,
  env: NodeJS.ProcessEnv,
): PushConfig | null {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const push = loadEnv(service, PushEnvSchema, present);
  if (push.VAPID_PUBLIC_KEY === undefined || push.VAPID_PRIVATE_KEY === undefined) return null;
  return {
    publicKey: push.VAPID_PUBLIC_KEY,
    privateKey: push.VAPID_PRIVATE_KEY,
    subject: push.VAPID_SUBJECT,
  };
}

const PushPublicKeyEnvSchema = z.object({ VAPID_PUBLIC_KEY: base64urlBytes(65).optional() });

/**
 * Reads only `VAPID_PUBLIC_KEY` (the api: browsers subscribe with it, and it means pushes are
 * on); `null` when unset. The api never needs the private key.
 */
export function loadPushPublicKey(service: NestServiceName, env: NodeJS.ProcessEnv): string | null {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  return loadEnv(service, PushPublicKeyEnvSchema, present).VAPID_PUBLIC_KEY ?? null;
}

const TWILIO_ACCOUNT_SID = z
  .string()
  .regex(/^AC[0-9a-fA-F]{32}$/, 'Use the AC… account SID Twilio shows');
const TWILIO_AUTH_TOKEN = z
  .string()
  .regex(/^[0-9a-fA-F]{32}$/, 'Use the 32-character auth token Twilio shows');
const TWILIO_SENDER = z
  .string()
  .regex(/^(MG[0-9a-fA-F]{32}|\+1[2-9]\d{9})$/, 'Use an MG… Messaging Service SID or a +1 number');

const SmsEnvSchema = z.object({
  /**
   * Where texts go (S61, ADR-0065 §1): `off` (the default: SMS isn't offered; a text queued
   * anyway retries, then gives up with an alert), `sandbox` (kept in the worker's memory and
   * logged masked; nothing leaves the machine), or `twilio`.
   */
  SMS_PROVIDER: z.enum(['off', 'sandbox', 'twilio']).default('off'),
});

/** With `SMS_PROVIDER=twilio`, every one is required. */
const TwilioEnvSchema = z.object({
  /** The Twilio account (`AC` and 32 hex digits). */
  TWILIO_ACCOUNT_SID,
  /** Its auth token: signs the API calls and Twilio's webhooks. A secret; never logged. */
  TWILIO_AUTH_TOKEN,
  /** What texts are sent from: a Messaging Service (`MG…`, preferred) or a `+1` number. */
  TWILIO_SENDER,
});

export type SmsConfig =
  | { provider: 'sandbox' }
  | { provider: 'twilio'; accountSid: string; authToken: string; sender: string };

/**
 * Reads the SMS settings; `null` when SMS is off. With Twilio, a missing or malformed key stops
 * the process naming it. Never log the result: it carries the auth token.
 */
export function loadSmsConfig(service: NestServiceName, env: NodeJS.ProcessEnv): SmsConfig | null {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const { SMS_PROVIDER } = loadEnv(service, SmsEnvSchema, present);
  if (SMS_PROVIDER === 'off') return null;
  if (SMS_PROVIDER === 'sandbox') return { provider: 'sandbox' };
  const twilio = loadEnv(service, TwilioEnvSchema, present);
  return {
    provider: 'twilio',
    accountSid: twilio.TWILIO_ACCOUNT_SID,
    authToken: twilio.TWILIO_AUTH_TOKEN,
    sender: twilio.TWILIO_SENDER,
  };
}

const PaymentsEnvSchema = z.object({
  /**
   * Where payments go (S65, ADR-0067 §1): `off` (the default: payments aren't offered, every
   * payments route is 404), `sandbox` (accounts kept in Redis; nothing leaves the machine) or
   * `stripe`.
   */
  PAYMENTS_PROVIDER: z.enum(['off', 'sandbox', 'stripe']).default('off'),
});

/** With `PAYMENTS_PROVIDER=stripe`, the key and the webhook secret are required. */
const StripeEnvSchema = z
  .object({
    /** A secret (`sk_…`) or restricted (`rk_…`) key, test or live. A secret; never logged. */
    STRIPE_SECRET_KEY: z
      .string()
      .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,247}$/, 'Use the sk_… or rk_… key Stripe shows'),
    /** The Connect webhook endpoint's signing secret (`whsec_…`). A secret; never logged. */
    STRIPE_WEBHOOK_SECRET: z
      .string()
      .regex(/^whsec_[A-Za-z0-9+/=_-]{16,200}$/, 'Use the whsec_… secret Stripe shows'),
    /**
     * `on` allows a live key (P1-5: once the business entity exists). Off by default, so a live
     * key pasted into a test deployment stops the process instead of moving real money.
     */
    STRIPE_LIVE: z.enum(['on', 'off']).default('off'),
  })
  .superRefine((env, context) => {
    if (/^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY) && env.STRIPE_LIVE !== 'on') {
      context.addIssue({
        code: 'custom',
        path: ['STRIPE_LIVE'],
        message: 'A live key needs STRIPE_LIVE=on',
      });
    }
  });

export type PaymentsConfig =
  | { provider: 'sandbox' }
  | { provider: 'stripe'; secretKey: string; webhookSecret: string; livemode: boolean };

/**
 * Reads the payments settings; `null` when payments are off. With Stripe, a missing or
 * malformed key, or a live key without `STRIPE_LIVE=on`, stops the process naming the variable
 * (never its value). Never log the result: it carries the key.
 */
export function loadPaymentsConfig(
  service: NestServiceName,
  env: NodeJS.ProcessEnv,
): PaymentsConfig | null {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const { PAYMENTS_PROVIDER } = loadEnv(service, PaymentsEnvSchema, present);
  if (PAYMENTS_PROVIDER === 'off') return null;
  if (PAYMENTS_PROVIDER === 'sandbox') return { provider: 'sandbox' };
  const stripe = loadEnv(service, StripeEnvSchema, present);
  return {
    provider: 'stripe',
    secretKey: stripe.STRIPE_SECRET_KEY,
    webhookSecret: stripe.STRIPE_WEBHOOK_SECRET,
    livemode: /^(sk|rk)_live_/.test(stripe.STRIPE_SECRET_KEY),
  };
}

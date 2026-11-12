import { hkdfSync } from 'node:crypto';
import {
  loadEnv,
  loadMailConfig,
  loadOutboxSecret,
  loadPushPublicKey,
  loadServiceConfig,
  loadSmsConfig,
  type MailConfig,
  type ServiceConfig,
} from '@pepper/runtime/instrument';
import { loadOpenAiConfig, type OpenAiConfig } from '@pepper/ai/config';
import { loadStorageConfig, type StorageConfig } from '@pepper/storage';
import { InboundDomainSchema } from '@pepper/contracts';
import { z } from 'zod';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const AuthEnvSchema = z.object({
  /** Signs session cookies and encrypts TOTP secrets. At least 32 characters; never logged. */
  AUTH_SECRET: z.string().min(32),
  /**
   * Public origin of the app the browser talks to (the web app, which forwards `/api/auth/*`
   * and `/v1/*` here). Cookies, CSRF origin checks and the MFA issuer link use it. HTTPS
   * except on this machine.
   */
  AUTH_BASE_URL: z
    .url({ protocol: /^https?$/ })
    .refine((value) => new URL(value).origin === value.replace(/\/$/, ''), 'Use an origin only')
    .refine(
      (value) => value.startsWith('https:') || LOCAL_HOSTS.has(new URL(value).hostname),
      'Use https outside localhost',
    ),
});

const SupportEnvSchema = z.object({
  /**
   * The Pepper team's address for support requests (S59, PCR-010), e.g. `support@pepper.app`.
   * Unset: requests are kept for the console and nothing is emailed.
   */
  SUPPORT_EMAIL: z.email().max(254).optional(),
  /**
   * Where members' emailed replies come back (S59.3, ADR-0063), e.g. `reply.pepper.app`: the
   * signed reply addresses' domain, whose MX points at Resend's inbound. Unset (until S57): no
   * signed `Reply-To`, emails to members answer to `SUPPORT_EMAIL` as before.
   */
  INBOUND_EMAIL_DOMAIN: InboundDomainSchema.optional(),
  /**
   * The Resend webhook's signing secret (`whsec_…`, S59.3). Unset: `POST /v1/webhooks/resend`
   * is 404. A secret; never logged.
   */
  RESEND_WEBHOOK_SECRET: z
    .string()
    .regex(/^whsec_[A-Za-z0-9+/]{20,}={0,2}$/, 'Use the whsec_… secret Resend shows')
    // The key itself: at least 16 bytes, as the webhook checks it (`svixKeyOf`).
    .refine((value) => Buffer.from(value.slice(6), 'base64').length >= 16, 'Too short a key')
    .optional(),
});

const AiEnvSchema = z.object({
  /** A business's monthly allowance of model tokens (ADR-0030); soft limit at 80%. */
  AI_MONTHLY_TOKENS: z.coerce.number().int().min(1).max(1_000_000_000).default(5_000_000),
  /**
   * `e2e`: chat answers from the scripted model of the Playwright journeys (S26, ADR-0031).
   * Only where tests run (`DEPLOYMENT_ENVIRONMENT` `local` or `ci`) and never with an OpenAI key.
   */
  AI_SCRIPTED_PROVIDER: z.literal('e2e').optional(),
});

/**
 * Where the e2e model may run: CI, or a development machine. A production build
 * (`NODE_ENV=production`, the Docker image) needs `DEPLOYMENT_ENVIRONMENT=ci` said explicitly,
 * so a deployment that forgot its environment name (it defaults to `local`) is still refused.
 */
function scriptedAllowed(environment: string, nodeEnv: string | undefined): boolean {
  if (environment === 'ci') return true;
  return environment === 'local' && nodeEnv !== 'production';
}

/** The AI employee (ADR-0027, ADR-0030). */
export interface AiConfig {
  /** `null`: no key, the AI is off; chat answers with its fallback, every screen works. */
  openai: OpenAiConfig | null;
  monthlyTokens: number;
  /** The scripted e2e model instead of a provider (tests only; see `AI_SCRIPTED_PROVIDER`). */
  scripted: boolean;
}

export interface AuthConfig {
  secret: string;
  /** Origin, without a trailing slash. */
  baseUrl: string;
}

/** The api's configuration. Never log it: it carries credentials and the auth secret. */
export interface ApiConfig extends ServiceConfig {
  auth: AuthConfig;
  /** `null`: no email sender configured. */
  mail: MailConfig | null;
  /** HMAC key of the booking page's code hashes, derived from `AUTH_SECRET`. */
  bookingCodeKey: Buffer;
  /** Seals queued messages (ADR-0024); the worker needs the same one. */
  outboxSecret: string;
  /** The public VAPID key (ADR-0026); `null`: no pushes are offered or queued. */
  pushPublicKey: string | null;
  ai: AiConfig;
  /** Object storage for booking page photos (ADR-0048); `null`: photos are off. */
  storage: StorageConfig | null;
  /** The team's support address (`SUPPORT_EMAIL`); `null`: requests are kept, not emailed. */
  supportEmail: string | null;
  /** Replies by email (S59.3, ADR-0063): the signed addresses' domain and the webhook's secret. */
  inbound: { domain: string | null; webhookSecret: string | null };
  /**
   * Twilio's SMS webhooks (S61, ADR-0065): the account and auth token that sign them; `null`
   * unless `SMS_PROVIDER=twilio` (the routes are 404 then).
   */
  smsWebhook: { accountSid: string; authToken: string } | null;
}

/**
 * Reads the api's configuration. Used by `instrument.ts` (before anything else loads) and by
 * `main.ts`, so a missing variable stops the process at once.
 */
export function loadApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const service = loadServiceConfig('api', env, { port: 4000 });
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const auth = loadEnv('api', AuthEnvSchema, present);
  return {
    ...service,
    auth: { secret: auth.AUTH_SECRET, baseUrl: new URL(auth.AUTH_BASE_URL).origin },
    mail: loadMailConfig('api', env),
    bookingCodeKey: deriveKey(auth.AUTH_SECRET, 'pepper/booking-page-codes'),
    outboxSecret: loadOutboxSecret('api', env),
    pushPublicKey: loadPushPublicKey('api', env),
    ai: loadAiConfig(env, present, service.environment),
    storage: loadStorageConfig('api', env),
    ...loadSupport(present),
    smsWebhook: smsWebhookOf(loadSmsConfig('api', env)),
  };
}

function smsWebhookOf(sms: ReturnType<typeof loadSmsConfig>): ApiConfig['smsWebhook'] {
  if (sms?.provider !== 'twilio') return null;
  return { accountSid: sms.accountSid, authToken: sms.authToken };
}

function loadSupport(
  present: Record<string, string | undefined>,
): Pick<ApiConfig, 'supportEmail' | 'inbound'> {
  const support = loadEnv('api', SupportEnvSchema, present);
  return {
    supportEmail: support.SUPPORT_EMAIL ?? null,
    inbound: {
      domain: support.INBOUND_EMAIL_DOMAIN ?? null,
      webhookSecret: support.RESEND_WEBHOOK_SECRET ?? null,
    },
  };
}

function loadAiConfig(
  env: NodeJS.ProcessEnv,
  present: Record<string, string | undefined>,
  environment: string,
): AiConfig {
  const ai = loadEnv('api', AiEnvSchema, present);
  const openai = loadOpenAiConfig(env);
  const scripted = ai.AI_SCRIPTED_PROVIDER === 'e2e';
  // A test switch must never answer real members (S26): refused outside test environments and
  // next to a real provider, so a stray variable stops the process instead of faking the AI.
  if (scripted && (!scriptedAllowed(environment, env['NODE_ENV']) || openai !== null)) {
    throw new Error('Invalid api environment: AI_SCRIPTED_PROVIDER');
  }
  return { openai, monthlyTokens: ai.AI_MONTHLY_TOKENS, scripted };
}

/** A 32-byte key for one purpose, derived from the secret (HKDF-SHA256). */
function deriveKey(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, '', purpose, 32));
}

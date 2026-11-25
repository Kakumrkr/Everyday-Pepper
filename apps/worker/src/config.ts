import {
  loadEnv,
  loadMailConfig,
  loadOutboxSecret,
  loadPushConfig,
  loadServiceConfig,
  loadGoogleCalendarConfig,
  loadPaymentsConfig,
  loadSmsConfig,
  type MailConfig,
  type PushConfig,
  type ServiceConfig,
  type GoogleCalendarConfig,
  type PaymentsConfig,
  type SmsConfig,
} from '@pepper/runtime/instrument';
import { loadOpenAiConfig, type OpenAiConfig } from '@pepper/ai/config';
import { loadStorageConfig, type StorageConfig } from '@pepper/storage';
import { InboundDomainSchema } from '@pepper/contracts';
import { z } from 'zod';

const JobsEnvSchema = z.object({
  /** How often the relay looks for due outbox messages, in milliseconds (ADR-0024). */
  OUTBOX_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  /** How often due reminders are queued (ADR-0025); at most 4 minutes, for AC-W6-1. */
  REMINDER_POLL_MS: z.coerce.number().int().min(1000).max(240_000).default(60_000),
  /** How often the clean-up runs (ADR-0025); it also runs at start-up. */
  CLEANUP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(7 * 86_400_000)
    .default(86_400_000),
  /** How often the insights pass looks for due businesses (ADR-0039). */
  INSIGHTS_POLL_MS: z.coerce.number().int().min(10_000).max(600_000).default(60_000),
  /**
   * The web app's origin (the browser's), for the links in rebooking emails (S36): the booking
   * page and one-click unsubscribe. Unset: no morning drafts.
   */
  AUTH_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  /**
   * How often the morning job (the drafts pass, S36, and the daily briefing, S38a) looks for
   * businesses whose morning has come.
   */
  DRAFTS_POLL_MS: z.coerce.number().int().min(10_000).max(600_000).default(60_000),
  /**
   * How often the smart waitlist's relay looks for freed times (S37); AC-W5-1 allows 2 minutes
   * from the cancellation to the offer.
   */
  WAITLIST_POLL_MS: z.coerce.number().int().min(500).max(60_000).default(5000),
  /** How often the client import relay looks for committed imports (S48, ADR-0049). */
  IMPORT_POLL_MS: z.coerce.number().int().min(500).max(60_000).default(2000),
  /** The team's support address (S59.2.2): the same-day reminders go there; unset, none. */
  SUPPORT_EMAIL: z.email().max(254).optional(),
  /** How often the support job runs (S59.2.2): reminders at 4 h, auto-close at 7 days. */
  SUPPORT_POLL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(300_000),
  /** Replies by email (S59.3, ADR-0063): the signed addresses' domain, as the api's. */
  INBOUND_EMAIL_DOMAIN: InboundDomainSchema.optional(),
  /**
   * The receiving server's authserv-id in `Authentication-Results` (S59.3), e.g.
   * `amazonses.com`: only its verdict on a sender counts. Unset: every reply is held.
   */
  INBOUND_AUTHSERV_ID: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]{3,200}$/)
    .optional(),
  /** Resend's API key, to fetch received emails (S59.3). A secret; never logged. */
  RESEND_API_KEY: z
    .string()
    .regex(/^re_[A-Za-z0-9_]{8,200}$/, 'Use the re_… key Resend shows')
    .optional(),
  /** How often the inbound job looks for received emails (S59.3: a reply lands in a minute). */
  INBOUND_POLL_MS: z.coerce.number().int().min(1000).max(300_000).default(15_000),
  /** How often the calendar job looks for calendars due a read (S70: each every 5 minutes). */
  CALENDAR_POLL_MS: z.coerce.number().int().min(1000).max(300_000).default(60_000),
  /** A business's monthly allowance of model tokens, as the api's (episodes count, S31). */
  AI_MONTHLY_TOKENS: z.coerce.number().int().min(1).max(1_000_000_000).default(5_000_000),
});

/** The worker's configuration. Never log it: it carries credentials and the outbox secret. */
export interface WorkerConfig extends ServiceConfig {
  /** `null`: no email sender configured; queued emails wait until there is one. */
  mail: MailConfig | null;
  /**
   * The photos' object store (ADR-0048), to delete a business's images before the business
   * (S51.2, ADR-0054); `null`: none, so a business with photos waits for one.
   */
  storage: StorageConfig | null;
  /** `null`: no VAPID keys, so pushes are not sent (the api then queues none, ADR-0026). */
  push: PushConfig | null;
  /**
   * Texts (S61, ADR-0065): Twilio or the sandbox; `null` with SMS off, so a queued text retries
   * and then gives up with an alert, as a push does without VAPID keys (callers check first).
   */
  sms: SmsConfig | null;
  /**
   * Payments (S66, ADR-0068): the deposits' captures, refunds and sweep, with the api's provider;
   * `null` while off. The sandbox only where tests may run, as the api's.
   */
  payments: PaymentsConfig | null;
  /**
   * Google Calendar (S70, ADR-0069): the read of staff members' busy times, with the api's
   * provider; `null` while off. The sandbox only where tests may run, as the api's.
   */
  googleCalendar: { settings: GoogleCalendarConfig; baseUrl: string; pollMs: number } | null;
  /**
   * The sandbox's sent texts kept in Redis for tests (S63, AC-X-87): `SMS_PROVIDER=sandbox` in
   * CI, or on a development machine (never a production build that forgot its environment).
   */
  smsSandboxLog: boolean;
  /**
   * The web app's origin (`AUTH_BASE_URL`), where Twilio reports each text's delivery; `null`
   * without it, or without Twilio (the sandbox reports nothing).
   */
  smsStatusBaseUrl: string | null;
  /** Opens the messages the api sealed (ADR-0024); the same as the api's. */
  outboxSecret: string;
  outboxPollMs: number;
  reminderPollMs: number;
  cleanupIntervalMs: number;
  insightsPollMs: number;
  /** How often the morning job runs (`DRAFTS_POLL_MS`, S38a). */
  morningPollMs: number;
  /**
   * Writes episodes (S31, ADR-0037) with the routine model and the embedding model; `null`
   * when OpenAI or its embedding model is not configured (then the api queues none).
   */
  episodes: { openai: OpenAiConfig & { embeddingModel: string }; monthlyTokens: number } | null;
  /**
   * The morning drafts pass (S36, ADR-0040): the routine model writes rebooking emails for
   * owners to approve, and review requests are drafted in the domain's words (S55.2); `null`
   * without `AUTH_BASE_URL`. Without OpenAI (`openai: null`, S56a) only the review requests run.
   */
  drafts: {
    openai: OpenAiConfig | null;
    monthlyTokens: number;
    baseUrl: string;
    pollMs: number;
  } | null;
  /**
   * The smart waitlist (S37, ADR-0041): freed times offered to who is waiting, with claim links
   * to the web app; `null` when `AUTH_BASE_URL` is not configured (no offers are made then).
   */
  waitlist: { baseUrl: string; pollMs: number } | null;
  /** How often committed client imports are looked for (S48, ADR-0049). */
  importPollMs: number;
  /** The support job (S59.2.2): the team's address and the web origin for links. */
  support: {
    supportEmail: string | null;
    baseUrl: string | null;
    pollMs: number;
    /** `INBOUND_EMAIL_DOMAIN` (S59.3): the close email carries the signed reply address. */
    inboundDomain: string | null;
  };
  /**
   * The inbound job (S59.3, ADR-0063); `null` until `INBOUND_EMAIL_DOMAIN`, `RESEND_API_KEY` and
   * `AUTH_BASE_URL` are all set (S57).
   */
  inbound: {
    domain: string;
    authservId: string | null;
    resendApiKey: string;
    baseUrl: string;
    pollMs: number;
  } | null;
}

/**
 * Reads the worker's configuration. Used by `instrument.ts` (before anything else loads) and
 * by `main.ts`, so a missing variable stops the process at once.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const service = loadServiceConfig('worker', env, { port: 4100 });
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const jobs = loadEnv('worker', JobsEnvSchema, present);
  const sms = loadSmsConfig('worker', env);
  return {
    ...service,
    mail: loadMailConfig('worker', env),
    storage: loadStorageConfig('worker', env),
    push: loadPushConfig('worker', env),
    sms,
    payments: paymentsOf(
      loadPaymentsConfig('worker', env),
      testsMayRun(service.environment, env['NODE_ENV']),
    ),
    googleCalendar: googleCalendarOf(
      loadGoogleCalendarConfig('worker', env),
      testsMayRun(service.environment, env['NODE_ENV']),
      jobs,
    ),
    smsSandboxLog: sms?.provider === 'sandbox' && testsMayRun(service.environment, env['NODE_ENV']),
    smsStatusBaseUrl:
      sms?.provider === 'twilio' && jobs.AUTH_BASE_URL !== undefined
        ? new URL(jobs.AUTH_BASE_URL).origin
        : null,
    outboxSecret: loadOutboxSecret('worker', env),
    outboxPollMs: jobs.OUTBOX_POLL_MS,
    reminderPollMs: jobs.REMINDER_POLL_MS,
    cleanupIntervalMs: jobs.CLEANUP_INTERVAL_MS,
    insightsPollMs: jobs.INSIGHTS_POLL_MS,
    morningPollMs: jobs.DRAFTS_POLL_MS,
    importPollMs: jobs.IMPORT_POLL_MS,
    support: {
      supportEmail: jobs.SUPPORT_EMAIL ?? null,
      baseUrl: jobs.AUTH_BASE_URL === undefined ? null : new URL(jobs.AUTH_BASE_URL).origin,
      pollMs: jobs.SUPPORT_POLL_MS,
      inboundDomain: jobs.INBOUND_EMAIL_DOMAIN ?? null,
    },
    inbound:
      jobs.INBOUND_EMAIL_DOMAIN === undefined ||
      jobs.RESEND_API_KEY === undefined ||
      jobs.AUTH_BASE_URL === undefined
        ? null
        : {
            domain: jobs.INBOUND_EMAIL_DOMAIN,
            authservId: jobs.INBOUND_AUTHSERV_ID ?? null,
            resendApiKey: jobs.RESEND_API_KEY,
            baseUrl: new URL(jobs.AUTH_BASE_URL).origin,
            pollMs: jobs.INBOUND_POLL_MS,
          },
    episodes: episodesConfig(loadOpenAiConfig(env), jobs.AI_MONTHLY_TOKENS),
    drafts: draftsConfig(loadOpenAiConfig(env), jobs),
    waitlist:
      jobs.AUTH_BASE_URL === undefined
        ? null
        : { baseUrl: new URL(jobs.AUTH_BASE_URL).origin, pollMs: jobs.WAITLIST_POLL_MS },
  };
}

/** Off, or the sandbox where tests may not run, reads nothing (AC-X-158). */
function googleCalendarOf(
  settings: GoogleCalendarConfig | null,
  testsMay: boolean,
  jobs: { AUTH_BASE_URL?: string | undefined; CALENDAR_POLL_MS: number },
): WorkerConfig['googleCalendar'] {
  if (settings === null || (settings.provider === 'sandbox' && !testsMay)) return null;
  return {
    settings,
    // Google's return page is the api's concern; the worker only refreshes and reads.
    baseUrl: new URL(jobs.AUTH_BASE_URL ?? 'http://localhost').origin,
    pollMs: jobs.CALENDAR_POLL_MS,
  };
}

function paymentsOf(payments: PaymentsConfig | null, testsMay: boolean): PaymentsConfig | null {
  if (payments?.provider === 'sandbox' && !testsMay) return null;
  return payments;
}

function episodesConfig(
  openai: OpenAiConfig | null,
  monthlyTokens: number,
): WorkerConfig['episodes'] {
  const embeddingModel = openai?.embeddingModel;
  if (openai === null || embeddingModel === undefined) return null;
  return { openai: { ...openai, embeddingModel }, monthlyTokens };
}

function draftsConfig(
  openai: OpenAiConfig | null,
  jobs: z.infer<typeof JobsEnvSchema>,
): WorkerConfig['drafts'] {
  if (jobs.AUTH_BASE_URL === undefined) return null;
  return {
    openai,
    monthlyTokens: jobs.AI_MONTHLY_TOKENS,
    baseUrl: new URL(jobs.AUTH_BASE_URL).origin,
    pollMs: jobs.DRAFTS_POLL_MS,
  };
}

/** Where tests run: CI, or a development machine (as the api's scripted model, S26). */
function testsMayRun(environment: string, nodeEnv: string | undefined): boolean {
  if (environment === 'ci') return true;
  return environment === 'local' && nodeEnv !== 'production';
}

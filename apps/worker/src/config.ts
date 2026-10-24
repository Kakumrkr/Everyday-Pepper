import {
  loadEnv,
  loadMailConfig,
  loadOutboxSecret,
  loadPushConfig,
  loadServiceConfig,
  type MailConfig,
  type PushConfig,
  type ServiceConfig,
} from '@pepper/runtime/instrument';
import { loadOpenAiConfig, type OpenAiConfig } from '@pepper/ai/config';
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
  /** How often the morning drafts pass looks for businesses whose morning has come (S36). */
  DRAFTS_POLL_MS: z.coerce.number().int().min(10_000).max(600_000).default(60_000),
  /**
   * How often the smart waitlist's relay looks for freed times (S37); AC-W5-1 allows 2 minutes
   * from the cancellation to the offer.
   */
  WAITLIST_POLL_MS: z.coerce.number().int().min(500).max(60_000).default(5000),
  /** A business's monthly allowance of model tokens, as the api's (episodes count, S31). */
  AI_MONTHLY_TOKENS: z.coerce.number().int().min(1).max(1_000_000_000).default(5_000_000),
});

/** The worker's configuration. Never log it: it carries credentials and the outbox secret. */
export interface WorkerConfig extends ServiceConfig {
  /** `null`: no email sender configured; queued emails wait until there is one. */
  mail: MailConfig | null;
  /** `null`: no VAPID keys, so pushes are not sent (the api then queues none, ADR-0026). */
  push: PushConfig | null;
  /** Opens the messages the api sealed (ADR-0024); the same as the api's. */
  outboxSecret: string;
  outboxPollMs: number;
  reminderPollMs: number;
  cleanupIntervalMs: number;
  insightsPollMs: number;
  /**
   * Writes episodes (S31, ADR-0037) with the routine model and the embedding model; `null`
   * when OpenAI or its embedding model is not configured (then the api queues none).
   */
  episodes: { openai: OpenAiConfig & { embeddingModel: string }; monthlyTokens: number } | null;
  /**
   * The morning drafts pass (S36, ADR-0040): the routine model writes rebooking emails for
   * owners to approve; `null` when OpenAI or `AUTH_BASE_URL` is not configured.
   */
  drafts: { openai: OpenAiConfig; monthlyTokens: number; baseUrl: string; pollMs: number } | null;
  /**
   * The smart waitlist (S37, ADR-0041): freed times offered to who is waiting, with claim links
   * to the web app; `null` when `AUTH_BASE_URL` is not configured (no offers are made then).
   */
  waitlist: { baseUrl: string; pollMs: number } | null;
}

/**
 * Reads the worker's configuration. Used by `instrument.ts` (before anything else loads) and
 * by `main.ts`, so a missing variable stops the process at once.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const service = loadServiceConfig('worker', env, { port: 4100 });
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const jobs = loadEnv('worker', JobsEnvSchema, present);
  return {
    ...service,
    mail: loadMailConfig('worker', env),
    push: loadPushConfig('worker', env),
    outboxSecret: loadOutboxSecret('worker', env),
    outboxPollMs: jobs.OUTBOX_POLL_MS,
    reminderPollMs: jobs.REMINDER_POLL_MS,
    cleanupIntervalMs: jobs.CLEANUP_INTERVAL_MS,
    insightsPollMs: jobs.INSIGHTS_POLL_MS,
    episodes: episodesConfig(loadOpenAiConfig(env), jobs.AI_MONTHLY_TOKENS),
    drafts: draftsConfig(loadOpenAiConfig(env), jobs),
    waitlist:
      jobs.AUTH_BASE_URL === undefined
        ? null
        : { baseUrl: new URL(jobs.AUTH_BASE_URL).origin, pollMs: jobs.WAITLIST_POLL_MS },
  };
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
  if (openai === null || jobs.AUTH_BASE_URL === undefined) return null;
  return {
    openai,
    monthlyTokens: jobs.AI_MONTHLY_TOKENS,
    baseUrl: new URL(jobs.AUTH_BASE_URL).origin,
    pollMs: jobs.DRAFTS_POLL_MS,
  };
}

import {
  loadEnv,
  loadMailConfig,
  loadOutboxSecret,
  loadServiceConfig,
  type MailConfig,
  type ServiceConfig,
} from '@pepper/runtime/instrument';
import { z } from 'zod';

const OutboxEnvSchema = z.object({
  /** How often the relay looks for due outbox messages, in milliseconds (ADR-0024). */
  OUTBOX_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
});

/** The worker's configuration. Never log it: it carries credentials and the outbox secret. */
export interface WorkerConfig extends ServiceConfig {
  /** `null`: no email sender configured; queued emails wait until there is one. */
  mail: MailConfig | null;
  /** Opens the messages the api sealed (ADR-0024); the same as the api's. */
  outboxSecret: string;
  outboxPollMs: number;
}

/**
 * Reads the worker's configuration. Used by `instrument.ts` (before anything else loads) and
 * by `main.ts`, so a missing variable stops the process at once.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const service = loadServiceConfig('worker', env, { port: 4100 });
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const outbox = loadEnv('worker', OutboxEnvSchema, present);
  return {
    ...service,
    mail: loadMailConfig('worker', env),
    outboxSecret: loadOutboxSecret('worker', env),
    outboxPollMs: outbox.OUTBOX_POLL_MS,
  };
}

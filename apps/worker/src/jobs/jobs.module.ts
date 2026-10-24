import {
  Inject,
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { runDueInsights, sendDueReminders } from '@pepper/appointments';
import { cleanUp, sendDueTaskPushes, systemClock, type Clock } from '@pepper/core';
import type { Database } from '@pepper/db';
import { DATABASE } from '@pepper/runtime';
import { templateInsights } from '@pepper/templates';
import { morningDraftsJob, type DraftsJobConfig } from './drafts.js';
import { Periodic } from './periodic.js';

export interface JobsOptions {
  /** Seals the reminder emails it queues (`outboxKeyFrom(OUTBOX_SECRET)`). */
  key: Buffer;
  /** How often due reminders are queued (AC-W6-1: well under 5 minutes). */
  reminderPollMs: number;
  /** How often the clean-up runs; it also runs at start-up. */
  cleanupIntervalMs: number;
  /**
   * How often the insights pass looks for businesses whose feed is due (ADR-0039): an hour
   * after their last run, or after a booking change. Default: every minute.
   */
  insightsPollMs?: number;
  /**
   * The morning drafts pass (S36, ADR-0040), every `pollMs`; absent when OpenAI or the web
   * origin is not configured (no rebooking emails are drafted then).
   */
  drafts?: (DraftsJobConfig & { pollMs: number }) | null;
  /**
   * Whether this worker sends pushes (VAPID keys set, ADR-0026); the due-task job runs, on
   * the reminders' interval, only then.
   */
  pushes?: boolean;
  clock?: Clock;
}

export const JOBS_OPTIONS = Symbol('JOBS_OPTIONS');

/**
 * The worker's scheduled jobs (ADR-0025), driven by Postgres rather than Redis, so restarting
 * either loses nothing: every `reminderPollMs` due reminders are queued in the outbox (which
 * sends them), and so are the pushes of to-dos coming due (ADR-0026, when pushes are on); every
 * `cleanupIntervalMs` old rows are deleted. Several worker processes may run them at once: a
 * reminder or due task is taken under a row lock, and deleting is idempotent. Every
 * `insightsPollMs` the feed of each business that is due is computed again (ADR-0039); a
 * business is taken under an advisory lock, and the feed is written by dedupe key.
 */
@Injectable()
export class JobsRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobsRunner.name);
  readonly reminders: Periodic;
  readonly dueTasks: Periodic | null;
  readonly cleanup: Periodic;
  readonly insights: Periodic;
  readonly drafts: Periodic | null;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(JOBS_OPTIONS) options: JobsOptions,
  ) {
    const { db } = database;
    const clock = options.clock ?? systemClock;
    this.reminders = new Periodic(
      'Reminder job',
      options.reminderPollMs,
      () => sendDueReminders(db, { key: options.key, clock }),
      this.logger,
    );
    this.dueTasks =
      options.pushes === true
        ? new Periodic(
            'Due-task job',
            options.reminderPollMs,
            () => sendDueTaskPushes(db, { key: options.key, clock }),
            this.logger,
          )
        : null;
    this.insights = new Periodic(
      'Insights job',
      options.insightsPollMs ?? 60_000,
      async () => {
        const result = await runDueInsights(db, { clock, insightsOf: templateInsights });
        // Counts only.
        if (result.businesses > 0) {
          this.logger.log(
            `Insights: ${String(result.businesses)} businesses, ${String(result.created)} new, ${String(result.updated)} updated, ${String(result.expired)} expired`,
          );
        }
      },
      this.logger,
    );
    const drafts = options.drafts ?? null;
    const runDrafts =
      drafts === null ? null : morningDraftsJob(db, drafts, { outboxKey: options.key, clock });
    this.drafts =
      drafts === null || runDrafts === null
        ? null
        : new Periodic(
            'Morning drafts job',
            drafts.pollMs,
            async () => {
              const result = await runDrafts();
              // Counts only.
              if (result.businesses > 0) {
                this.logger.log(
                  `Morning drafts: ${String(result.businesses)} businesses, ${String(result.drafted)} drafted`,
                );
              }
            },
            this.logger,
          );
    this.cleanup = new Periodic(
      'Clean-up job',
      options.cleanupIntervalMs,
      async () => {
        const result = await cleanUp(db, { clock });
        // Counts only.
        this.logger.log(
          `Clean-up: ${String(result.bookingRequests)} booking requests, ${String(result.outboxMessages)} outbox messages, ${String(result.expiredProposals)} expired AI proposals, ${String(result.conversations)} idle conversations in ${String(result.businesses)} businesses`,
        );
      },
      this.logger,
    );
  }

  onApplicationBootstrap(): void {
    this.reminders.start();
    this.dueTasks?.start();
    this.insights.start();
    this.drafts?.start();
    this.cleanup.start({ immediately: true });
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([
      this.reminders.stop(),
      this.dueTasks?.stop(),
      this.insights.stop(),
      this.drafts?.stop(),
      this.cleanup.stop(),
    ]);
  }
}

/** The reminder, due-task, insights, morning drafts and clean-up jobs. Needs `ConnectionsModule`. */
@Module({})
export class JobsModule {
  static forRoot(options: JobsOptions): DynamicModule {
    return {
      module: JobsModule,
      providers: [{ provide: JOBS_OPTIONS, useValue: options }, JobsRunner],
      exports: [JobsRunner],
    };
  }
}

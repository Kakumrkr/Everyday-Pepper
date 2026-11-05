import {
  Inject,
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  deleteAllPhotoImages,
  runDueBriefings,
  runDueInsights,
  sendDueReminders,
} from '@pepper/appointments';
import { cleanUp, runDueDeletions, sendDueTaskPushes, systemClock, type Clock } from '@pepper/core';
import type { Database } from '@pepper/db';
import { DATABASE } from '@pepper/runtime';
import type { ObjectStore } from '@pepper/storage';
import { templateDrafts, templateInsights } from '@pepper/templates';
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
   * How often the morning job looks for businesses whose morning hour has come (S38a): the
   * drafts pass, when configured, then the daily briefing. Default: the drafts' `pollMs`, else
   * every minute.
   */
  morningPollMs?: number;
  /**
   * Whether this worker sends pushes (VAPID keys set, ADR-0026); the due-task job runs, on
   * the reminders' interval, only then.
   */
  pushes?: boolean;
  /**
   * How often businesses and accounts past their 30 days are deleted (S51.2, ADR-0054); it
   * also runs at start-up. Default: every hour.
   */
  deletionPollMs?: number;
  /** The photos' store, whose images go before their business; `null`: none configured. */
  objectStore?: ObjectStore | null;
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
 * business is taken under an advisory lock, and the feed is written by dedupe key. The morning
 * job drafts and briefs each business once a day at its local morning hour (S36, S38a), each
 * pass claimed by a conditional update.
 */
@Injectable()
export class JobsRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobsRunner.name);
  readonly reminders: Periodic;
  readonly dueTasks: Periodic | null;
  readonly cleanup: Periodic;
  readonly deletions: Periodic;
  readonly insights: Periodic;
  readonly morning: Periodic;

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
    // One job, in order: this morning's drafts first, so the briefing counts them (S38a).
    this.morning = new Periodic(
      'Morning job',
      options.morningPollMs ?? drafts?.pollMs ?? 60_000,
      async () => {
        // A failing drafts pass never holds back the briefing, which needs no model.
        const result =
          runDrafts === null
            ? null
            : await runDrafts().catch((error: unknown) => {
                this.logger.warn(
                  `Morning drafts failed: ${error instanceof Error ? error.name : 'Error'}`,
                );
                return null;
              });
        if (result !== null) {
          // Counts only.
          if (result.businesses > 0) {
            this.logger.log(
              `Morning drafts: ${String(result.businesses)} businesses, ${String(result.drafted)} drafted, ${String(result.reviewRequests)} review requests`,
            );
          }
          // Not a refusal: a model call or a proposal broke (the next morning tries again).
          if (result.failed > 0) {
            this.logger.warn(`Morning drafts: ${String(result.failed)} failed`);
          }
        }
        const briefed = await runDueBriefings(db, {
          clock,
          insightsOf: templateInsights,
          morningHourOf: (templateId) => templateDrafts(templateId).morningHour,
          pushKey: options.pushes === true ? options.key : null,
        });
        if (briefed.businesses > 0) {
          this.logger.log(
            `Daily briefing: ${String(briefed.businesses)} businesses, ${String(briefed.pushes)} pushes`,
          );
        }
        if (briefed.failed > 0) {
          this.logger.warn(`Daily briefing: ${String(briefed.failed)} failed`);
        }
      },
      this.logger,
    );
    const store = options.objectStore ?? null;
    this.deletions = new Periodic(
      'Deletion job',
      options.deletionPollMs ?? 60 * 60_000,
      async () => {
        const result = await runDueDeletions(db, {
          clock,
          beforeBusinessDeleted: async (tenantId) => {
            await deleteAllPhotoImages(db, tenantId, store);
          },
        });
        // Counts only: never a business's or an account's id or name.
        if (result.businesses > 0 || result.accounts > 0) {
          this.logger.log(
            `Deletion: ${String(result.businesses)} businesses, ${String(result.accounts)} accounts deleted`,
          );
        }
        if (result.deferred > 0) {
          this.logger.warn(`Deletion: ${String(result.deferred)} due, left for the next pass`);
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
    this.deletions.start({ immediately: true });
    this.reminders.start();
    this.dueTasks?.start();
    this.insights.start();
    this.morning.start();
    this.cleanup.start({ immediately: true });
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([
      this.reminders.stop(),
      this.dueTasks?.stop(),
      this.insights.stop(),
      this.morning.stop(),
      this.cleanup.stop(),
      this.deletions.stop(),
    ]);
  }
}

/** The reminder, due-task, insights, morning (drafts, briefing), clean-up and deletion jobs. Needs `ConnectionsModule`. */
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

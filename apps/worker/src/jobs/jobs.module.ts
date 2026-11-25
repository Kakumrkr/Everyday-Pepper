import {
  Inject,
  Injectable,
  Logger,
  Module,
  Optional,
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
import {
  calendarTokenKeyFrom,
  runDueCalendarReads,
  type CalendarProvider,
} from '@pepper/google-calendar';
import {
  cleanUp,
  runDueDeletions,
  runSupportHousekeeping,
  deleteAllSupportScreenshotImages,
  sendDueTaskPushes,
  systemClock,
  processInboundEmails,
  type Clock,
  type InboundMailSource,
  type Mailer,
} from '@pepper/core';
import type { Database } from '@pepper/db';
import { DATABASE, MAILER } from '@pepper/runtime';
import { createScreenshotStore, type ObjectStore } from '@pepper/storage';
import { templateDrafts, templateInsights } from '@pepper/templates';
import { morningDraftsJob, type DraftsJobConfig } from './drafts.js';
import { Periodic } from './periodic.js';

export interface JobsOptions {
  /**
   * The calendar job (S70, ADR-0069 §7): staff members' Google busy times read every 5 minutes,
   * each due calendar looked for every `pollMs`; absent or `null`: Google Calendar is off.
   */
  calendar?: { provider: CalendarProvider; pollMs: number } | null;
  /** Seals the reminder emails it queues (`outboxKeyFrom(OUTBOX_SECRET)`). */
  key: Buffer;
  /** How often due reminders are queued (AC-W6-1: well under 5 minutes). */
  reminderPollMs: number;
  /**
   * Reminders by text and their links (S62): the web app's origin for the reschedule link
   * (`null`: none), and whether this worker sends texts (`SMS_PROVIDER` set).
   */
  reminders?: { baseUrl: string | null; texts: boolean };
  /** How often the clean-up runs; it also runs at start-up. */
  cleanupIntervalMs: number;
  /**
   * How often the insights pass looks for businesses whose feed is due (ADR-0039): an hour
   * after their last run, or after a booking change. Default: every minute.
   */
  insightsPollMs?: number;
  /**
   * The morning drafts pass (S36, ADR-0040), every `pollMs`; absent without the web origin.
   * Without OpenAI (`openai: null`, S56a) it drafts only the review requests.
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
  /**
   * The support job (S59.2.2, ADR-0062): the same-day reminder to the team's address and the
   * 7-day auto-close. `supportEmail` `null`: nothing is reminded; `baseUrl` `null`: no links.
   */
  support?: {
    supportEmail: string | null;
    baseUrl: string | null;
    pollMs: number;
    /** Where members' emailed replies come back (S59.3); the close email's `Reply-To`. */
    inboundDomain?: string | null;
  };
  /**
   * The inbound job (S59.3, ADR-0063): emailed replies fetched from the provider and landed in
   * their threads, every `pollMs`; absent or `null`: off (until S57 sets it up).
   */
  inbound?: {
    domain: string;
    authservId: string | null;
    source: InboundMailSource;
    baseUrl: string;
    release: string;
    pollMs: number;
  } | null;
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
  readonly support: Periodic;
  readonly inbound: Periodic | null;
  readonly calendar: Periodic | null;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(JOBS_OPTIONS) options: JobsOptions,
    @Optional() @Inject(MAILER) mailer: Mailer | null = null,
  ) {
    const { db } = database;
    const clock = options.clock ?? systemClock;
    this.reminders = new Periodic(
      'Reminder job',
      options.reminderPollMs,
      () =>
        sendDueReminders(db, {
          key: options.key,
          clock,
          baseUrl: options.reminders?.baseUrl ?? null,
          texts: options.reminders?.texts ?? false,
        }),
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
    const support = options.support ?? { supportEmail: null, baseUrl: null, pollMs: 5 * 60_000 };
    // Support screenshots on the same store as photos (S59.2.3, ADR-0062 Part 3).
    const screenshots =
      options.objectStore === undefined || options.objectStore === null
        ? null
        : createScreenshotStore(options.objectStore);
    this.support = new Periodic(
      'Support job',
      support.pollMs,
      async () => {
        const result = await runSupportHousekeeping(db, {
          outboxKey: options.key,
          supportEmail: support.supportEmail,
          inboundDomain: support.inboundDomain ?? null,
          baseUrl: support.baseUrl,
          mailer,
          clock,
          store: screenshots,
        });
        // Counts only: never a request's reference or a business.
        if (result.closed > 0 || result.reminded > 0 || result.swept > 0) {
          this.logger.log(
            `Support: ${String(result.reminded)} reminders, ${String(result.closed)} closed after quiet days, ${String(result.swept)} unsent screenshots swept`,
          );
        }
        if (result.failed > 0) this.logger.warn(`Support: ${String(result.failed)} failed`);
      },
      this.logger,
    );
    const inbound = options.inbound ?? null;
    this.inbound =
      inbound === null
        ? null
        : new Periodic(
            'Inbound email job',
            inbound.pollMs,
            async () => {
              const result = await processInboundEmails(db, {
                outboxKey: options.key,
                supportEmail: support.supportEmail,
                baseUrl: inbound.baseUrl,
                release: inbound.release,
                inboundDomain: inbound.domain,
                authservId: inbound.authservId,
                source: inbound.source,
                store: screenshots,
                mailer,
                clock,
              });
              // Counts only: never an address, a subject or a request.
              const handled =
                result.landed + result.held + result.ignored + result.refused + result.failed;
              if (handled > 0) {
                this.logger.log(
                  `Inbound email: ${String(result.landed)} landed, ${String(result.held)} held, ${String(result.ignored)} ignored, ${String(result.refused)} refused, ${String(result.failed)} failed`,
                );
              }
              if (result.retried > 0) {
                // Error names only (never a message, which may echo an address).
                this.logger.warn(
                  `Inbound email: ${String(result.retried)} left for a retry (${result.errors.join(', ')})`,
                );
              }
            },
            this.logger,
          );
    const calendar = options.calendar ?? null;
    this.calendar =
      calendar === null
        ? null
        : new Periodic(
            'Calendar job',
            calendar.pollMs,
            async () => {
              const result = await runDueCalendarReads({
                db,
                clock,
                provider: calendar.provider,
                tokenKey: calendarTokenKeyFrom(options.key),
              });
              // Counts only: never a calendar, an account or a busy time.
              if (result.read > 0) this.logger.log(`Calendar: ${String(result.read)} read`);
              if (result.failed > 0 || result.needsReconnect > 0) {
                this.logger.warn(
                  `Calendar: ${String(result.failed)} failed, ${String(result.needsReconnect)} need reconnecting`,
                );
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
            await deleteAllSupportScreenshotImages(db, tenantId, screenshots);
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
    this.support.start();
    this.inbound?.start();
    this.calendar?.start();
    this.cleanup.start({ immediately: true });
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([
      this.reminders.stop(),
      this.dueTasks?.stop(),
      this.insights.stop(),
      this.morning.stop(),
      this.support.stop(),
      this.inbound?.stop(),
      this.calendar?.stop(),
      this.cleanup.stop(),
      this.deletions.stop(),
    ]);
  }
}

/**
 * The reminder, due-task, insights, morning (drafts, briefing), support, inbound email,
 * calendar, clean-up and deletion jobs. Needs `ConnectionsModule`; `MailModule` for the public requests' reminders.
 */
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

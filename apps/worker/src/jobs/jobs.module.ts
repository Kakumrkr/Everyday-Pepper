import {
  Inject,
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { sendDueReminders } from '@pepper/appointments';
import { cleanUp, systemClock, type Clock } from '@pepper/core';
import type { Database } from '@pepper/db';
import { DATABASE } from '@pepper/runtime';
import { Periodic } from './periodic.js';

export interface JobsOptions {
  /** Seals the reminder emails it queues (`outboxKeyFrom(OUTBOX_SECRET)`). */
  key: Buffer;
  /** How often due reminders are queued (AC-W6-1: well under 5 minutes). */
  reminderPollMs: number;
  /** How often the clean-up runs; it also runs at start-up. */
  cleanupIntervalMs: number;
  clock?: Clock;
}

export const JOBS_OPTIONS = Symbol('JOBS_OPTIONS');

/**
 * The worker's scheduled jobs (ADR-0025), driven by Postgres rather than Redis, so restarting
 * either loses nothing: every `reminderPollMs` due reminders are queued in the outbox (which
 * sends them), and every `cleanupIntervalMs` old rows are deleted. Several worker processes
 * may run them at once: a reminder is taken under a row lock, and deleting is idempotent.
 */
@Injectable()
export class JobsRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobsRunner.name);
  readonly reminders: Periodic;
  readonly cleanup: Periodic;

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
    this.cleanup = new Periodic(
      'Clean-up job',
      options.cleanupIntervalMs,
      async () => {
        const result = await cleanUp(db, { clock });
        // Counts only.
        this.logger.log(
          `Clean-up: ${String(result.bookingRequests)} booking requests, ${String(result.outboxMessages)} outbox messages in ${String(result.businesses)} businesses`,
        );
      },
      this.logger,
    );
  }

  onApplicationBootstrap(): void {
    this.reminders.start();
    this.cleanup.start({ immediately: true });
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.reminders.stop(), this.cleanup.stop()]);
  }
}

/** The reminder and clean-up jobs. Needs `ConnectionsModule`. */
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

import {
  Inject,
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { runWaitlistMatch, type MatchResult } from '@pepper/ai';
import type { TemplateId } from '@pepper/contracts';
import { systemClock, type Clock } from '@pepper/core';
import type { Database } from '@pepper/db';
import { DATABASE, raiseAlert } from '@pepper/runtime';
import { getTemplate, templateRuleDefaults, templateWaitlist } from '@pepper/templates';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { MatchJobSchema, relayDueMatches, WAITLIST_QUEUE } from './relay.js';

export interface WaitlistOptions {
  redisUrl: string;
  /** Seals the offer emails it queues (`outboxKeyFrom(OUTBOX_SECRET)`). */
  key: Buffer;
  /** The web app's origin, for the claim links. */
  baseUrl: string;
  /** How often the relay looks for freed times (a few seconds: AC-W5-1 allows 2 minutes). */
  pollMs: number;
  concurrency?: number;
  clock?: Clock;
}

export const WAITLIST_OPTIONS = Symbol('WAITLIST_OPTIONS');

/**
 * Runs the smart waitlist in the worker (S37, ADR-0041, AC-W5-1): a relay that polls Postgres
 * for freed times and queues them in BullMQ, and a BullMQ worker that matches each one
 * (`runWaitlistMatch`: ranks who is waiting and offers the time through the trust layer, per
 * the dial). Several workers may run it: a match is claimed for a lease before it runs.
 */
@Injectable()
export class WaitlistRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WaitlistRunner.name);
  private readonly db: Database;
  private connection: Redis | undefined;
  private queue: Queue | undefined;
  private worker: Worker | undefined;
  private timer: NodeJS.Timeout | undefined;
  private relaying = false;
  private relayFailing = false;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(WAITLIST_OPTIONS) private readonly options: WaitlistOptions,
  ) {
    this.db = database.db;
  }

  onApplicationBootstrap(): void {
    // BullMQ's blocking commands need unlimited retries per request.
    const connection = new Redis(this.options.redisUrl, { maxRetriesPerRequest: null });
    connection.on('error', () => undefined); // Reported by readiness; BullMQ reconnects.
    this.connection = connection;
    this.queue = new Queue(WAITLIST_QUEUE, { connection });
    const clock = this.options.clock ?? systemClock;
    const matcher = {
      clock,
      waitlistOf: templateWaitlist,
      autonomyOf: (id: TemplateId | null) => (id === null ? {} : getTemplate(id).defaultAutonomy),
      templateRuleDefaults,
      emails: { baseUrl: this.options.baseUrl, outboxKey: this.options.key },
    };
    this.worker = new Worker(
      WAITLIST_QUEUE,
      async (job: Job): Promise<MatchResult> =>
        runWaitlistMatch(this.db, MatchJobSchema.parse(job.data), matcher),
      { connection, concurrency: this.options.concurrency ?? 5 },
    );
    this.worker.on('failed', (job, error) => {
      // Given up after its attempts (the match row says `failed`), or the database is down.
      this.logger.warn(`Waitlist match failed: ${error.name}`);
      const data = job?.data as { matchId?: unknown; tenantId?: unknown } | undefined;
      raiseAlert('Waitlist match failed', {
        matchId: String(data?.matchId),
        tenantId: String(data?.tenantId),
      });
    });
    this.timer = setInterval(() => void this.relayOnce(), this.options.pollMs);
  }

  /** One relay pass; passes never overlap, and a failing pass is logged once until it heals. */
  async relayOnce(): Promise<void> {
    if (this.relaying || this.queue === undefined) return;
    this.relaying = true;
    try {
      await relayDueMatches(this.db, this.queue, (this.options.clock ?? systemClock).now());
      this.relayFailing = false;
    } catch (error) {
      if (!this.relayFailing) {
        this.logger.warn(`Waitlist relay failed: ${error instanceof Error ? error.name : 'error'}`);
      }
      this.relayFailing = true;
    } finally {
      this.relaying = false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.worker?.close();
    await this.queue?.close();
    await this.connection?.quit().catch(() => undefined);
  }
}

/** The smart waitlist's relay and matcher. Needs `ConnectionsModule`. */
@Module({})
export class WaitlistModule {
  static forRoot(options: WaitlistOptions): DynamicModule {
    return {
      module: WaitlistModule,
      providers: [{ provide: WAITLIST_OPTIONS, useValue: options }, WaitlistRunner],
      exports: [WaitlistRunner],
    };
  }
}

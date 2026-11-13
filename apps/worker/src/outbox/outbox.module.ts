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
  systemClock,
  type Clock,
  type EpisodeWriter,
  type Mailer,
  type Pusher,
  type SmsSender,
} from '@pepper/core';
import type { Database } from '@pepper/db';
import { DATABASE, MAILER, raiseAlert, SandboxSmsSender, SandboxTextLog } from '@pepper/runtime';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { handleDeliveryJob, OUTBOX_QUEUE, relayDue } from './relay.js';

export interface OutboxOptions {
  redisUrl: string;
  /** Opens sealed messages (`outboxKeyFrom(OUTBOX_SECRET)`). */
  key: Buffer;
  pollMs: number;
  /** Sends pushes (ADR-0026); `null` or absent: no VAPID keys, queued pushes are not sent. */
  pusher?: Pusher | null;
  /** Writes episodes (S31); `null` or absent: no OpenAI here, so the api queues none. */
  episodes?: EpisodeWriter | null;
  /** Sends texts (S61, ADR-0065); `null` or absent: SMS is off, a queued text retries, then gives up. */
  sms?: SmsSender | null;
  /** The web app's origin for Twilio's signed delivery reports; `null` or absent: none. */
  smsStatusBaseUrl?: string | null;
  /**
   * The sandbox's sent texts also go to Redis for tests to read (S63, AC-X-87): only with
   * `SMS_PROVIDER=sandbox` where tests run.
   */
  sandboxTextLog?: boolean;
  /** Deliveries in flight per worker process. */
  concurrency?: number;
  clock?: Clock;
}

export const OUTBOX_OPTIONS = Symbol('OUTBOX_OPTIONS');

/**
 * Runs the outbox in the worker (ADR-0024): a relay that polls Postgres for due messages and
 * queues them in BullMQ, and a BullMQ worker that delivers them (emails, and pushes when a
 * pusher is configured, ADR-0026). Without a mailer nothing runs, and queued messages wait. A
 * message given up raises an alert; a push to a device that is gone does not.
 */
@Injectable()
export class OutboxRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRunner.name);
  private readonly db: Database;
  private connection: Redis | undefined;
  private queue: Queue | undefined;
  private worker: Worker | undefined;
  private timer: NodeJS.Timeout | undefined;
  private relaying = false;
  private relayFailing = false;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(MAILER) private readonly mailer: Mailer | null,
    @Inject(OUTBOX_OPTIONS) private readonly options: OutboxOptions,
  ) {
    this.db = database.db;
  }

  onApplicationBootstrap(): void {
    const { mailer } = this;
    if (mailer === null) {
      this.logger.warn('No SMTP_URL: queued emails wait until one is configured');
      return;
    }
    // BullMQ's blocking commands need unlimited retries per request.
    const connection = new Redis(this.options.redisUrl, { maxRetriesPerRequest: null });
    connection.on('error', () => undefined); // Reported by readiness; BullMQ reconnects.
    this.connection = connection;
    this.queue = new Queue(OUTBOX_QUEUE, { connection });
    const delivery = {
      key: this.options.key,
      mailer,
      pusher: this.options.pusher ?? null,
      episodes: this.options.episodes ?? null,
      sms:
        this.options.sandboxTextLog === true && this.options.sms instanceof SandboxSmsSender
          ? this.options.sms.withTextLog(new SandboxTextLog(connection))
          : (this.options.sms ?? null),
      smsStatusBaseUrl: this.options.smsStatusBaseUrl ?? null,
      clock: this.options.clock ?? systemClock,
    };
    this.worker = new Worker(
      OUTBOX_QUEUE,
      async (job: Job) => {
        const result = await handleDeliveryJob(this.db, job.data, delivery);
        if (result === 'dead') this.gaveUp(job);
        return result;
      },
      { connection, concurrency: this.options.concurrency ?? 5 },
    );
    this.worker.on('failed', (_job, error) => {
      // Unexpected (e.g. the database is down): the message is due again later.
      this.logger.warn(`Outbox delivery failed: ${error.name}`);
    });
    this.timer = setInterval(() => void this.relayOnce(), this.options.pollMs);
  }

  /** One relay pass; passes never overlap, and a failing pass is logged once until it heals. */
  async relayOnce(): Promise<void> {
    if (this.relaying || this.queue === undefined) return;
    this.relaying = true;
    try {
      await relayDue(this.db, this.queue, (this.options.clock ?? systemClock).now());
      this.relayFailing = false;
    } catch (error) {
      if (!this.relayFailing) {
        this.logger.warn(`Outbox relay failed: ${error instanceof Error ? error.name : 'error'}`);
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

  private gaveUp(job: Job): void {
    // Ids only: the address and content are personal data (and already cleared).
    const tags = {
      messageId: String((job.data as { messageId?: unknown }).messageId),
      tenantId: String((job.data as { tenantId?: unknown }).tenantId),
    };
    this.logger.error(`Outbox message given up: ${tags.messageId}`);
    raiseAlert('Outbox message given up', tags);
  }
}

/** The outbox relay and delivery worker. Needs `ConnectionsModule` and `MailModule`. */
@Module({})
export class OutboxModule {
  static forRoot(options: OutboxOptions): DynamicModule {
    return {
      module: OutboxModule,
      providers: [{ provide: OUTBOX_OPTIONS, useValue: options }, OutboxRunner],
      exports: [OutboxRunner],
    };
  }
}

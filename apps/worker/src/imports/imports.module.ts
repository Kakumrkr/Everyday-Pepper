import {
  Inject,
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { systemClock, type Clock } from '@pepper/core';
import type { Database } from '@pepper/db';
import { runImport, tidyImports, type ImportRunResult } from '@pepper/imports';
import { DATABASE, raiseAlert } from '@pepper/runtime';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { IMPORTS_QUEUE, ImportJobSchema, relayDueImports } from './relay.js';

export interface ImportsOptions {
  redisUrl: string;
  /** How often the relay looks for committed imports. */
  pollMs: number;
  /** How often imports are tidied (stale staged ones discarded, old rows cleared). */
  tidyMs?: number;
  concurrency?: number;
  clock?: Clock;
}

export const IMPORTS_OPTIONS = Symbol('IMPORTS_OPTIONS');

const HOUR_MS = 60 * 60_000;

/**
 * Runs client imports in the worker (S48, ADR-0049, AC-W1-3): a relay that polls Postgres for
 * committed imports and queues them in BullMQ, a BullMQ worker that runs each one (`runImport`:
 * leased, in chunks, idempotent), and an hourly tidy-up (D-5). Several workers may run it: an
 * import is claimed for a lease before it runs.
 */
@Injectable()
export class ImportsRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ImportsRunner.name);
  private readonly db: Database;
  private connection: Redis | undefined;
  private queue: Queue | undefined;
  private worker: Worker | undefined;
  private timers: NodeJS.Timeout[] = [];
  private relaying = false;
  private relayFailing = false;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(IMPORTS_OPTIONS) private readonly options: ImportsOptions,
  ) {
    this.db = database.db;
  }

  private get clock(): Clock {
    return this.options.clock ?? systemClock;
  }

  onApplicationBootstrap(): void {
    // BullMQ's blocking commands need unlimited retries per request.
    const connection = new Redis(this.options.redisUrl, { maxRetriesPerRequest: null });
    connection.on('error', () => undefined); // Reported by readiness; BullMQ reconnects.
    this.connection = connection;
    this.queue = new Queue(IMPORTS_QUEUE, { connection });
    this.worker = new Worker(
      IMPORTS_QUEUE,
      async (job: Job): Promise<ImportRunResult> => {
        const data = ImportJobSchema.parse(job.data);
        const result = await runImport(this.db, data, this.clock);
        if (result === 'failed') {
          // Ids only: what the import holds is client data.
          raiseAlert('Client import failed', { batchId: data.batchId, tenantId: data.tenantId });
        }
        return result;
      },
      { connection, concurrency: this.options.concurrency ?? 2 },
    );
    this.worker.on('failed', (_job, error) => {
      // The import stays due: the relay queues it again once its lease runs out, and it is
      // marked failed after its attempts.
      this.logger.warn(`Client import run failed: ${error.name}`);
    });
    this.timers.push(setInterval(() => void this.relayOnce(), this.options.pollMs));
    this.timers.push(setInterval(() => void this.tidyOnce(), this.options.tidyMs ?? HOUR_MS));
  }

  /** One relay pass; passes never overlap, and a failing pass is logged once until it heals. */
  async relayOnce(): Promise<void> {
    if (this.relaying || this.queue === undefined) return;
    this.relaying = true;
    try {
      await relayDueImports(this.db, this.queue, this.clock.now());
      this.relayFailing = false;
    } catch (error) {
      if (!this.relayFailing) {
        this.logger.warn(`Import relay failed: ${error instanceof Error ? error.name : 'error'}`);
      }
      this.relayFailing = true;
    } finally {
      this.relaying = false;
    }
  }

  /** One tidy-up pass. */
  async tidyOnce(): Promise<void> {
    try {
      await tidyImports(this.db, this.clock);
    } catch (error) {
      this.logger.warn(`Import tidy-up failed: ${error instanceof Error ? error.name : 'error'}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    // Without Redis there is nothing to wait for (a closing worker would wait for it forever);
    // a run cut short is taken over after its lease.
    const reachable = this.connection?.status === 'ready';
    await this.worker?.close(!reachable);
    await this.queue?.close();
    if (reachable) await this.connection?.quit().catch(() => undefined);
    else this.connection?.disconnect();
  }
}

/** The client import relay, runner and tidy-up. Needs `ConnectionsModule`. */
@Module({})
export class ImportsModule {
  static forRoot(options: ImportsOptions): DynamicModule {
    return {
      module: ImportsModule,
      providers: [{ provide: IMPORTS_OPTIONS, useValue: options }, ImportsRunner],
      exports: [ImportsRunner],
    };
  }
}

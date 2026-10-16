import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import pg from 'pg';
import { READINESS_CHECKS, type ReadinessChecks } from './health.tokens.js';

export interface ConnectionsOptions {
  databaseUrl: string;
  redisUrl: string;
}

const PG_POOL = Symbol('PG_POOL');
const REDIS = Symbol('REDIS');

/** Readiness probes over the shared clients. */
export function readinessChecks(
  pool: Pick<pg.Pool, 'query'>,
  redis: Pick<Redis, 'ping'>,
): ReadinessChecks {
  return {
    // The only raw SQL outside packages/db: a liveness probe. Moves there with the db package (Phase 2).
    database: () => pool.query('SELECT 1'),
    redis: () => redis.ping(),
  };
}

@Injectable()
class ConnectionsLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.pool.end(), this.redis.quit()]);
  }
}

/** Postgres pool and Redis client for the process, closed on shutdown. */
@Global()
@Module({})
export class ConnectionsModule {
  static forRoot(options: ConnectionsOptions): DynamicModule {
    const logger = new Logger(ConnectionsModule.name);
    return {
      module: ConnectionsModule,
      providers: [
        {
          provide: PG_POOL,
          useFactory: () => {
            const pool = new pg.Pool({
              connectionString: options.databaseUrl,
              max: 2,
              connectionTimeoutMillis: 2_000,
              idleTimeoutMillis: 10_000,
            });
            // An idle client losing its connection must not crash the process.
            pool.on('error', (error) => {
              logger.warn(`Postgres idle client error: ${error.message}`);
            });
            return pool;
          },
        },
        {
          provide: REDIS,
          useFactory: () => {
            const redis = new Redis(options.redisUrl, {
              // Fail fast while disconnected instead of queueing commands.
              enableOfflineQueue: false,
              maxRetriesPerRequest: 1,
            });
            let reported = false;
            redis.on('error', (error: Error) => {
              if (!reported) logger.warn(`Redis connection error: ${error.message}`);
              reported = true;
            });
            redis.on('ready', () => {
              reported = false;
            });
            return redis;
          },
        },
        {
          provide: READINESS_CHECKS,
          inject: [PG_POOL, REDIS],
          useFactory: readinessChecks,
        },
        ConnectionsLifecycle,
      ],
      exports: [READINESS_CHECKS],
    };
  }
}

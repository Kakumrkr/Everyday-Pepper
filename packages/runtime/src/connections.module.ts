import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { createDatabase, type DatabaseHandle } from '@pepper/db';
import { Redis } from 'ioredis';
import { READINESS_CHECKS, type ReadinessChecks } from './health.tokens.js';

export interface ConnectionsOptions {
  databaseUrl: string;
  redisUrl: string;
}

/** The process's `DatabaseHandle` (`@pepper/db`); inject it to reach repositories. */
export const DATABASE = Symbol('DATABASE');
const REDIS = Symbol('REDIS');

/** Readiness probes over the shared clients. */
export function readinessChecks(
  database: Pick<DatabaseHandle, 'ping'>,
  redis: Pick<Redis, 'ping'>,
): ReadinessChecks {
  return {
    // Reachable, and connected as a role that row-level security applies to.
    database: () => database.ping(),
    redis: () => redis.ping(),
  };
}

@Injectable()
class ConnectionsLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.database.close(), this.redis.quit()]);
  }
}

/** Database (Postgres pool) and Redis client for the process, closed on shutdown. */
@Global()
@Module({})
export class ConnectionsModule {
  static forRoot(options: ConnectionsOptions): DynamicModule {
    const logger = new Logger(ConnectionsModule.name);
    return {
      module: ConnectionsModule,
      providers: [
        {
          provide: DATABASE,
          useFactory: () =>
            createDatabase({
              url: options.databaseUrl,
              // An idle client losing its connection must not crash the process.
              onIdleError: (error) => {
                logger.warn(`Postgres idle client error: ${error.message}`);
              },
            }),
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
          inject: [DATABASE, REDIS],
          useFactory: readinessChecks,
        },
        ConnectionsLifecycle,
      ],
      exports: [READINESS_CHECKS, DATABASE],
    };
  }
}

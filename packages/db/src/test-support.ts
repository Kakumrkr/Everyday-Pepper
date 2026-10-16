// Integration-test helpers (not built into dist).
import { startPostgres, postgresUrlAs } from '@floty/testing';
import { createDatabase, type DatabaseHandle } from './client.js';
import { prepareDatabase } from './migrate.js';

export const APP_LOGIN = 'floty_service';

export interface TestDatabase {
  /** Superuser of the container: runs migrations, like MIGRATION_DATABASE_URL. */
  migrationUrl: string;
  /** The services' login role, like DATABASE_URL. */
  appUrl: string;
  /** A pool connected as the services' login role. */
  app: DatabaseHandle;
  stop(): Promise<void>;
}

/** A migrated Postgres with the services' login role provisioned, as in Compose. */
export async function startTestDatabase(
  options: { maxConnections?: number } = {},
): Promise<TestDatabase> {
  const postgres = await startPostgres();
  const appUrl = postgresUrlAs(postgres.url, APP_LOGIN, 'service-test-password');
  await prepareDatabase(postgres.url, appUrl);
  const app = createDatabase({ url: appUrl, maxConnections: options.maxConnections ?? 4 });
  return {
    migrationUrl: postgres.url,
    appUrl,
    app,
    stop: async () => {
      await app.close();
      await postgres.stop();
    },
  };
}

/** The Postgres SQLSTATE of `error` or an error it wraps (drizzle wraps driver errors). */
export function sqlState(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const { code } = current as Error & { code?: unknown };
    if (typeof code === 'string') return code;
  }
  return undefined;
}

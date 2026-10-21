// Integration-test helpers (not built into dist).
import { UserIdSchema, type UserId } from '@pepper/contracts';
import { startPostgres, postgresUrlAs } from '@pepper/testing';
import { createDatabase, type Database, type DatabaseHandle } from './client.js';
import { newId } from './ids.js';
import { prepareDatabase } from './migrate.js';
import { users } from './schema.js';

export const APP_LOGIN = 'pepper_service';

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
  const app = createDatabase({
    url: appUrl,
    maxConnections: options.maxConnections ?? 4,
    // Generous: tests queue many transactions on a few connections while CI runs every suite.
    connectionTimeoutMs: 30_000,
  });
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

/** Inserts a user directly (Better Auth creates them in the app); returns its id. */
export async function insertUser(db: Database, name = 'Test User'): Promise<UserId> {
  const id = newId();
  await db.insert(users).values({ id, name, email: `user-${id}@example.test` });
  return UserIdSchema.parse(id);
}

// Integration-test helpers (not built into dist).
import { UserIdSchema, type UserId } from '@pepper/contracts';
import {
  createDatabase,
  newId,
  prepareDatabase,
  users,
  type Database,
  type DatabaseHandle,
} from '@pepper/db';
import { postgresUrlAs, startPostgres } from '@pepper/testing';

export interface TestDatabase {
  migrationUrl: string;
  /** A pool connected as the services' login role, as in Compose. */
  app: DatabaseHandle;
  stop(): Promise<void>;
}

/** A migrated Postgres with the services' login role provisioned. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const postgres = await startPostgres();
  const appUrl = postgresUrlAs(postgres.url, 'pepper_service', 'service-test-password');
  await prepareDatabase(postgres.url, appUrl);
  const app = createDatabase({ url: appUrl, maxConnections: 8, connectionTimeoutMs: 30_000 });
  return {
    migrationUrl: postgres.url,
    app,
    stop: async () => {
      await app.close();
      await postgres.stop();
    },
  };
}

/** Inserts a user directly (Better Auth creates them in the app); returns its id. */
export async function insertUser(db: Database, name: string, email?: string): Promise<UserId> {
  const id = newId();
  await db.insert(users).values({ id, name, email: email ?? `user-${id}@example.test` });
  return UserIdSchema.parse(id);
}

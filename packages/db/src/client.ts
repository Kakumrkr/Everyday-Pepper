import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

/** Typed query builder over the process's pool. Use it only inside `withTenant` (tenant data). */
export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseOptions {
  /** The services' login role (`DATABASE_URL`), never the migration role. Carries credentials. */
  url: string;
  maxConnections?: number;
  /** Called when an idle pooled connection fails, so it is logged instead of crashing. */
  onIdleError?: (error: Error) => void;
}

/** The process's database: query builder, readiness probe and shutdown. */
export interface DatabaseHandle {
  readonly db: Database;
  /** Readiness probe; see `checkDatabaseRole`. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabase(options: DatabaseOptions): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 10_000,
  });
  pool.on('error', (error) => options.onIdleError?.(error));
  return {
    db: drizzle({ client: pool, schema }),
    ping: () => checkDatabaseRole(pool),
    close: () => pool.end(),
  };
}

/**
 * Readiness probe: Postgres answers, and the connection is subject to row-level security.
 * A superuser or `BYPASSRLS` role would silently see every tenant's rows, so it fails readiness.
 */
export async function checkDatabaseRole(client: Pick<pg.Pool, 'query'>): Promise<void> {
  const { rows } = await client.query<{ bypasses_rls: boolean }>(
    'SELECT rolsuper OR rolbypassrls AS bypasses_rls FROM pg_roles WHERE rolname = current_user',
  );
  if (rows[0]?.bypasses_rls !== false) {
    throw new Error(
      'The database role bypasses row-level security; DATABASE_URL must use the app role (ADR-0010)',
    );
  }
}

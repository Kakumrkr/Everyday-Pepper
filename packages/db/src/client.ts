import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

/** Typed query builder over the process's pool. Use it only inside `withTenant` (tenant data). */
export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseOptions {
  /** The services' login role (`DATABASE_URL`), never the migration role. Carries credentials. */
  url: string;
  maxConnections?: number;
  /**
   * How long to wait for a free pooled connection (default 2 s, so an overloaded service fails
   * fast). Test pools that queue many transactions on few connections while every suite runs
   * at once set it higher.
   */
  connectionTimeoutMs?: number;
  /** Called when an idle pooled connection fails, so it is logged instead of crashing. */
  onIdleError?: (error: Error) => void;
  /** Called before every statement (query budgets in tests, per-turn metrics); no text given. */
  onQuery?: () => void;
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
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 2_000,
    idleTimeoutMillis: 10_000,
  });
  pool.on('error', (error) => options.onIdleError?.(error));
  const { onQuery } = options;
  if (onQuery !== undefined) {
    // Statements in transactions run on checked-out clients: count those.
    pool.on('connect', (client) => {
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
        onQuery();
        return query(...args);
      };
    });
  }
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

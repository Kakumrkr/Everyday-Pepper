import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Group role holding the services' privileges (created by migration 0000). */
export const APP_ROLE = 'pepper_app';

/** The SQL migrations, shipped with the package (`files` in package.json). */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/** Advisory lock key serialising migrators and provisioning ("pepper" in ASCII). */
const MIGRATION_LOCK = 0x706570706572;

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

async function withClient<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * Applies pending migrations as the migration (schema owner) role. Safe to run on every deploy
 * and from several processes at once: an advisory lock serialises them, and drizzle applies all
 * pending migrations in one transaction.
 */
export async function runMigrations(migrationUrl: string): Promise<void> {
  await withClient(migrationUrl, async (client) => {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    try {
      await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
    }
  });
}

/**
 * Creates or updates the services' login role from `appUrl` (user and password) and grants it
 * `pepper_app`. Refuses to touch a role with elevated attributes, so pointing DATABASE_URL at an
 * admin role fails loudly instead of demoting it. For dev, CI and the pilot; managed databases
 * may provision the role elsewhere.
 */
export async function provisionAppRole(migrationUrl: string, appUrl: string): Promise<void> {
  const app = new URL(appUrl);
  const user = decodeURIComponent(app.username);
  const password = decodeURIComponent(app.password);
  if (!ROLE_NAME.test(user)) {
    throw new Error('DATABASE_URL user must be a lowercase role name (letters, digits, _)');
  }
  if (password === '') throw new Error('DATABASE_URL must include a password');
  if (user === decodeURIComponent(new URL(migrationUrl).username) || user === APP_ROLE) {
    throw new Error('DATABASE_URL must use its own login role, not the migration or group role');
  }

  await withClient(migrationUrl, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
      const existing = await client.query<{ elevated: boolean }>(
        `SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication AS elevated
           FROM pg_roles WHERE rolname = $1`,
        [user],
      );
      const role = existing.rows[0];
      if (role?.elevated === true) {
        throw new Error('DATABASE_URL user is a privileged role; use a dedicated app login role');
      }
      // Role names and passwords cannot be bound parameters; format() quotes them safely.
      const statement = await client.query<{ sql: string }>(
        `SELECT format('%s ROLE %I WITH LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
                       $1::text, $2::text, $3::text) AS sql`,
        [role === undefined ? 'CREATE' : 'ALTER', user, password],
      );
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- SELECT without FROM returns exactly one row
      await client.query(statement.rows[0]!.sql);
      const grant = await client.query<{ sql: string }>(
        `SELECT format('GRANT %I TO %I', $1::text, $2::text) AS sql`,
        [APP_ROLE, user],
      );
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- SELECT without FROM returns exactly one row
      await client.query(grant.rows[0]!.sql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/** What a deploy (and the Compose `migrate` service) runs: migrations, then the login role. */
export async function prepareDatabase(migrationUrl: string, appUrl?: string): Promise<void> {
  await runMigrations(migrationUrl);
  if (appUrl !== undefined) await provisionAppRole(migrationUrl, appUrl);
}

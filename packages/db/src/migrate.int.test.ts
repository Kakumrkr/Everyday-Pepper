import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { postgresUrlAs } from '@pepper/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from './client.js';
import { APP_ROLE, provisionAppRole, runMigrations } from './migrate.js';
import { APP_LOGIN, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await startTestDatabase();
});

afterAll(async () => {
  await database.stop();
});

async function query<T extends pg.QueryResultRow>(
  url: string,
  text: string,
  values: unknown[] = [],
) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

describe('runMigrations', () => {
  it('0051 marks the accounts made before S44 as confirmed, so they still sign in (ADR-0045)', async () => {
    const [before] = await query<{ id: string }>(
      database.migrationUrl,
      "INSERT INTO users (id, name, email) VALUES (gen_random_uuid(), 'Old', $1) RETURNING id",
      [`old-${String(Date.now())}@example.test`],
    );
    const sql = await readFile(
      new URL('../migrations/0051_existing_accounts_verified.sql', import.meta.url),
      'utf8',
    );
    await query(database.migrationUrl, sql);
    expect(
      await query(database.migrationUrl, 'SELECT email_verified FROM users WHERE id = $1', [
        before?.id,
      ]),
    ).toEqual([{ email_verified: true }]);
  });

  it('applied every migration once', async () => {
    const files = (await readdir(new URL('../migrations', import.meta.url))).filter((f) =>
      f.endsWith('.sql'),
    );
    const applied = await query(
      database.migrationUrl,
      'SELECT hash FROM drizzle.__drizzle_migrations',
    );
    expect(applied).toHaveLength(files.length);
  });

  it('is idempotent and safe to run concurrently', async () => {
    const before = await query(
      database.migrationUrl,
      'SELECT hash FROM drizzle.__drizzle_migrations',
    );
    await Promise.all([1, 2, 3].map(() => runMigrations(database.migrationUrl)));
    const applied = await query(
      database.migrationUrl,
      'SELECT hash FROM drizzle.__drizzle_migrations',
    );
    expect(applied).toEqual(before);
  });

  it('matches the Drizzle schema (no ungenerated changes)', async () => {
    // drizzle-kit compares src/schema.ts with the latest snapshot; work on a copy of migrations/.
    const root = fileURLToPath(new URL('..', import.meta.url));
    const scratch = await mkdtemp(join(tmpdir(), 'pepper-db-'));
    try {
      await cp(join(root, 'migrations'), join(scratch, 'migrations'), { recursive: true });
      const out = join(scratch, 'migrations');
      const before = await readdir(out);
      // drizzle-kit prefixes --out with './' and exits 0 even on errors: pass a relative path
      // and require its positive "no changes" message as well as an unchanged folder.
      const { stdout, stderr } = await promisify(execFile)(
        join(root, 'node_modules/.bin/drizzle-kit'),
        [
          'generate',
          '--dialect=postgresql',
          '--schema=src/schema.ts',
          `--out=${relative(root, out)}`,
        ],
        { cwd: root },
      );
      expect(`${stdout}${stderr}`).toContain('No schema changes');
      expect(await readdir(out)).toEqual(before);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe('provisionAppRole', () => {
  it('creates a login role that RLS applies to, with only the pepper_app privileges', async () => {
    const [role] = await query<Record<string, boolean>>(
      database.migrationUrl,
      `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit,
              pg_has_role($1, $2, 'MEMBER') AS member
         FROM pg_roles WHERE rolname = $1`,
      [APP_LOGIN, APP_ROLE],
    );
    expect(role).toEqual({
      rolcanlogin: true,
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolinherit: true,
      member: true,
    });
    await expect(database.app.ping()).resolves.toBeUndefined();
  });

  it('updates the password on re-run', async () => {
    const newUrl = postgresUrlAs(database.appUrl, APP_LOGIN, 'rotated password');
    await provisionAppRole(database.migrationUrl, newUrl);
    await expect(query(newUrl, 'SELECT 1')).resolves.toHaveLength(1);
    await expect(query(database.appUrl, 'SELECT 1')).rejects.toThrow(
      /password authentication failed/,
    );
    await provisionAppRole(database.migrationUrl, database.appUrl);
  });

  it('refuses to touch a privileged role', async () => {
    await query(database.migrationUrl, 'CREATE ROLE admin_like LOGIN CREATEROLE');
    await expect(
      provisionAppRole(database.migrationUrl, postgresUrlAs(database.appUrl, 'admin_like', 'x')),
    ).rejects.toThrow(/privileged role/);
    const [role] = await query<{ rolcreaterole: boolean }>(
      database.migrationUrl,
      "SELECT rolcreaterole FROM pg_roles WHERE rolname = 'admin_like'",
    );
    expect(role?.rolcreaterole).toBe(true);
  });

  it.each([
    ['the migration role', (url: string) => url],
    ['the group role', (url: string) => postgresUrlAs(url, APP_ROLE, 'x')],
    ['a quoted name', (url: string) => postgresUrlAs(url, 'evil"; DROP ROLE x; --', 'x')],
    ['no password', (url: string) => postgresUrlAs(url, 'svc_no_pw', '')],
  ])('rejects %s', async (_label, toUrl) => {
    await expect(
      provisionAppRole(database.migrationUrl, toUrl(database.migrationUrl)),
    ).rejects.toThrow(/DATABASE_URL/);
  });

  it('quotes passwords safely', async () => {
    const tricky = postgresUrlAs(database.appUrl, 'svc_tricky', "it's'; DROP TABLE tenants; --");
    await provisionAppRole(database.migrationUrl, tricky);
    await expect(query(tricky, 'SELECT 1')).resolves.toHaveLength(1);
    await expect(query(database.migrationUrl, 'SELECT 1 FROM tenants')).resolves.toBeDefined();
  });
});

describe('createDatabase', () => {
  it('fails readiness when connected as a role that bypasses RLS', async () => {
    const superuser = createDatabase({ url: database.migrationUrl });
    try {
      await expect(superuser.ping()).rejects.toThrow(/bypasses row-level security/);
    } finally {
      await superuser.close();
    }
  });

  it('reports an unreachable database through the probe', async () => {
    const unreachable = createDatabase({ url: 'postgres://x:y@127.0.0.1:1/z' });
    const error = await unreachable.ping().catch((e: unknown) => e);
    await unreachable.close();
    expect(error).toBeInstanceOf(Error);
    expect(sqlState(error)).toBe('ECONNREFUSED');
  });
});

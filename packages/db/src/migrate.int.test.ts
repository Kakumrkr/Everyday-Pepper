import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  ClientIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
} from '@pepper/contracts';
import { postgresUrlAs } from '@pepper/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from './client.js';
import { APP_ROLE, provisionAppRole, runMigrations } from './migrate.js';
import { insertBooking } from './repositories/bookings.js';
import { insertClient } from './repositories/clients.js';
import { addMembership } from './repositories/memberships.js';
import { insertService, insertStaffMember } from './repositories/appointments.js';
import { createTenant } from './repositories/tenants.js';
import { withTenant } from './tenant.js';
import {
  APP_LOGIN,
  insertUser,
  sqlState,
  startTestDatabase,
  type TestDatabase,
} from './test-support.js';

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

  it('0089 times old cancels from their audit entry, else updated_at, and leaves updated_at as it was (S77)', async () => {
    const tenant = TenantIdSchema.parse(
      (
        await createTenant(database.app.db, {
          name: 'Old cancels',
          slug: `old-cancels-${String(Date.now())}`,
          timeZone: 'America/New_York',
        })
      ).id,
    );
    const [audited, unaudited] = await withTenant(database.app.db, tenant, async (tx) => {
      const service = await insertService(tx, {
        name: 'Cut',
        category: null,
        durationMinutes: 30,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        priceFromCents: null,
        priceToCents: null,
        active: true,
      });
      const staff = await insertStaffMember(tx, {
        displayName: 'Jess',
        color: '#2a7230',
        active: true,
        membershipId: null,
      });
      const client = await insertClient(tx, {
        name: 'Maria',
        email: null,
        phone: null,
        source: 'team',
      });
      const book = (startsAt: string) =>
        insertBooking(tx, {
          clientId: ClientIdSchema.parse(client.id),
          serviceId: ServiceIdSchema.parse(service.id),
          staffMemberId: StaffMemberIdSchema.parse(staff.id),
          startsAt: new Date(startsAt),
          endsAt: new Date(Date.parse(startsAt) + 30 * 60_000),
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          priceFromCents: null,
          priceToCents: null,
          source: 'team',
          overridden: false,
          idempotencyKey: null,
          createdBy: null,
        });
      return [await book('2026-10-20T14:00:00Z'), await book('2026-10-21T14:00:00Z')];
    });
    if (audited === undefined || unaudited === undefined) throw new Error('not booked');
    // Both cancelled as before 0089: no cancel time, an old updated_at; one has its audit entry.
    const url = database.migrationUrl;
    await query(url, 'ALTER TABLE bookings DROP CONSTRAINT bookings_cancelled_at');
    {
      await query(
        url,
        `UPDATE bookings SET status = 'cancelled', cancelled_at = NULL WHERE id = ANY($1::uuid[])`,
        [[audited.id, unaudited.id]],
      );
      await query(url, 'ALTER TABLE bookings DISABLE TRIGGER bookings_set_updated_at');
      await query(
        url,
        `UPDATE bookings SET updated_at = '2026-10-05T10:00:00Z' WHERE id = ANY($1::uuid[])`,
        [[audited.id, unaudited.id]],
      );
      await query(url, 'ALTER TABLE bookings ENABLE TRIGGER bookings_set_updated_at');
      await query(
        url,
        `INSERT INTO audit_log (id, tenant_id, actor_kind, action, entity_type, entity_id, after, created_at)
         VALUES (gen_random_uuid(), $1, 'system', 'booking.updated', 'booking', $2,
                 '{"status":"cancelled"}', '2026-10-01T09:00:00Z')`,
        [tenant, audited.id],
      );
    }
    const file = await readFile(
      new URL('../migrations/0089_s77_visit_risk.sql', import.meta.url),
      'utf8',
    );
    // The backfill as the migration runs it, from its first line to the constraint it adds.
    const backfill = file.slice(
      file.indexOf('-- S77 (ADR-0071) backfill begins'),
      file.indexOf('-- S77 backfill ends.'),
    );
    for (const statement of backfill.split('--> statement-breakpoint')) {
      if (statement.trim() !== '') await query(url, statement);
    }

    const rows = await query<{ id: string; cancelled_at: Date; updated_at: Date }>(
      url,
      'SELECT id, cancelled_at, updated_at FROM bookings WHERE id = ANY($1::uuid[])',
      [[audited.id, unaudited.id]],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(audited.id)?.cancelled_at.toISOString()).toBe('2026-10-01T09:00:00.000Z');
    expect(byId.get(unaudited.id)?.cancelled_at.toISOString()).toBe('2026-10-05T10:00:00.000Z');
    for (const row of rows) expect(row.updated_at.toISOString()).toBe('2026-10-05T10:00:00.000Z');
    // RLS is forced again, and the updated_at trigger is back on.
    expect(
      await query(
        url,
        "SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('bookings', 'audit_log') ORDER BY relname",
      ),
    ).toEqual([
      { relname: 'audit_log', relforcerowsecurity: true },
      { relname: 'bookings', relforcerowsecurity: true },
    ]);
    expect(
      await query(url, "SELECT tgenabled FROM pg_trigger WHERE tgname = 'bookings_set_updated_at'"),
    ).toEqual([{ tgenabled: 'O' }]);
  });

  it('0057 keeps episode embeddings in the row and moves earlier ones in, values unchanged (S47.3)', async () => {
    const toastChunks = async () => {
      const [toast] = await query<{ name: string }>(
        database.migrationUrl,
        `SELECT reltoastrelid::regclass::text AS name FROM pg_class WHERE relname = 'memory_episodes'`,
      );
      const [row] = await query<{ chunks: number }>(
        database.migrationUrl,
        `SELECT count(*)::int AS chunks FROM ${String(toast?.name)}`,
      );
      return row?.chunks;
    };
    expect(
      await query(
        database.migrationUrl,
        `SELECT attstorage FROM pg_attribute
         WHERE attrelid = 'memory_episodes'::regclass AND attname = 'embedding'`,
      ),
    ).toEqual([{ attstorage: 'p' }]);

    // An episode written as before 0057: its vector out of line in TOAST.
    const tenant = TenantIdSchema.parse(
      (
        await createTenant(database.app.db, {
          name: 'Old episodes',
          slug: `old-episodes-${String(Date.now())}`,
          timeZone: 'America/New_York',
        })
      ).id,
    );
    const owner = await insertUser(database.app.db, 'Owner');
    await withTenant(database.app.db, tenant, (tx) =>
      addMembership(tx, { userId: owner, role: 'owner' }),
    );
    // Back to the migrated storage whatever happens, so later tests see production's schema.
    try {
      await query(
        database.migrationUrl,
        'ALTER TABLE memory_episodes ALTER COLUMN embedding SET STORAGE EXTENDED',
      );
      await query(
        database.migrationUrl,
        `INSERT INTO memory_episodes (id, tenant_id, user_id, summary, embedding, embedding_model)
         VALUES (gen_random_uuid(), $1, $2, 'Before 0057',
           (SELECT array_agg(random() - 0.5)::vector FROM generate_series(1, 1536)), 'm')`,
        [tenant, owner],
      );
      expect(await toastChunks()).toBeGreaterThan(0);
      const [before] = await query<{ embedding: string }>(
        database.migrationUrl,
        'SELECT embedding::text FROM memory_episodes WHERE tenant_id = $1',
        [tenant],
      );

      const sql = await readFile(
        new URL('../migrations/0057_memory_embedding_in_row.sql', import.meta.url),
        'utf8',
      );
      // Run as the table's owner without superuser (a managed database's migration role):
      // forced RLS would hide every row from its rewrite unless the migration lifts it.
      await query(
        database.migrationUrl,
        `CREATE ROLE episodes_owner LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'owner-test-password'`,
      );
      await query(database.migrationUrl, 'ALTER TABLE memory_episodes OWNER TO episodes_owner');
      await query(
        postgresUrlAs(database.migrationUrl, 'episodes_owner', 'owner-test-password'),
        sql,
      );

      expect(await toastChunks()).toBe(0);
      // RLS is lifted for the rewrite only: forced again afterwards.
      expect(
        await query(
          database.migrationUrl,
          `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'memory_episodes'`,
        ),
      ).toEqual([{ relforcerowsecurity: true }]);
      expect(
        await query(
          database.migrationUrl,
          'SELECT embedding::text FROM memory_episodes WHERE tenant_id = $1',
          [tenant],
        ),
      ).toEqual([before]);
    } finally {
      await query(
        database.migrationUrl,
        'ALTER TABLE memory_episodes ALTER COLUMN embedding SET STORAGE PLAIN',
      );
      await query(database.migrationUrl, 'ALTER TABLE memory_episodes OWNER TO CURRENT_USER');
      await query(database.migrationUrl, 'DROP ROLE IF EXISTS episodes_owner');
    }
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

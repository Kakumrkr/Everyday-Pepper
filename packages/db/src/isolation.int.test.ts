// Cross-tenant isolation suite (docs/engineering/testing-strategy.md; must stay at 100%).
// Every table in `public` must be listed in TENANT_TABLES (row access limited by RLS) or in
// GLOBAL_TABLES (with a reason); the catalog test fails for a table that is in neither.
import { TenantIdSchema, UserIdSchema, type TenantId } from '@floty/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './client.js';
import { newId } from './ids.js';
import { APP_ROLE } from './migrate.js';
import { addMembership } from './repositories/memberships.js';
import { createTenant } from './repositories/tenants.js';
import { withTenant, type TenantTx } from './tenant.js';
import { sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

/** Tables that are not tenant-owned, with why. Empty until users/auth (S7). */
const GLOBAL_TABLES: Record<string, string> = {};

interface TenantTable {
  /** Column holding the owning tenant (`id` for `tenants` itself). */
  tenantColumn: string;
  /** Inserts one row owned by the transaction's tenant; returns its id. */
  seed: (tx: TenantTx) => Promise<string>;
  /** A harmless assignment for UPDATE probes. */
  touch: string;
}

const TENANT_TABLES: Record<string, TenantTable> = {
  tenants: {
    tenantColumn: 'id',
    // The tenant row already exists; return the transaction's tenant.
    seed: async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`SELECT current_tenant_id() AS id`);
      return String(rows[0]?.id);
    },
    touch: "name = name || ''",
  },
  memberships: {
    tenantColumn: 'tenant_id',
    seed: async (tx) =>
      (await addMembership(tx, { userId: UserIdSchema.parse(newId()), role: 'staff' })).id,
    touch: "role = 'manager'",
  },
};

let database: TestDatabase;
let db: Database;
let tenantA: TenantId;
let tenantB: TenantId;
/** Row ids per table, per tenant. */
const rows: Record<string, { a: string; b: string }> = {};

async function seedTenant(slug: string): Promise<TenantId> {
  const tenant = await createTenant(db, { name: slug, slug, timeZone: 'America/New_York' });
  return TenantIdSchema.parse(tenant.id);
}

async function asAdmin<T extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
  const client = new pg.Client({ connectionString: database.migrationUrl });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

/** Runs raw SQL as the app role in tenant A's transaction. */
function inTenant<T extends Record<string, unknown>>(tenant: TenantId, statement: string) {
  return withTenant(db, tenant, (tx) => tx.execute<T>(sql.raw(statement)));
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  tenantA = await seedTenant('tenant-a');
  tenantB = await seedTenant('tenant-b');
  for (const [table, spec] of Object.entries(TENANT_TABLES)) {
    rows[table] = {
      a: await withTenant(db, tenantA, spec.seed),
      b: await withTenant(db, tenantB, spec.seed),
    };
  }
});

afterAll(async () => {
  await database.stop();
});

describe('catalog', () => {
  it('classifies every table in public as tenant-owned or global', async () => {
    const tables = await asAdmin<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
    );
    const classified = [...Object.keys(TENANT_TABLES), ...Object.keys(GLOBAL_TABLES)].sort();
    expect(tables.map((t) => t.name)).toEqual(classified);
  });

  it('every table with a tenant_id column is in the suite', async () => {
    const tables = await asAdmin<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id'`,
    );
    for (const { name } of tables) expect(TENANT_TABLES).toHaveProperty(name);
  });

  it.each(Object.entries(TENANT_TABLES))(
    '%s has forced RLS and exactly the tenant_isolation policy',
    async (table, spec) => {
      const [flags] = await asAdmin<{ enabled: boolean; forced: boolean }>(
        `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
           FROM pg_class WHERE oid = $1::regclass`,
        [`public.${table}`],
      );
      expect(flags).toEqual({ enabled: true, forced: true });
      const policies = await asAdmin(
        `SELECT policyname, permissive, cmd, roles::text[] AS roles, qual, with_check
           FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
        [table],
      );
      const predicate = `(${spec.tenantColumn} = current_tenant_id())`;
      expect(policies).toEqual([
        {
          policyname: 'tenant_isolation',
          permissive: 'PERMISSIVE',
          cmd: 'ALL',
          roles: ['public'],
          qual: predicate,
          with_check: predicate,
        },
      ]);
    },
  );
});

describe('the services role', () => {
  it('is not a superuser, cannot bypass RLS and owns nothing', async () => {
    const [role] = await asAdmin(
      `SELECT r.rolsuper, r.rolbypassrls,
              (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS owned
         FROM pg_roles r WHERE r.rolname = $1`,
      [new URL(database.appUrl).username],
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, owned: 0 });
  });

  it.each([
    ['disable RLS', 'ALTER TABLE tenants DISABLE ROW LEVEL SECURITY'],
    ['drop a policy', 'DROP POLICY tenant_isolation ON memberships'],
    ['create a table', 'CREATE TABLE sneaky (id int)'],
    ['read the migration history', 'SELECT * FROM drizzle.__drizzle_migrations'],
  ])('cannot %s', async (_label, statement) => {
    const error = await db.execute(sql.raw(statement)).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('42501'); // insufficient_privilege
  });

  it('cannot become the migration role', async () => {
    const owner = new URL(database.migrationUrl).username;
    const error = await db.execute(sql.raw(`SET ROLE "${owner}"`)).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('42501');
  });

  it('cannot switch RLS off for its session', async () => {
    const error = await db
      .transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL row_security = off`);
        await tx.execute(sql`SELECT * FROM tenants`);
      })
      .catch((e: unknown) => e);
    // "query would be affected by row-level security policy"
    expect(sqlState(error)).toBe('42501');
  });

  it(`gets its table privileges from ${APP_ROLE}`, async () => {
    const [privileges] = await asAdmin<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.role_table_grants
        WHERE grantee = $1 AND table_schema = 'public'`,
      [new URL(database.appUrl).username],
    );
    expect(privileges?.count).toBe(0);
  });
});

describe.each(Object.entries(TENANT_TABLES))('%s', (table, spec) => {
  const column = spec.tenantColumn;
  const ids = () => {
    const ids = rows[table];
    if (ids === undefined) throw new Error(`no seed rows for ${table}`);
    return ids;
  };

  it('a tenant sees only its own rows', async () => {
    const { rows: seen } = await inTenant<{ id: string; owner: string }>(
      tenantA,
      `SELECT id::text, ${column}::text AS owner FROM ${table}`,
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((row) => row.owner === tenantA)).toBe(true);
    expect(seen.map((row) => row.id)).toContain(ids().a);
  });

  it("another tenant's row cannot be read by id", async () => {
    const { rows: seen } = await inTenant(
      tenantA,
      `SELECT * FROM ${table} WHERE id = '${ids().b}'`,
    );
    expect(seen).toEqual([]);
  });

  it("another tenant's row cannot be updated or deleted", async () => {
    const before = await inTenant(tenantB, `SELECT * FROM ${table} WHERE id = '${ids().b}'`);
    const updated = await inTenant(
      tenantA,
      `UPDATE ${table} SET ${spec.touch} WHERE id = '${ids().b}'`,
    );
    const deleted = await inTenant(tenantA, `DELETE FROM ${table} WHERE id = '${ids().b}'`);
    expect([updated.rowCount, deleted.rowCount]).toEqual([0, 0]);
    const after = await inTenant(tenantB, `SELECT * FROM ${table} WHERE id = '${ids().b}'`);
    expect(after.rows).toEqual(before.rows);
    expect(after.rows).toHaveLength(1);
  });

  it('a row cannot be written into another tenant', async () => {
    // Copy tenant A's own row with a new id and B as the owner.
    const insert = await withTenant(db, tenantA, (tx) =>
      tx.execute(
        sql.raw(`INSERT INTO ${table} SELECT (jsonb_populate_record(t, jsonb_build_object(
                   'id', '${newId()}', '${column}', '${tenantB}', 'slug', 'stolen-${String(Date.now())}'))).*
                   FROM ${table} t WHERE id = '${ids().a}'`),
      ),
    ).catch((e: unknown) => e);
    expect(sqlState(insert)).toBe('42501');
  });

  it('a row cannot be moved to another tenant', async () => {
    if (column === 'id') return; // moving a tenant means changing its primary key; covered above
    const error = await inTenant(
      tenantA,
      `UPDATE ${table} SET ${column} = '${tenantB}' WHERE id = '${ids().a}'`,
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('42501');
  });

  it('nothing is visible without a tenant', async () => {
    const outside = await db.execute(sql.raw(`SELECT * FROM ${table}`));
    const inTransaction = await db.transaction((tx) =>
      tx.execute(sql.raw(`SELECT * FROM ${table}`)),
    );
    expect([outside.rows, inTransaction.rows]).toEqual([[], []]);
  });

  it('nothing can be changed without a tenant', async () => {
    const updated = await db.execute(sql.raw(`UPDATE ${table} SET ${spec.touch}`));
    const deleted = await db.execute(sql.raw(`DELETE FROM ${table}`));
    expect([updated.rowCount, deleted.rowCount]).toEqual([0, 0]);
  });
});

describe('tenant context', () => {
  it('does not outlive the transaction on a pooled connection', async () => {
    const single = createDatabase({ url: database.appUrl, maxConnections: 1 });
    try {
      const inside = await withTenant(single.db, tenantA, (tx) =>
        tx.execute(sql`SELECT id FROM tenants`),
      );
      expect(inside.rows).toHaveLength(1);
      // Same (only) connection, after COMMIT: the setting reads '' and must match nothing.
      const after = await single.db.execute(
        sql`SELECT current_tenant_id() AS id, count(*)::int AS n FROM tenants`,
      );
      expect(after.rows).toEqual([{ id: null, n: 0 }]);
      // ...and after a ROLLBACK.
      await withTenant(single.db, tenantA, () => Promise.reject(new Error('rollback'))).catch(
        () => undefined,
      );
      const afterRollback = await single.db.execute(sql`SELECT count(*)::int AS n FROM tenants`);
      expect(afterRollback.rows).toEqual([{ n: 0 }]);
    } finally {
      await single.close();
    }
  });

  it('keeps concurrent transactions apart', async () => {
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) => {
        const tenant = i % 2 === 0 ? tenantA : tenantB;
        return withTenant(db, tenant, async (tx) => {
          await tx.execute(sql`SELECT pg_sleep(0.01)`);
          const { rows: seen } = await tx.execute<{ id: string }>(
            sql`SELECT id::text FROM tenants`,
          );
          return { tenant, seen: seen.map((row) => row.id) };
        });
      }),
    );
    for (const { tenant, seen } of results) expect(seen).toEqual([tenant]);
  });

  it('fails closed on a malformed tenant setting', async () => {
    const error = await db
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', 'garbage', true)`);
        await tx.execute(sql`SELECT * FROM tenants`);
      })
      .catch((e: unknown) => e);
    expect(sqlState(error)).toBe('22P02'); // invalid_text_representation
  });

  it('ends with the transaction even when SQL inside it switched the setting', async () => {
    // A statement can switch the setting, which is why tenant ids come only from the session
    // and SQL is never built from LLM arguments; the switch still ends with the transaction.
    await withTenant(db, tenantA, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantB}, true)`);
    });
    const after = await db.execute(sql`SELECT count(*)::int AS n FROM tenants`);
    expect(after.rows).toEqual([{ n: 0 }]);
  });
});

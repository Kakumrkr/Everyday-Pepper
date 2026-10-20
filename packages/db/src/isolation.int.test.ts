// Cross-tenant isolation suite (docs/engineering/testing-strategy.md; must stay at 100%).
// Every table in `public` must be listed in TENANT_TABLES (row access limited by RLS) or in
// GLOBAL_TABLES (with a reason); the catalog test fails for a table that is in neither.
import { randomBytes } from 'node:crypto';
import {
  ClientIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  UsagePeriodSchema,
  type StaffMemberId,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './client.js';
import { newId } from './ids.js';
import { APP_ROLE } from './migrate.js';
import {
  insertService,
  insertStaffMember,
  insertTimeOff,
  replaceBookingRules,
  replaceStaffServices,
  replaceWorkingHours,
} from './repositories/appointments.js';
import { appendAuditEntry } from './repositories/audit.js';
import { insertBookingVerification } from './repositories/booking-verifications.js';
import { insertBooking, insertWaitlistEntry } from './repositories/bookings.js';
import { insertClient } from './repositories/clients.js';
import { insertInvite, withInviteTenant } from './repositories/invites.js';
import { addMembership, listUserBusinesses } from './repositories/memberships.js';
import { createTenant, withPublicTenant } from './repositories/tenants.js';
import { addUsage } from './repositories/usage.js';
import { withTenant, withUser, type TenantTx } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

/**
 * Tables that are not tenant-owned, with why. They have no RLS: the services' role reads and
 * writes them, and only Better Auth (through `authDatabaseAdapter`) and the session repository
 * use them (ADR-0012).
 */
const GLOBAL_TABLES: Record<string, string> = {
  users: 'auth identity; one person may belong to several businesses',
  sessions: 'Better Auth looks sessions up by cookie token before any tenant is known',
  accounts: 'sign-in methods (password hash) of a global user',
  verifications: 'short-lived Better Auth tokens, keyed by identifier, not by tenant',
  two_factors: 'TOTP secret and backup codes of a global user',
};

interface TenantTable {
  /** Column holding the owning tenant (`id` for `tenants` itself). */
  tenantColumn: string;
  /** Inserts one row owned by the transaction's tenant; returns its id. */
  seed: (tx: TenantTx) => Promise<string>;
  /** A harmless assignment for UPDATE probes. */
  touch: string;
  /** The `member_read` (withUser) predicate, as Postgres prints it, if the table has one. */
  memberRead?: string;
  /** The `invite_lookup` (withInviteTenant) predicate, as Postgres prints it, if any. */
  inviteLookup?: string;
  /** The `public_lookup` (withPublicTenant) predicate, as Postgres prints it, if any. */
  publicLookup?: string;
  /** The services may only insert and read (no UPDATE or DELETE grant). */
  appendOnly?: true;
  /**
   * The restrictive `member_scope*` policies (staff reach only their own records, ADR-0017),
   * as Postgres prints them; the staff scope itself is proven in bookings.int.test.ts.
   */
  memberScope?: {
    policyname: string;
    cmd: string;
    qual: string | null;
    with_check: string | null;
  }[];
}

/** The member-scope predicate on a staff member column, as Postgres prints it. */
const OWN_STAFF =
  '(( SELECT current_member_sees_all() AS current_member_sees_all) OR (staff_member_id IN ( SELECT current_member_staff_ids() AS current_member_staff_ids)))';
const SEES_ALL = '( SELECT current_member_sees_all() AS current_member_sees_all)';

const TENANT_TABLES: Record<string, TenantTable> = {
  tenants: {
    tenantColumn: 'id',
    // The tenant row already exists; return the transaction's tenant.
    seed: async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`SELECT current_tenant_id() AS id`);
      return String(rows[0]?.id);
    },
    touch: "name = name || ''",
    memberRead:
      '((current_tenant_id() IS NULL) AND (id IN ( SELECT memberships.tenant_id\n   FROM memberships\n  WHERE (memberships.user_id = current_user_id()))))',
    publicLookup: '((current_tenant_id() IS NULL) AND (slug = current_public_slug()))',
  },
  memberships: {
    tenantColumn: 'tenant_id',
    seed: async (tx) =>
      (await addMembership(tx, { userId: await insertUser(db), role: 'staff' })).id,
    touch: "role = 'manager'",
    memberRead: '((current_tenant_id() IS NULL) AND (user_id = current_user_id()))',
    memberScope: [
      {
        policyname: 'member_scope_delete',
        cmd: 'DELETE',
        qual: `(${SEES_ALL} OR (user_id = current_user_id()))`,
        with_check: null,
      },
      { policyname: 'member_scope_update', cmd: 'UPDATE', qual: 'true', with_check: SEES_ALL },
    ],
  },
  audit_log: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const entityId = newId();
      await appendAuditEntry(tx, {
        actor: { kind: 'system' },
        change: {
          action: 'membership.removed',
          entity: { type: 'membership', id: entityId },
          before: { userId: await insertUser(db), role: 'staff' },
          after: null,
        },
      });
      const { rows } = await tx.execute<{ id: string }>(
        sql`SELECT id::text FROM audit_log WHERE entity_id = ${entityId}`,
      );
      return String(rows[0]?.id);
    },
    touch: 'action = action',
    appendOnly: true,
  },
  usage_meters: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      await addUsage(tx, {
        metric: 'llm_tokens',
        period: UsagePeriodSchema.parse('2026-10'),
        amount: 1,
      });
      const { rows } = await tx.execute<{ id: string }>(sql`SELECT id::text FROM usage_meters`);
      return String(rows[0]?.id);
    },
    touch: 'amount = amount + 1',
  },
  invites: {
    tenantColumn: 'tenant_id',
    seed: async (tx) =>
      (
        await insertInvite(tx, {
          email: `invitee-${newId()}@example.test`,
          role: 'staff',
          tokenHash: randomBytes(32).toString('hex'),
          invitedBy: await insertUser(db),
          expiresAt: new Date(Date.now() + 86_400_000),
        })
      ).id,
    touch: "role = 'owner'",
    inviteLookup: '((current_tenant_id() IS NULL) AND (token_hash = current_invite_token_hash()))',
  },
  services: {
    tenantColumn: 'tenant_id',
    seed: async (tx) =>
      (
        await insertService(tx, {
          name: `Haircut ${newId()}`,
          category: null,
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          priceFromCents: 6500,
          priceToCents: null,
          active: true,
        })
      ).id,
    touch: "name = name || ''",
  },
  staff_members: {
    tenantColumn: 'tenant_id',
    seed: seedStaff,
    touch: 'active = NOT active',
    memberScope: [
      { policyname: 'member_scope_delete', cmd: 'DELETE', qual: SEES_ALL, with_check: null },
      { policyname: 'member_scope_insert', cmd: 'INSERT', qual: null, with_check: SEES_ALL },
      { policyname: 'member_scope_update', cmd: 'UPDATE', qual: 'true', with_check: SEES_ALL },
    ],
  },
  staff_services: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const staff = await seedStaff(tx);
      const service = await insertService(tx, {
        name: `Colour ${newId()}`,
        category: null,
        durationMinutes: 90,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        priceFromCents: null,
        priceToCents: null,
        active: true,
      });
      await replaceStaffServices(tx, staff, [ServiceIdSchema.parse(service.id)]);
      return idWhere(tx, 'staff_services', 'staff_member_id', staff);
    },
    touch: 'created_at = created_at',
  },
  working_hours: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const staff = await seedStaff(tx);
      await replaceWorkingHours(tx, staff, [{ weekday: 1, startMinute: 540, endMinute: 1020 }]);
      return idWhere(tx, 'working_hours', 'staff_member_id', staff);
    },
    touch: 'weekday = weekday',
  },
  time_off: {
    tenantColumn: 'tenant_id',
    seed: async (tx) =>
      (
        await insertTimeOff(tx, {
          staffMemberId: await seedStaff(tx),
          startsAt: new Date('2026-10-20T13:00:00Z'),
          endsAt: new Date('2026-10-20T17:00:00Z'),
          createdBy: await insertUser(db),
        })
      ).id,
    touch: 'created_at = created_at',
  },
  booking_rules: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const staff = await seedStaff(tx);
      await replaceBookingRules(tx, [
        { type: 'max_bookings_per_day', version: 1, staffMemberId: staff, params: { count: 6 } },
      ]);
      return idWhere(tx, 'booking_rules', 'staff_member_id', staff);
    },
    touch: 'version = version',
  },
  clients: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => (await seedClient(tx)).toString(),
    touch: "name = name || ''",
    memberScope: [
      {
        policyname: 'member_scope',
        cmd: 'ALL',
        qual: '(( SELECT current_member_sees_all() AS current_member_sees_all) OR (id IN ( SELECT bookings.client_id\n   FROM bookings)) OR (id IN ( SELECT waitlist_entries.client_id\n   FROM waitlist_entries)) OR ((( SELECT current_client_contact() AS current_client_contact) = email) OR (( SELECT current_client_contact() AS current_client_contact) = phone)))',
        with_check: SEES_ALL,
      },
      { policyname: 'member_scope_delete', cmd: 'DELETE', qual: SEES_ALL, with_check: null },
    ],
  },
  bookings: {
    tenantColumn: 'tenant_id',
    seed: seedBooking,
    touch: "status = 'cancelled'",
    memberScope: [
      { policyname: 'member_scope', cmd: 'ALL', qual: OWN_STAFF, with_check: OWN_STAFF },
    ],
  },
  booking_occupancy: {
    tenantColumn: 'tenant_id',
    // The trigger writes the booking's occupied time under the booking's id.
    seed: seedBooking,
    touch: 'starts_at = starts_at',
    memberScope: [
      { policyname: 'member_scope_delete', cmd: 'DELETE', qual: OWN_STAFF, with_check: null },
      { policyname: 'member_scope_insert', cmd: 'INSERT', qual: null, with_check: OWN_STAFF },
      { policyname: 'member_scope_update', cmd: 'UPDATE', qual: OWN_STAFF, with_check: OWN_STAFF },
    ],
  },
  waitlist_entries: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const service = await seedService(tx);
      return (
        await insertWaitlistEntry(tx, {
          clientId: await seedClient(tx),
          serviceId: service,
          staffMemberId: null,
          windows: [{ date: '2026-10-23', start: '15:00', end: '18:00' }],
          expiresAt: new Date('2026-10-23T22:00:00Z'),
          createdBy: await insertUser(db),
        })
      ).id;
    },
    touch: "status = 'cancelled'",
    memberScope: [
      { policyname: 'member_scope', cmd: 'ALL', qual: OWN_STAFF, with_check: OWN_STAFF },
    ],
  },
  booking_verifications: {
    tenantColumn: 'tenant_id',
    seed: async (tx) =>
      (
        await insertBookingVerification(tx, {
          serviceId: await seedService(tx),
          staffMemberId: null,
          startsAt: new Date('2026-10-23T15:00:00Z'),
          name: 'Ana Ruiz',
          email: `ana-${newId()}@example.test`,
          phone: null,
          codeHash: randomBytes(32).toString('hex'),
          expiresAt: new Date('2026-10-20T15:10:00Z'),
        })
      ).id,
    touch: 'attempts = attempts + 1',
    // Members never reach booking requests; only the booking page (no user) does.
    memberScope: [
      {
        policyname: 'member_scope',
        cmd: 'ALL',
        qual: '(current_user_id() IS NULL)',
        with_check: '(current_user_id() IS NULL)',
      },
    ],
  },
};

/** A new client of the transaction's tenant. */
async function seedClient(tx: TenantTx) {
  const client = await insertClient(tx, {
    name: 'Maria Lopez',
    email: `maria-${newId()}@example.test`,
    phone: null,
    source: 'team',
  });
  return ClientIdSchema.parse(client.id);
}

/** A new active service of the transaction's tenant. */
async function seedService(tx: TenantTx) {
  const service = await insertService(tx, {
    name: `Blow-dry ${newId()}`,
    category: null,
    durationMinutes: 45,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    priceFromCents: null,
    priceToCents: null,
    active: true,
  });
  return ServiceIdSchema.parse(service.id);
}

/** A new confirmed booking (with its client, service and staff member); returns its id. */
async function seedBooking(tx: TenantTx): Promise<string> {
  const booking = await insertBooking(tx, {
    clientId: await seedClient(tx),
    serviceId: await seedService(tx),
    staffMemberId: await seedStaff(tx),
    startsAt: new Date('2026-10-20T14:00:00Z'),
    endsAt: new Date('2026-10-20T14:45:00Z'),
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 10,
    priceFromCents: null,
    priceToCents: null,
    source: 'team',
    overridden: false,
    idempotencyKey: null,
    createdBy: null,
  });
  return booking.id;
}

/** A new active staff member of the transaction's tenant. */
async function seedStaff(tx: TenantTx): Promise<StaffMemberId> {
  const staff = await insertStaffMember(tx, {
    displayName: 'Jess',
    color: '#2a7230',
    active: true,
    membershipId: null,
  });
  return StaffMemberIdSchema.parse(staff.id);
}

/** The id of the one row of `table` that `column` = `value` selects. */
async function idWhere(tx: TenantTx, table: string, column: string, value: string) {
  const { rows } = await tx.execute<{ id: string }>(
    sql.raw(`SELECT id::text FROM ${table} WHERE ${column} = '${value}'`),
  );
  return String(rows[0]?.id);
}

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
    '%s has forced RLS, the tenant_isolation policy and only the policies listed',
    async (table, spec) => {
      const [flags] = await asAdmin<{ enabled: boolean; forced: boolean }>(
        `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
           FROM pg_class WHERE oid = $1::regclass`,
        [`public.${table}`],
      );
      expect(flags).toEqual({ enabled: true, forced: true });
      const policies = await asAdmin(
        `SELECT policyname, permissive, cmd, roles::text[] AS roles, qual, with_check
           FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 ORDER BY policyname`,
        [table],
      );
      const predicate = `(${spec.tenantColumn} = current_tenant_id())`;
      const expected = [
        ...(spec.inviteLookup === undefined
          ? []
          : [
              {
                policyname: 'invite_lookup',
                permissive: 'PERMISSIVE',
                cmd: 'SELECT',
                roles: ['public'],
                qual: spec.inviteLookup,
                with_check: null,
              },
            ]),
        ...(spec.memberRead === undefined
          ? []
          : [
              {
                policyname: 'member_read',
                permissive: 'PERMISSIVE',
                cmd: 'SELECT',
                roles: ['public'],
                qual: spec.memberRead,
                with_check: null,
              },
            ]),
        ...(spec.memberScope ?? []).map((policy) => ({
          ...policy,
          permissive: 'RESTRICTIVE',
          roles: ['public'],
        })),
        ...(spec.publicLookup === undefined
          ? []
          : [
              {
                policyname: 'public_lookup',
                permissive: 'PERMISSIVE',
                cmd: 'SELECT',
                roles: ['public'],
                qual: spec.publicLookup,
                with_check: null,
              },
            ]),
        {
          policyname: 'tenant_isolation',
          permissive: 'PERMISSIVE',
          cmd: 'ALL',
          roles: ['public'],
          qual: predicate,
          with_check: predicate,
        },
      ];
      expect(policies).toEqual(expected);
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

  it(`${APP_ROLE} may write every tenant table except the append-only ones`, async () => {
    const grants = await asAdmin<{ table: string; privileges: string[] }>(
      `SELECT table_name AS table, array_agg(privilege_type::text ORDER BY privilege_type) AS privileges
         FROM information_schema.role_table_grants
        WHERE grantee = $1 AND table_schema = 'public' GROUP BY table_name`,
      [APP_ROLE],
    );
    const byTable = Object.fromEntries(grants.map((g) => [g.table, g.privileges]));
    for (const [table, spec] of Object.entries(TENANT_TABLES)) {
      expect(byTable[table], table).toEqual(
        spec.appendOnly === true ? ['INSERT', 'SELECT'] : ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      );
    }
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

  /** Runs a write probe: affected row count, or 'denied' on an append-only table. */
  async function write(tenant: TenantId, statement: string): Promise<number | null | 'denied'> {
    if (spec.appendOnly === true) {
      const error = await inTenant(tenant, statement).catch((e: unknown) => e);
      expect(sqlState(error)).toBe('42501');
      return 'denied';
    }
    return (await inTenant(tenant, statement)).rowCount;
  }
  const none = spec.appendOnly === true ? 'denied' : 0;

  it("another tenant's row cannot be updated or deleted", async () => {
    const before = await inTenant(tenantB, `SELECT * FROM ${table} WHERE id = '${ids().b}'`);
    const updated = await write(
      tenantA,
      `UPDATE ${table} SET ${spec.touch} WHERE id = '${ids().b}'`,
    );
    const deleted = await write(tenantA, `DELETE FROM ${table} WHERE id = '${ids().b}'`);
    expect([updated, deleted]).toEqual([none, none]);
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
    // 42501 either way: the policy's WITH CHECK, or no UPDATE grant on an append-only table.
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
    const probe = async (statement: string) => {
      if (spec.appendOnly !== true) return (await db.execute(sql.raw(statement))).rowCount;
      const error = await db.execute(sql.raw(statement)).catch((e: unknown) => e);
      return sqlState(error) === '42501' ? 'denied' : error;
    };
    const updated = await probe(`UPDATE ${table} SET ${spec.touch}`);
    const deleted = await probe(`DELETE FROM ${table}`);
    expect([updated, deleted]).toEqual([none, none]);
  });
});

describe('user context (withUser: "my businesses")', () => {
  let ana: UserId;
  let ben: UserId;

  beforeAll(async () => {
    // Ana owns A and is staff at B; Ben is staff at A only.
    ana = await insertUser(db, 'Ana');
    ben = await insertUser(db, 'Ben');
    await withTenant(db, tenantA, (tx) => addMembership(tx, { userId: ana, role: 'owner' }));
    await withTenant(db, tenantB, (tx) => addMembership(tx, { userId: ana, role: 'staff' }));
    await withTenant(db, tenantA, (tx) => addMembership(tx, { userId: ben, role: 'staff' }));
  });

  it("lists exactly the user's businesses with their role", async () => {
    const anas = await withUser(db, ana, listUserBusinesses);
    expect(anas.map((b) => [b.tenantId, b.role])).toEqual([
      [tenantA, 'owner'],
      [tenantB, 'staff'],
    ]);
    const bens = await withUser(db, ben, listUserBusinesses);
    expect(bens.map((b) => [b.tenantId, b.role])).toEqual([[tenantA, 'staff']]);
  });

  it("sees only the user's own memberships, not their colleagues'", async () => {
    const { rows: seen } = await withUser(db, ben, (tx) =>
      tx.execute<{ user_id: string }>(sql`SELECT user_id::text FROM memberships`),
    );
    expect(seen).toEqual([{ user_id: ben }]);
  });

  it('sees no tenant the user is not a member of', async () => {
    const { rows: seen } = await withUser(db, ben, (tx) =>
      tx.execute<{ id: string }>(sql`SELECT id::text FROM tenants`),
    );
    expect(seen).toEqual([{ id: tenantA }]);
  });

  it('sees nothing for a user without memberships', async () => {
    const loner = await insertUser(db, 'Loner');
    await expect(withUser(db, loner, listUserBusinesses)).resolves.toEqual([]);
  });

  it.each([
    [
      'insert a membership',
      (user: UserId) => `INSERT INTO memberships (id, tenant_id, user_id, role)
       VALUES ('${newId()}', (SELECT tenant_id FROM memberships LIMIT 1), '${user}', 'owner')`,
    ],
    ['update a membership', () => "UPDATE memberships SET role = 'owner'"],
    ['delete a membership', () => 'DELETE FROM memberships'],
    ['rename a business', () => "UPDATE tenants SET name = 'mine'"],
  ])('cannot %s (read-only transaction)', async (_label, statement) => {
    const error = await withUser(db, ben, (tx) => tx.execute(sql.raw(statement(ben)))).catch(
      (e: unknown) => e,
    );
    expect(sqlState(error)).toBe('25006'); // read_only_sql_transaction
  });

  it('cannot write even in a read-write transaction: member_read is SELECT only', async () => {
    const { updated, deleted } = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${ben}, true)`);
      return {
        updated: (await tx.execute(sql`UPDATE memberships SET role = 'owner'`)).rowCount,
        deleted: (await tx.execute(sql`DELETE FROM tenants`)).rowCount,
      };
    });
    expect([updated, deleted]).toEqual([0, 0]);
  });

  it("does not widen a tenant transaction: with a tenant set, the user's other businesses stay hidden", async () => {
    const { tenantIds, memberIds } = await withTenant(db, tenantB, async (tx) => {
      // Ana belongs to A as well; setting her as the user must not reveal A inside B.
      await tx.execute(sql`SELECT set_config('app.user_id', ${ana}, true)`);
      const t = await tx.execute<{ id: string }>(sql`SELECT id::text FROM tenants`);
      const m = await tx.execute<{ tenant_id: string }>(
        sql`SELECT DISTINCT tenant_id::text FROM memberships`,
      );
      return { tenantIds: t.rows.map((r) => r.id), memberIds: m.rows.map((r) => r.tenant_id) };
    });
    expect(tenantIds).toEqual([tenantB]);
    expect(memberIds).toEqual([tenantB]);
  });

  it('does not outlive the transaction on a pooled connection', async () => {
    const single = createDatabase({ url: database.appUrl, maxConnections: 1 });
    try {
      await expect(withUser(single.db, ana, listUserBusinesses)).resolves.toHaveLength(2);
      const after = await single.db.execute(
        sql`SELECT current_user_id() AS id, count(*)::int AS n FROM memberships`,
      );
      expect(after.rows).toEqual([{ id: null, n: 0 }]);
    } finally {
      await single.close();
    }
  });

  it('fails closed on a malformed user setting', async () => {
    const error = await db
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.user_id', 'garbage', true)`);
        await tx.execute(sql`SELECT * FROM memberships`);
      })
      .catch((e: unknown) => e);
    expect(sqlState(error)).toBe('22P02');
  });
});

describe('invite lookup (withInviteTenant: an invitee who is not a member yet)', () => {
  function inviteIds(): { a: string; b: string } {
    const ids = rows['invites'];
    if (ids === undefined) throw new Error('no seed invites');
    return ids;
  }

  async function hashOf(tenant: TenantId, id: string): Promise<string> {
    const { rows: found } = await inTenant<{ token_hash: string }>(
      tenant,
      `SELECT token_hash FROM invites WHERE id = '${id}'`,
    );
    return String(found[0]?.token_hash);
  }

  /** Raw SQL with only the token hash set (no tenant), in one transaction. */
  function withHash<T extends Record<string, unknown>>(hash: string, statement: string) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.invite_token_hash', ${hash}, true)`);
      return tx.execute<T>(sql.raw(statement));
    });
  }

  it("shows exactly the invite whose token hash is presented, bound to that invite's tenant", async () => {
    const invites = inviteIds();
    const seen = await withInviteTenant(
      db,
      await hashOf(tenantB, invites.b),
      async (tx, invite) => {
        const { rows: tenant } = await tx.execute<{ id: string }>(
          sql`SELECT current_tenant_id()::text AS id`,
        );
        return { invite: invite.id, tenant: tenant[0]?.id };
      },
    );
    expect(seen).toEqual({ invite: invites.b, tenant: tenantB });
  });

  it('shows nothing for a hash no invite has', async () => {
    let called = false;
    const result = await withInviteTenant(db, randomBytes(32).toString('hex'), () => {
      called = true;
      return Promise.resolve('reached');
    });
    expect([result, called]).toEqual([undefined, false]);
  });

  it('a hash reveals no other invite, tenant or membership', async () => {
    const hash = await hashOf(tenantA, inviteIds().a);
    const { rows: seen } = await withHash<{ id: string }>(hash, 'SELECT id::text FROM invites');
    expect(seen).toEqual([{ id: inviteIds().a }]);
    for (const table of ['tenants', 'memberships', 'audit_log', 'usage_meters']) {
      const { rows: other } = await withHash(hash, `SELECT * FROM ${table}`);
      expect(other, table).toEqual([]);
    }
  });

  it('a hash cannot change the invite: invite_lookup is SELECT only', async () => {
    const hash = await hashOf(tenantA, inviteIds().a);
    const updated = await withHash(hash, "UPDATE invites SET role = 'owner'");
    const deleted = await withHash(hash, 'DELETE FROM invites');
    expect([updated.rowCount, deleted.rowCount]).toEqual([0, 0]);
  });

  it("does not widen a tenant transaction: another tenant's invite stays hidden", async () => {
    const hash = await hashOf(tenantB, inviteIds().b);
    const { rows: seen } = await withTenant(db, tenantA, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.invite_token_hash', ${hash}, true)`);
      return tx.execute(sql`SELECT * FROM invites WHERE token_hash = ${hash}`);
    });
    expect(seen).toEqual([]);
  });

  it('a read-only lookup cannot write', async () => {
    const hash = await hashOf(tenantA, inviteIds().a);
    const error = await withInviteTenant(
      db,
      hash,
      (tx) => tx.execute(sql`UPDATE invites SET role = role`),
      { readOnly: true },
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('25006');
  });

  it('does not outlive the transaction on a pooled connection', async () => {
    const single = createDatabase({ url: database.appUrl, maxConnections: 1 });
    try {
      const hash = await hashOf(tenantA, inviteIds().a);
      await withInviteTenant(single.db, hash, () => Promise.resolve());
      const after = await single.db.execute(
        sql`SELECT current_invite_token_hash() AS hash, count(*)::int AS n FROM invites`,
      );
      expect(after.rows).toEqual([{ hash: null, n: 0 }]);
    } finally {
      await single.close();
    }
  });
});

describe('public lookup (withPublicTenant: the booking page finds its business by slug)', () => {
  /** Raw SQL with only the slug set (no tenant), in one transaction. */
  function withSlug<T extends Record<string, unknown>>(slug: string, statement: string) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.public_slug', ${slug}, true)`);
      return tx.execute<T>(sql.raw(statement));
    });
  }

  it('binds the transaction to the business with that slug, without a user', async () => {
    const seen = await withPublicTenant(db, 'tenant-b', async (tx, tenant) => {
      const { rows: context } = await tx.execute<{ tenant: string; user: string | null }>(
        sql`SELECT current_tenant_id()::text AS tenant, current_user_id()::text AS user`,
      );
      return { id: tenant.id, ...context[0] };
    });
    expect(seen).toEqual({ id: tenantB, tenant: tenantB, user: null });
  });

  it('finds nothing for a slug no business has', async () => {
    let called = false;
    const result = await withPublicTenant(db, 'no-such-business', () => {
      called = true;
      return Promise.resolve('reached');
    });
    expect([result, called]).toEqual([undefined, false]);
  });

  it('a slug shows only its own business row, and no other table', async () => {
    const { rows: seen } = await withSlug<{ id: string }>(
      'tenant-a',
      'SELECT id::text FROM tenants',
    );
    expect(seen).toEqual([{ id: tenantA }]);
    for (const table of Object.keys(TENANT_TABLES).filter((t) => t !== 'tenants')) {
      const { rows: other } = await withSlug('tenant-a', `SELECT * FROM ${table}`);
      expect(other, table).toEqual([]);
    }
  });

  it('a slug cannot change the business: public_lookup is SELECT only', async () => {
    const updated = await withSlug('tenant-a', "UPDATE tenants SET name = 'taken'");
    const deleted = await withSlug('tenant-a', 'DELETE FROM tenants');
    expect([updated.rowCount, deleted.rowCount]).toEqual([0, 0]);
  });

  it("does not widen a tenant transaction: another business's row stays hidden", async () => {
    const { rows: seen } = await withTenant(db, tenantA, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.public_slug', 'tenant-b', true)`);
      return tx.execute(sql`SELECT id FROM tenants WHERE slug = 'tenant-b'`);
    });
    expect(seen).toEqual([]);
  });

  it("a member transaction cannot read booking requests, even an owner's", async () => {
    const user = await insertUser(db);
    await withTenant(db, tenantA, (tx) => addMembership(tx, { userId: user, role: 'owner' }));
    const { rows: seen } = await withTenant(db, tenantA, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${user}, true)`);
      return tx.execute(sql`SELECT id FROM booking_verifications`);
    });
    expect(seen).toEqual([]);
  });

  it('a read-only lookup cannot write', async () => {
    const error = await withPublicTenant(
      db,
      'tenant-a',
      (tx) => tx.execute(sql`UPDATE tenants SET name = name`),
      { readOnly: true },
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('25006');
  });

  it('does not outlive the transaction on a pooled connection', async () => {
    const single = createDatabase({ url: database.appUrl, maxConnections: 1 });
    try {
      await withPublicTenant(single.db, 'tenant-a', () => Promise.resolve());
      const after = await single.db.execute(
        sql`SELECT current_public_slug() AS slug, count(*)::int AS n FROM tenants`,
      );
      expect(after.rows).toEqual([{ slug: null, n: 0 }]);
    } finally {
      await single.close();
    }
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

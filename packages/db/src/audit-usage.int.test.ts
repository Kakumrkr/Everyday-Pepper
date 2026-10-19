import {
  TenantIdSchema,
  UsagePeriodSchema,
  type AuditChange,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import { appendAuditEntry, listAuditEntries } from './repositories/audit.js';
import { createTenant } from './repositories/tenants.js';
import { addUsage, listUsage } from './repositories/usage.js';
import { usageMeters, users } from './schema.js';
import { withTenant } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

let database: TestDatabase;
let db: Database;
let tenant: TenantId;
let ana: UserId;

beforeAll(async () => {
  database = await startTestDatabase({ maxConnections: 8 });
  db = database.app.db;
  ana = await insertUser(db, 'Ana');
  tenant = await newTenant('audited', ana);
});

afterAll(async () => {
  await database.stop();
});

async function newTenant(slug: string, owner?: UserId): Promise<TenantId> {
  const options = owner === undefined ? {} : { owner };
  const created = await createTenant(db, { name: slug, slug, timeZone: 'UTC' }, options);
  return TenantIdSchema.parse(created.id);
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

function roleChange(userId: UserId, from: 'staff' | 'manager', to: 'staff' | 'manager') {
  return {
    action: 'membership.role_changed',
    entity: { type: 'membership', id: newId() },
    before: { userId, role: from },
    after: { userId, role: to },
  } satisfies AuditChange;
}

describe('audit log', () => {
  it('appends entries and lists them newest first, a page at a time', async () => {
    const t = await newTenant('audit-pages', ana);
    const changes = [
      roleChange(ana, 'staff', 'manager'),
      roleChange(ana, 'manager', 'staff'),
      roleChange(ana, 'staff', 'manager'),
    ];
    for (const change of changes) {
      await withTenant(db, t, (tx) =>
        appendAuditEntry(tx, { actor: { kind: 'user', userId: ana }, change, requestId: 'req-1' }),
      );
    }
    const first = await withTenant(db, t, (tx) => listAuditEntries(tx, { limit: 2 }));
    expect(first.map((e) => e.entity.id)).toEqual([changes[2]?.entity.id, changes[1]?.entity.id]);
    expect(first[0]).toMatchObject({
      actor: { kind: 'user', userId: ana },
      action: 'membership.role_changed',
      before: { userId: ana, role: 'staff' },
      after: { userId: ana, role: 'manager' },
    });
    expect(first[0]?.at).toMatch(/Z$/);
    const second = await withTenant(db, t, (tx) =>
      listAuditEntries(tx, { limit: 2, before: first[1]?.id }),
    );
    expect(second.map((e) => e.entity.id)).toEqual([changes[0]?.entity.id]);
    const [stored] = await asAdmin<{ request_id: string }>(
      'SELECT request_id FROM audit_log WHERE entity_id = $1',
      [changes[0]?.entity.id],
    );
    expect(stored?.request_id).toBe('req-1');
  });

  it('records a system actor without a user', async () => {
    const t = await newTenant('audit-system');
    await withTenant(db, t, (tx) =>
      appendAuditEntry(tx, {
        actor: { kind: 'system' },
        change: roleChange(ana, 'staff', 'manager'),
      }),
    );
    const [entry] = await withTenant(db, t, (tx) => listAuditEntries(tx, { limit: 1 }));
    expect(entry?.actor).toEqual({ kind: 'system', userId: null });
  });

  it('refuses fields outside the action schema before writing', async () => {
    const t = await newTenant('audit-allowlist');
    const leaky = {
      ...roleChange(ana, 'staff', 'manager'),
      after: { userId: ana, role: 'manager', email: 'ana@example.test' },
    } as unknown as AuditChange;
    await expect(
      withTenant(db, t, (tx) => appendAuditEntry(tx, { actor: { kind: 'system' }, change: leaky })),
    ).rejects.toThrow();
    await expect(
      withTenant(db, t, (tx) =>
        appendAuditEntry(tx, {
          actor: { kind: 'system' },
          change: roleChange(ana, 'staff', 'manager'),
          requestId: 'x'.repeat(129),
        }),
      ),
    ).rejects.toThrow();
    await expect(withTenant(db, t, (tx) => listAuditEntries(tx, { limit: 10 }))).resolves.toEqual(
      [],
    );
  });

  it('rolls back with the change it records', async () => {
    const t = await newTenant('audit-rollback');
    await withTenant(db, t, async (tx) => {
      await appendAuditEntry(tx, {
        actor: { kind: 'system' },
        change: roleChange(ana, 'staff', 'manager'),
      });
      throw new Error('the change failed');
    }).catch(() => undefined);
    await expect(withTenant(db, t, (tx) => listAuditEntries(tx, { limit: 10 }))).resolves.toEqual(
      [],
    );
  });

  it.each([
    ['update', 'UPDATE audit_log SET action = action'],
    ['delete', 'DELETE FROM audit_log'],
    ['truncate', 'TRUNCATE audit_log'],
  ])('cannot be changed by the services: %s', async (_label, statement) => {
    const error = await withTenant(db, tenant, (tx) => tx.execute(sql.raw(statement))).catch(
      (e: unknown) => e,
    );
    expect(sqlState(error)).toBe('42501'); // insufficient_privilege
  });

  it('a system entry cannot name a user (check constraint)', async () => {
    const error = await withTenant(db, tenant, (tx) =>
      tx.execute(sql`INSERT INTO audit_log (id, actor_kind, actor_user_id, action, entity_type, entity_id)
                     VALUES (${newId()}, 'system', ${ana}, 'x', 'x', ${newId()})`),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514'); // check_violation
  });

  it("keeps a deleted user's entries without their id, and goes with the tenant", async () => {
    const ben = await insertUser(db, 'Ben');
    const t = await newTenant('audit-erasure', ben);
    await withTenant(db, t, (tx) =>
      appendAuditEntry(tx, {
        actor: { kind: 'user', userId: ben },
        change: roleChange(ben, 'staff', 'manager'),
      }),
    );
    // Account deletion is a global operation (no tenant); the foreign key nulls the actor even
    // though the services cannot update audit rows themselves.
    await db.delete(users).where(eq(users.id, ben));
    const [entry] = await withTenant(db, t, (tx) => listAuditEntries(tx, { limit: 1 }));
    expect(entry?.actor).toEqual({ kind: 'user', userId: null });

    await asAdmin('DELETE FROM tenants WHERE id = $1', [t]);
    const left = await asAdmin('SELECT 1 FROM audit_log WHERE tenant_id = $1', [t]);
    expect(left).toEqual([]);
  });
});

describe('usage meters', () => {
  const october = UsagePeriodSchema.parse('2026-10');
  const november = UsagePeriodSchema.parse('2026-11');

  it('adds up per metric and month', async () => {
    const t = await newTenant('usage-sum');
    await withTenant(db, t, async (tx) => {
      await addUsage(tx, { metric: 'llm_tokens', period: october, amount: 1200 });
      await addUsage(tx, { metric: 'llm_tokens', period: october, amount: 300 });
      await addUsage(tx, { metric: 'emails_sent', period: october, amount: 2 });
      await addUsage(tx, { metric: 'llm_tokens', period: november, amount: 7 });
    });
    await expect(withTenant(db, t, (tx) => listUsage(tx, october))).resolves.toEqual([
      { metric: 'llm_tokens', amount: 1500 },
      { metric: 'emails_sent', amount: 2 },
    ]);
    await expect(withTenant(db, t, (tx) => listUsage(tx, november))).resolves.toEqual([
      { metric: 'llm_tokens', amount: 7 },
    ]);
  });

  it('loses no increment under concurrency', async () => {
    const t = await newTenant('usage-concurrent');
    await Promise.all(
      Array.from({ length: 40 }, () =>
        withTenant(db, t, (tx) =>
          addUsage(tx, { metric: 'emails_sent', period: october, amount: 3 }),
        ),
      ),
    );
    await expect(withTenant(db, t, (tx) => listUsage(tx, october))).resolves.toEqual([
      { metric: 'emails_sent', amount: 120 },
    ]);
  });

  it("keeps tenants' counters apart", async () => {
    const a = await newTenant('usage-a');
    const b = await newTenant('usage-b');
    await withTenant(db, a, (tx) =>
      addUsage(tx, { metric: 'llm_tokens', period: october, amount: 5 }),
    );
    await withTenant(db, b, (tx) =>
      addUsage(tx, { metric: 'llm_tokens', period: october, amount: 9 }),
    );
    await expect(withTenant(db, a, (tx) => listUsage(tx, october))).resolves.toEqual([
      { metric: 'llm_tokens', amount: 5 },
    ]);
  });

  it.each([0, -5, 1.5])('rejects the amount %d', async (amount) => {
    await expect(
      withTenant(db, tenant, (tx) =>
        addUsage(tx, { metric: 'llm_tokens', period: october, amount }),
      ),
    ).rejects.toThrow();
  });

  it('the database rejects a malformed period or a negative total', async () => {
    const period = await withTenant(db, tenant, (tx) =>
      tx.execute(
        sql`INSERT INTO usage_meters (id, metric, period, amount) VALUES (${newId()}, 'llm_tokens', '2026-13', 1)`,
      ),
    ).catch((e: unknown) => e);
    const negative = await withTenant(db, tenant, (tx) =>
      tx.execute(
        sql`INSERT INTO usage_meters (id, metric, period, amount) VALUES (${newId()}, 'llm_tokens', '2026-01', -1)`,
      ),
    ).catch((e: unknown) => e);
    expect([sqlState(period), sqlState(negative)]).toEqual(['23514', '23514']);
  });

  it('cannot be recorded without a tenant', async () => {
    const error = await db
      .insert(usageMeters)
      .values({ metric: 'llm_tokens', period: october, amount: 1 })
      .catch((e: unknown) => e);
    // No tenant set: tenant_id defaults to NULL, which the policy's WITH CHECK refuses.
    expect(sqlState(error)).toBe('42501');
  });
});

import { TenantIdSchema, UserIdSchema } from '@floty/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { MembershipExistsError, TenantSlugTakenError } from './errors.js';
import { newId } from './ids.js';
import {
  addMembership,
  findMembership,
  listMemberships,
  listUserBusinesses,
} from './repositories/memberships.js';
import { setSessionActiveTenant } from './repositories/sessions.js';
import { createTenant, findCurrentTenant } from './repositories/tenants.js';
import { sessions, users } from './schema.js';
import { withTenant, withUser } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

const juniper = { name: 'Juniper Hair Studio', slug: 'juniper', timeZone: 'America/New_York' };

describe('tenants', () => {
  it('creates a tenant visible inside its own context', async () => {
    const created = await createTenant(db, juniper);
    expect(created).toMatchObject({ ...juniper, locale: 'en-US' });
    expect(created.id).toMatch(/^[0-9a-f-]{8}-[0-9a-f]{4}-7/); // UUID v7
    expect(created.createdAt).toBeInstanceOf(Date);

    const current = await withTenant(db, TenantIdSchema.parse(created.id), findCurrentTenant);
    expect(current).toEqual(created);
  });

  it('rejects a taken slug with a domain error', async () => {
    await expect(createTenant(db, { ...juniper, name: 'Copycat' })).rejects.toBeInstanceOf(
      TenantSlugTakenError,
    );
  });

  it('adds the owner membership in the same transaction', async () => {
    const owner = await insertUser(db, 'Ana');
    const tenant = await createTenant(db, { ...juniper, slug: 'with-owner' }, { owner });
    const members = await withTenant(db, TenantIdSchema.parse(tenant.id), listMemberships);
    expect(members.map((m) => [m.userId, m.role])).toEqual([[owner, 'owner']]);
    await expect(withUser(db, owner, listUserBusinesses)).resolves.toEqual([
      { tenantId: tenant.id, name: juniper.name, slug: 'with-owner', role: 'owner' },
    ]);
  });

  it('creates nothing when the owner does not exist', async () => {
    const ghost = UserIdSchema.parse(newId());
    const error = await createTenant(
      db,
      { ...juniper, slug: 'ghost-owner' },
      { owner: ghost },
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23503'); // foreign_key_violation
    // The slug is still free: the tenant insert rolled back with the membership.
    await expect(createTenant(db, { ...juniper, slug: 'ghost-owner' })).resolves.toBeDefined();
  });

  it('validates input before writing', async () => {
    await expect(createTenant(db, { ...juniper, slug: 'Bad Slug' })).rejects.toThrow();
    await expect(
      createTenant(db, { ...juniper, slug: 'tz-check', timeZone: 'Mars/Base' }),
    ).rejects.toThrow();
  });

  it('keeps updated_at current', async () => {
    const tenant = await createTenant(db, { ...juniper, slug: 'updated-at' });
    const id = TenantIdSchema.parse(tenant.id);
    const [after] = await withTenant(db, id, async (tx) => {
      await tx.execute(sql`SELECT pg_sleep(0.01)`);
      const result = await tx.execute<{ created_at: string; updated_at: string }>(
        sql`UPDATE tenants SET name = 'Renamed' RETURNING created_at::text, updated_at::text`,
      );
      return result.rows;
    });
    expect(after?.updated_at).not.toBe(after?.created_at);
  });
});

describe('memberships', () => {
  it('adds, finds and lists members of the current tenant only', async () => {
    const a = TenantIdSchema.parse((await createTenant(db, { ...juniper, slug: 'members-a' })).id);
    const b = TenantIdSchema.parse((await createTenant(db, { ...juniper, slug: 'members-b' })).id);
    const owner = await insertUser(db, 'Owner');
    const stylist = await insertUser(db, 'Stylist');

    const added = await withTenant(db, a, async (tx) => [
      await addMembership(tx, { userId: owner, role: 'owner' }),
      await addMembership(tx, { userId: stylist, role: 'staff' }),
    ]);
    // tenant_id comes from the transaction, never from the caller.
    expect(added.map((m) => m.tenantId)).toEqual([a, a]);
    await withTenant(db, b, (tx) => addMembership(tx, { userId: owner, role: 'manager' }));

    const listed = await withTenant(db, a, listMemberships);
    expect(listed.map((m) => [m.userId, m.role])).toEqual([
      [owner, 'owner'],
      [stylist, 'staff'],
    ]);
    expect(await withTenant(db, b, (tx) => findMembership(tx, owner))).toMatchObject({
      tenantId: b,
      role: 'manager',
    });
    expect(await withTenant(db, b, (tx) => findMembership(tx, stylist))).toBeUndefined();
  });

  it('rejects a duplicate membership with a domain error', async () => {
    const tenant = TenantIdSchema.parse((await createTenant(db, { ...juniper, slug: 'dupes' })).id);
    const user = await insertUser(db);
    await withTenant(db, tenant, (tx) => addMembership(tx, { userId: user, role: 'staff' }));
    await expect(
      withTenant(db, tenant, (tx) => addMembership(tx, { userId: user, role: 'owner' })),
    ).rejects.toBeInstanceOf(MembershipExistsError);
  });

  it('rejects an unknown role', async () => {
    const tenant = TenantIdSchema.parse((await createTenant(db, { ...juniper, slug: 'roles' })).id);
    await expect(
      withTenant(db, tenant, (tx) =>
        // @ts-expect-error -- runtime validation of a role outside the enum
        addMembership(tx, { userId: UserIdSchema.parse(newId()), role: 'admin' }),
      ),
    ).rejects.toThrow();
  });

  it('are deleted with their tenant', async () => {
    const tenant = TenantIdSchema.parse(
      (await createTenant(db, { ...juniper, slug: 'cascade' })).id,
    );
    const user = await insertUser(db);
    await withTenant(db, tenant, (tx) => addMembership(tx, { userId: user, role: 'owner' }));
    const remaining = await withTenant(db, tenant, async (tx) => {
      await tx.execute(sql`DELETE FROM tenants`);
      return listMemberships(tx);
    });
    expect(remaining).toEqual([]);
  });
});

describe('users', () => {
  it('deleting a user removes their memberships', async () => {
    const tenant = TenantIdSchema.parse(
      (await createTenant(db, { ...juniper, slug: 'user-gone' })).id,
    );
    const user = await insertUser(db);
    await withTenant(db, tenant, (tx) => addMembership(tx, { userId: user, role: 'staff' }));
    await db.delete(users).where(eq(users.id, user));
    await expect(withTenant(db, tenant, listMemberships)).resolves.toEqual([]);
  });

  it('stores emails lowercased only', async () => {
    const error = await db
      .insert(users)
      .values({ id: newId(), name: 'Caps', email: 'Caps@Example.test' })
      .catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514'); // check_violation
  });
});

describe('sessions', () => {
  async function insertSession(userId: string): Promise<string> {
    const id = newId();
    await db.insert(sessions).values({
      id,
      userId,
      token: `token-${id}`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    return id;
  }

  async function activeTenantOf(id: string): Promise<string | null | undefined> {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    return row?.activeTenantId;
  }

  it("sets and clears the session's active tenant", async () => {
    const user = await insertUser(db);
    const tenant = TenantIdSchema.parse(
      (await createTenant(db, { ...juniper, slug: 'session-a' }, { owner: user })).id,
    );
    const id = await insertSession(user);
    await expect(setSessionActiveTenant(db, { id, userId: user }, tenant)).resolves.toBe(true);
    expect(await activeTenantOf(id)).toBe(tenant);
    await expect(setSessionActiveTenant(db, { id, userId: user }, null)).resolves.toBe(true);
    expect(await activeTenantOf(id)).toBeNull();
  });

  it("does not touch another user's session", async () => {
    const owner = await insertUser(db);
    const intruder = await insertUser(db);
    const tenant = TenantIdSchema.parse(
      (await createTenant(db, { ...juniper, slug: 'session-b' }, { owner: intruder })).id,
    );
    const id = await insertSession(owner);
    await expect(setSessionActiveTenant(db, { id, userId: intruder }, tenant)).resolves.toBe(false);
    expect(await activeTenantOf(id)).toBeNull();
  });

  it('clears the active tenant when the business is deleted', async () => {
    const user = await insertUser(db);
    const tenant = TenantIdSchema.parse(
      (await createTenant(db, { ...juniper, slug: 'session-c' }, { owner: user })).id,
    );
    const id = await insertSession(user);
    await setSessionActiveTenant(db, { id, userId: user }, tenant);
    await withTenant(db, tenant, (tx) => tx.execute(sql`DELETE FROM tenants`));
    expect(await activeTenantOf(id)).toBeNull();
  });
});

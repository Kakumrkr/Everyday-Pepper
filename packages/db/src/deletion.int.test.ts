import {
  ClientIdSchema,
  OutboxMessageIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import { eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database, type DatabaseHandle } from './client.js';
import { newId } from './ids.js';
import { insertService, insertStaffMember } from './repositories/appointments.js';
import { appendAuditEntry } from './repositories/audit.js';
import { insertBooking } from './repositories/bookings.js';
import { insertClient } from './repositories/clients.js';
import {
  cancelAccountDeletion,
  cancelCurrentTenantDeletion,
  cancelPendingEmailsAndTexts,
  deleteAccountIfDue,
  deleteCurrentTenantIfDue,
  deleteInvitesTo,
  endOtherSessions,
  findAccountDeletion,
  findCurrentTenantDeletion,
  listAccountsDueForDeletion,
  listTenantsDueForDeletion,
  scheduleAccountDeletion,
  scheduleCurrentTenantDeletion,
} from './repositories/deletion.js';
import { insertInvite } from './repositories/invites.js';
import { addMembership } from './repositories/memberships.js';
import { insertOutboxMessage } from './repositories/outbox.js';
import { createTenant } from './repositories/tenants.js';
import { auditLog, outboxMessages, sessions, tenants, users } from './schema.js';
import { withMember, withTenant } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

// Deletion with a grace period against real Postgres (S51.2, ADR-0054, AC-W1-40…42): the day
// is kept, the database refuses an early delete, a due business leaves no row in any tenant
// table, and a due account takes its sign-in with it and leaves business rows naming nobody.

let database: TestDatabase;
let db: Database;
/** The container's superuser: sees every tenant's rows, to prove none is left. */
let admin: DatabaseHandle;
let slugs = 0;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  admin = createDatabase({ url: database.migrationUrl, maxConnections: 2 });
});

afterAll(async () => {
  await admin.close();
  await database.stop();
});

const PAST = new Date('2020-01-01T00:00:00Z');
const FUTURE = new Date('2099-01-01T00:00:00Z');

async function userWithEmail(email: string): Promise<UserId> {
  const id = await insertUser(db);
  await db.update(users).set({ email }).where(eq(users.id, id));
  return id;
}

async function insertSession(userId: UserId): Promise<string> {
  const id = newId();
  await db.insert(sessions).values({
    id,
    token: randomBytes(16).toString('hex'),
    userId,
    expiresAt: FUTURE,
  });
  return id;
}

/** A business with an owner, a service, staff, a client, a visit, an invite, an email and an audit entry. */
async function business(name: string): Promise<{ tenantId: TenantId; owner: UserId }> {
  slugs += 1;
  const tenant = await createTenant(db, {
    name,
    slug: `${name.toLowerCase()}-deletion-${String(slugs)}`,
    timeZone: 'America/Chicago',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const owner = await insertUser(db, `${name} owner`);
  await withTenant(db, tenantId, (tx) => addMembership(tx, { userId: owner, role: 'owner' }));
  await withMember(db, { tenantId, userId: owner }, async (tx) => {
    const service = await insertService(tx, {
      name: `${name} cut`,
      category: null,
      durationMinutes: 45,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceFromCents: 4000,
      priceToCents: null,
      active: true,
    });
    const staff = await insertStaffMember(tx, {
      displayName: `${name} Jess`,
      color: '#336699',
      active: true,
      membershipId: null,
    });
    const client = await insertClient(tx, {
      name: `${name} Client`,
      email: `${name.toLowerCase()}@example.test`,
      phone: null,
      source: 'team',
    });
    await insertBooking(tx, {
      clientId: ClientIdSchema.parse(client.id),
      serviceId: ServiceIdSchema.parse(service.id),
      staffMemberId: StaffMemberIdSchema.parse(staff.id),
      startsAt: new Date('2099-01-05T15:00:00Z'),
      endsAt: new Date('2099-01-05T15:45:00Z'),
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceFromCents: 4000,
      priceToCents: null,
      source: 'team',
      overridden: true,
      idempotencyKey: null,
      createdBy: owner,
      manageTokenHash: randomBytes(32).toString('hex'),
    });
    await insertInvite(tx, {
      email: `invitee-${name.toLowerCase()}@example.test`,
      role: 'staff',
      tokenHash: randomBytes(32).toString('hex'),
      invitedBy: owner,
      expiresAt: FUTURE,
    });
    await appendAuditEntry(tx, {
      actor: { kind: 'user', userId: owner },
      change: {
        action: 'tenant.updated',
        entity: { type: 'tenant', id: tenantId },
        before: { brandColor: null },
        after: { brandColor: '#336699' },
      },
    });
  });
  await withTenant(db, tenantId, (tx) =>
    insertOutboxMessage(tx, {
      id: OutboxMessageIdSchema.parse(newId()),
      type: 'email',
      dedupeKey: `deletion-test:${newId()}`,
      payload: Buffer.from('sealed'),
      availableAt: new Date(),
    }),
  );
  return { tenantId, owner };
}

/** How many rows of `tenantId` each tenant table holds (as the superuser, no RLS). */
async function rowsOf(tenantId: TenantId): Promise<Record<string, number>> {
  const { rows } = await admin.db.execute<{ table_name: string }>(sql`
    SELECT DISTINCT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'tenant_id'
     ORDER BY table_name`);
  const counts: Record<string, number> = {};
  for (const { table_name: table } of rows) {
    const result = await admin.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}`,
    );
    counts[table] = result.rows[0]?.n ?? 0;
  }
  const own = await admin.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM tenants WHERE id = ${tenantId}`,
  );
  counts['tenants'] = own.rows[0]?.n ?? 0;
  return counts;
}

const nonZero = (counts: Record<string, number>) => Object.entries(counts).filter(([, n]) => n > 0);

describe('business deletion (AC-W1-40, AC-W1-41)', () => {
  it('schedules once, keeps the first day, and can be kept', async () => {
    const { tenantId } = await business('Keep');
    const first = await withTenant(db, tenantId, (tx) => scheduleCurrentTenantDeletion(tx, FUTURE));
    expect(first).toEqual({ dueAt: FUTURE, scheduled: true });
    const again = await withTenant(db, tenantId, (tx) =>
      scheduleCurrentTenantDeletion(tx, new Date('2099-06-01T00:00:00Z')),
    );
    expect(again).toEqual({ dueAt: FUTURE, scheduled: false });
    expect(await withTenant(db, tenantId, cancelCurrentTenantDeletion)).toBe(true);
    expect(await withTenant(db, tenantId, findCurrentTenantDeletion)).toBeNull();
    expect(await withTenant(db, tenantId, cancelCurrentTenantDeletion)).toBe(false);
  });

  it('takes back the emails and texts waiting to go out (texts since S61)', async () => {
    const { tenantId } = await business('Quiet');
    await withTenant(db, tenantId, (tx) =>
      insertOutboxMessage(tx, {
        id: OutboxMessageIdSchema.parse(newId()),
        type: 'sms',
        dedupeKey: 'deletion-test.sms',
        payload: Buffer.from('sealed'),
        availableAt: new Date(),
      }),
    );
    const cancelled = await withTenant(db, tenantId, (tx) =>
      cancelPendingEmailsAndTexts(tx, new Date()),
    );
    expect(cancelled).toBe(2);
    const left = await withTenant(db, tenantId, (tx) =>
      tx
        .select({ status: outboxMessages.status, payload: outboxMessages.payload })
        .from(outboxMessages),
    );
    expect(left).toEqual([
      { status: 'cancelled', payload: null },
      { status: 'cancelled', payload: null },
    ]);
  });

  it('refuses to delete a business that is not due, even in the database', async () => {
    const { tenantId } = await business('Early');
    // Not scheduled: the repository leaves it, and a raw delete is refused by the trigger.
    expect(await withTenant(db, tenantId, (tx) => deleteCurrentTenantIfDue(tx, new Date()))).toBe(
      false,
    );
    const raw = await withTenant(db, tenantId, (tx) => tx.execute(sql`DELETE FROM tenants`)).catch(
      (error: unknown) => error,
    );
    expect(sqlState(raw)).toBe('42501');
    // Scheduled for later: the same.
    await withTenant(db, tenantId, (tx) => scheduleCurrentTenantDeletion(tx, FUTURE));
    // A caller's clock past the day doesn't fool the database's own.
    const early = await withTenant(db, tenantId, (tx) =>
      deleteCurrentTenantIfDue(tx, new Date('2100-01-01T00:00:00Z')),
    ).catch((error: unknown) => error);
    expect(sqlState(early)).toBe('42501');
    expect(nonZero(await rowsOf(tenantId)).length).toBeGreaterThan(5);
  });

  it('deletes a due business with every row of it, and nothing of another', async () => {
    const gone = await business('Gone');
    const other = await business('Stays');
    const session = await insertSession(gone.owner);
    await db
      .update(sessions)
      .set({ activeTenantId: gone.tenantId })
      .where(eq(sessions.id, session));
    const before = nonZero(await rowsOf(gone.tenantId)).map(([table]) => table);
    // The fixture reaches the main tables, so their cascades are exercised.
    expect(before).toEqual(
      expect.arrayContaining([
        'tenants',
        'memberships',
        'services',
        'staff_members',
        'clients',
        'bookings',
        'booking_occupancy',
        'invites',
        'audit_log',
        'outbox_messages',
        'outbox_dispatch',
        'insight_runs',
      ]),
    );
    const otherBefore = await rowsOf(other.tenantId);

    await withTenant(db, gone.tenantId, (tx) => scheduleCurrentTenantDeletion(tx, PAST));
    expect(await listTenantsDueForDeletion(db, new Date(), 50)).toContain(gone.tenantId);
    expect(await listTenantsDueForDeletion(db, new Date(), 50)).not.toContain(other.tenantId);
    expect(
      await withTenant(db, gone.tenantId, (tx) => deleteCurrentTenantIfDue(tx, new Date())),
    ).toBe(true);

    expect(nonZero(await rowsOf(gone.tenantId))).toEqual([]);
    expect(await rowsOf(other.tenantId)).toEqual(otherBefore);
    // The owner's account stays (accounts are deleted on their own); the session opens no business.
    const [left] = await db.select().from(sessions).where(eq(sessions.id, session));
    expect(left?.activeTenantId).toBeNull();
    expect(await listTenantsDueForDeletion(db, new Date(), 50)).not.toContain(gone.tenantId);
  });
});

describe('account deletion (AC-W1-42, AC-W1-43)', () => {
  it('schedules once, ends the other sessions, and can be kept', async () => {
    const user = await insertUser(db);
    const kept = await insertSession(user);
    const other = await insertSession(user);
    const stranger = await insertUser(db);
    const strangers = await insertSession(stranger);
    expect(await scheduleAccountDeletion(db, user, FUTURE, kept)).toEqual(FUTURE);
    expect(await scheduleAccountDeletion(db, user, new Date('2099-06-01T00:00:00Z'), kept)).toEqual(
      FUTURE,
    );
    const left = await db.select({ id: sessions.id }).from(sessions);
    const ids = left.map((row) => row.id);
    expect(ids).toContain(kept);
    expect(ids).not.toContain(other);
    expect(ids).toContain(strangers);
    expect(await findAccountDeletion(db, user)).toEqual(FUTURE);
    expect(await cancelAccountDeletion(db, user)).toBe(true);
    expect(await findAccountDeletion(db, user)).toBeNull();
  });

  it('ends every other session after a change of email (L15)', async () => {
    const user = await insertUser(db);
    const kept = await insertSession(user);
    await insertSession(user);
    await insertSession(user);
    expect(await endOtherSessions(db, user, kept)).toBe(2);
    const left = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, user));
    expect(left.map((row) => row.id)).toEqual([kept]);
  });

  it('deletes a due account with its sign-in, and business rows name nobody', async () => {
    const { tenantId, owner } = await business('Team');
    const email = `leaver-${newId()}@example.test`;
    const leaver = await userWithEmail(email);
    await withTenant(db, tenantId, (tx) => addMembership(tx, { userId: leaver, role: 'staff' }));
    await withMember(db, { tenantId, userId: owner }, async (tx) => {
      await insertInvite(tx, {
        email,
        role: 'staff',
        tokenHash: randomBytes(32).toString('hex'),
        invitedBy: owner,
        expiresAt: FUTURE,
      });
    });
    await withMember(db, { tenantId, userId: leaver }, (tx) =>
      appendAuditEntry(tx, {
        actor: { kind: 'user', userId: leaver },
        change: {
          action: 'tenant.updated',
          entity: { type: 'tenant', id: tenantId },
          before: { brandColor: null },
          after: { brandColor: '#112233' },
        },
      }),
    );
    const session = await insertSession(leaver);

    // Not due yet: nothing happens.
    await scheduleAccountDeletion(db, leaver, FUTURE, session);
    expect((await listAccountsDueForDeletion(db, new Date(), 50)).map((a) => a.id)).not.toContain(
      leaver,
    );
    expect(await deleteAccountIfDue(db, leaver, new Date())).toBe(false);

    await db.update(users).set({ deletionDueAt: PAST }).where(eq(users.id, leaver));
    expect(await listAccountsDueForDeletion(db, new Date(), 50)).toContainEqual({
      id: leaver,
      email,
    });
    expect(await withTenant(db, tenantId, (tx) => deleteInvitesTo(tx, email))).toBe(1);
    expect(await deleteAccountIfDue(db, leaver, new Date())).toBe(true);

    expect(await db.select().from(users).where(eq(users.id, leaver))).toEqual([]);
    expect(await db.select().from(sessions).where(eq(sessions.userId, leaver))).toEqual([]);
    const audit = await admin.db
      .select({ actor: auditLog.actorUserId })
      .from(auditLog)
      .where(
        sql`${auditLog.tenantId} = ${tenantId} AND ${auditLog.after}->>'brandColor' = '#112233'`,
      );
    expect(audit).toEqual([{ actor: null }]);
    const text = JSON.stringify(
      (await admin.db.execute(sql`SELECT * FROM invites WHERE tenant_id = ${tenantId}`)).rows,
    );
    expect(text).not.toContain(email);
    // The business and its owner are untouched.
    expect(await db.select({ id: users.id }).from(users).where(eq(users.id, owner))).toHaveLength(
      1,
    );
    expect(
      await admin.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)),
    ).toHaveLength(1);
  });
});

// Google Calendar's records (S70, ADR-0069, AC-X-152…156): a connect state is used once, a
// connection's busy blocks are replaced on each read, a refused refresh token keeps them, the
// sync's scan sees ids only, and removing the member removes the connection. Part of the
// isolation evidence with isolation.int.test.ts.
import { StaffMemberIdSchema, TenantIdSchema, type TenantId } from '@pepper/contracts';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import { insertStaffMember } from './repositories/appointments.js';
import {
  claimCalendarConnection,
  findCalendarConnection,
  listBusyBlocksBetween,
  listDueCalendarConnections,
  recordCalendarFailure,
  replaceConnectState,
  saveCalendarConnection,
  storeCalendarRead,
  takeConnectState,
} from './repositories/calendar-sync.js';
import { addMembership, deleteMembership } from './repositories/memberships.js';
import { createTenant } from './repositories/tenants.js';
import { withTenant, type TenantTx } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

let database: TestDatabase;
let db: Database;

const EVERY = 5 * 60_000;
const at = (iso: string) => Date.parse(iso);
const RANGE = { from: new Date('2026-12-01T00:00:00Z'), to: new Date('2026-12-02T00:00:00Z') };

async function business(): Promise<TenantId> {
  const slug = `cal-${randomBytes(5).toString('hex')}`;
  return TenantIdSchema.parse(
    (await createTenant(db, { name: slug, slug, timeZone: 'America/New_York' })).id,
  );
}

async function connected(tx: TenantTx) {
  const userId = await insertUser(db);
  const membership = await addMembership(tx, { userId, role: 'staff' });
  const staff = await insertStaffMember(tx, {
    displayName: 'Jo',
    color: '#2a7230',
    active: true,
    membershipId: membership.id,
  });
  const row = await saveCalendarConnection(
    tx,
    {
      id: newId(),
      staffMemberId: staff.id,
      membershipId: membership.id,
      provider: 'sandbox',
      accountEmail: 'jo@example.com',
      refreshTokenSealed: randomBytes(60),
      accessTokenSealed: randomBytes(60),
      accessTokenExpiresAt: new Date('2026-12-01T13:00:00Z'),
      createdBy: userId,
    },
    false,
  );
  return { row, userId, staffMemberId: StaffMemberIdSchema.parse(staff.id), membership };
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

describe('calendar connect states', () => {
  it('are used once, and a new start replaces the earlier one', async () => {
    const tenant = await business();
    await withTenant(db, tenant, async (tx) => {
      const { staffMemberId, membership } = await connected(tx);
      const first = randomBytes(32);
      const second = randomBytes(32);
      const state = (stateHash: Buffer) => ({
        staffMemberId,
        membershipId: membership.id,
        stateHash,
        verifierSealed: randomBytes(40),
        expiresAt: new Date('2026-12-01T12:10:00Z'),
      });
      await replaceConnectState(tx, state(first));
      await replaceConnectState(tx, state(second));
      expect(await takeConnectState(tx, first)).toBeUndefined();
      expect((await takeConnectState(tx, second))?.staffMemberId).toBe(staffMemberId);
      expect(await takeConnectState(tx, second)).toBeUndefined();
    });
  });

  it('refuse a state hash that is not 32 bytes', async () => {
    const tenant = await business();
    const error = await withTenant(db, tenant, async (tx) => {
      const { staffMemberId, membership } = await connected(tx);
      return replaceConnectState(tx, {
        staffMemberId,
        membershipId: membership.id,
        stateHash: randomBytes(8),
        verifierSealed: randomBytes(40),
        expiresAt: new Date(),
      }).catch((e: unknown) => e);
    });
    expect(sqlState(error)).toBe('23514');
  });
});

describe('calendar connections', () => {
  it('replace their busy blocks on each read, start and end only', async () => {
    const tenant = await business();
    await withTenant(db, tenant, async (tx) => {
      const { row, staffMemberId } = await connected(tx);
      const read = (start: string, end: string) => [{ start: at(start), end: at(end) }];
      await storeCalendarRead(
        tx,
        row,
        read('2026-12-01T14:00:00Z', '2026-12-01T15:00:00Z'),
        new Date(),
      );
      await storeCalendarRead(
        tx,
        row,
        read('2026-12-01T16:00:00Z', '2026-12-01T17:00:00Z'),
        new Date(),
      );
      const blocks = await listBusyBlocksBetween(tx, [staffMemberId], RANGE);
      expect(blocks.map((b) => [b.startsAt.toISOString(), b.endsAt.toISOString()])).toEqual([
        ['2026-12-01T16:00:00.000Z', '2026-12-01T17:00:00.000Z'],
      ]);
      expect(Object.keys(blocks[0] ?? {}).sort()).toEqual(
        ['connectionId', 'endsAt', 'id', 'staffMemberId', 'startsAt', 'tenantId'].sort(),
      );
    });
  });

  it('keep their blocks when Google refuses the refresh token, and stop being due', async () => {
    const tenant = await business();
    const now = new Date('2026-12-01T12:00:00Z');
    const { id } = await withTenant(db, tenant, async (tx) => {
      const { row } = await connected(tx);
      await storeCalendarRead(
        tx,
        row,
        [{ start: at('2026-12-01T14:00:00Z'), end: at('2026-12-01T15:00:00Z') }],
        now,
      );
      return row;
    });
    const due = await listDueCalendarConnections(db, now, EVERY, 1000);
    expect(due).toContainEqual({ tenantId: tenant, connectionId: id });

    await withTenant(db, tenant, async (tx) => {
      expect(await claimCalendarConnection(tx, id, now, EVERY)).toBeDefined();
      // Claimed: a second worker in the same five minutes gets nothing.
      expect(await claimCalendarConnection(tx, id, now, EVERY)).toBeUndefined();
      expect(await recordCalendarFailure(tx, id, 'invalid_grant')).toEqual({
        before: 'connected',
        after: 'needs_reconnect',
      });
      const stored = await findCalendarConnection(tx, id);
      expect(stored?.status).toBe('needs_reconnect');
      expect(stored?.accessTokenSealed).toBeNull();
      expect(stored?.lastError).toBe('invalid_grant');
      // A read that finished after the refusal doesn't replace what was kept.
      expect(
        await storeCalendarRead(tx, { id, staffMemberId: stored?.staffMemberId ?? '' }, [], now),
      ).toBe(false);
      expect(
        await listBusyBlocksBetween(tx, [StaffMemberIdSchema.parse(stored?.staffMemberId)], RANGE),
      ).toHaveLength(1);
    });
    const later = new Date(now.getTime() + 2 * EVERY);
    expect(await listDueCalendarConnections(db, later, EVERY, 1000)).not.toContainEqual({
      tenantId: tenant,
      connectionId: id,
    });
  });

  it('a passing error keeps the connection connected', async () => {
    const tenant = await business();
    await withTenant(db, tenant, async (tx) => {
      const { row } = await connected(tx);
      expect(await recordCalendarFailure(tx, row.id, 'rate_limited')).toEqual({
        before: 'connected',
        after: 'connected',
      });
    });
  });

  it('go with the member who connected them', async () => {
    const tenant = await business();
    await withTenant(db, tenant, async (tx) => {
      const { row, userId } = await connected(tx);
      await storeCalendarRead(
        tx,
        row,
        [{ start: at('2026-12-01T14:00:00Z'), end: at('2026-12-01T15:00:00Z') }],
        new Date(),
      );
      await deleteMembership(tx, userId);
      expect(await findCalendarConnection(tx, row.id)).toBeUndefined();
      const left = await tx.execute(sql`SELECT count(*)::int AS n FROM calendar_busy_blocks`);
      expect((left.rows[0] as { n: number }).n).toBe(0);
    });
  });

  it('are one per staff member', async () => {
    const tenant = await business();
    const error = await withTenant(db, tenant, async (tx) => {
      const { row, userId } = await connected(tx);
      return saveCalendarConnection(
        tx,
        {
          id: newId(),
          staffMemberId: row.staffMemberId,
          membershipId: row.membershipId,
          provider: 'sandbox',
          accountEmail: 'jo@example.com',
          refreshTokenSealed: randomBytes(60),
          accessTokenSealed: randomBytes(60),
          accessTokenExpiresAt: new Date(),
          createdBy: userId,
        },
        false,
      ).catch((e: unknown) => e);
    });
    expect(sqlState(error)).toBe('23505');
  });

  it("are invisible to another business's transaction", async () => {
    const mine = await business();
    const other = await business();
    const { id } = await withTenant(db, mine, async (tx) => (await connected(tx)).row);
    await withTenant(db, other, async (tx) => {
      expect(await findCalendarConnection(tx, id)).toBeUndefined();
      expect(await claimCalendarConnection(tx, id, new Date(), EVERY, true)).toBeUndefined();
    });
  });
});

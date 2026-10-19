import {
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  TimeOffIdSchema,
  type Rule,
  type ServiceFields,
  type ServiceId,
  type StaffMemberId,
  type TenantId,
} from '@pepper/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { ServiceNameTakenError, StaffMemberLinkTakenError } from './errors.js';
import {
  deleteTimeOff,
  findServiceIds,
  findStaffMember,
  findStaffMemberOfUser,
  insertService,
  insertStaffMember,
  insertTimeOff,
  listServices,
  listStaffMembers,
  listTimeOff,
  listWorkingHours,
  lockService,
  lockStaffMember,
  listBookingRules,
  lockBookingRules,
  replaceBookingRules,
  replaceStaffServices,
  replaceWorkingHours,
  updateService,
  updateStaffMember,
} from './repositories/appointments.js';
import { addMembership, deleteMembership } from './repositories/memberships.js';
import { createTenant } from './repositories/tenants.js';
import { withTenant, type TenantTx } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

// The appointments repository against real Postgres (ADR-0015): the database's own guarantees
// (names, links, overlaps, references that stay inside a business). Row isolation of the
// tables is in isolation.int.test.ts.

let database: TestDatabase;
let db: Database;
let slugs = 0;

const haircut: ServiceFields = {
  name: "Women's haircut",
  category: 'Cuts',
  durationMinutes: 60,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 10,
  priceFromCents: 6500,
  priceToCents: null,
  active: true,
};

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

async function newTenant(): Promise<TenantId> {
  slugs += 1;
  const tenant = await createTenant(db, {
    name: 'Juniper',
    slug: `juniper-appt-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  return TenantIdSchema.parse(tenant.id);
}

async function newStaff(tx: TenantTx, membershipId: string | null = null) {
  const row = await insertStaffMember(tx, {
    displayName: 'Jess',
    color: '#2a7230',
    active: true,
    membershipId,
  });
  return StaffMemberIdSchema.parse(row.id);
}

/** A minimum-notice rule for the business, or for one staff member. */
function notice(minutes: number, staffMemberId: StaffMemberId | null = null): Rule {
  return { type: 'minimum_notice', version: 1, staffMemberId, params: { minutes } };
}

function blackout(date: string, staffMemberId: StaffMemberId | null = null): Rule {
  return {
    type: 'blackout_window',
    version: 1,
    staffMemberId,
    params: { startDate: date, endDate: date },
  };
}

async function newService(tx: TenantTx, name = haircut.name): Promise<ServiceId> {
  return ServiceIdSchema.parse((await insertService(tx, { ...haircut, name })).id);
}

describe('services', () => {
  it('lists by name, case-insensitively', async () => {
    const tenant = await newTenant();
    const names = await withTenant(db, tenant, async (tx) => {
      for (const name of ['beard trim', 'Colour', 'Blow-dry']) await newService(tx, name);
      return (await listServices(tx)).map((s) => s.name);
    });
    expect(names).toEqual(['beard trim', 'Blow-dry', 'Colour']);
  });

  it('keeps names unique per business, ignoring case', async () => {
    const [a, b] = [await newTenant(), await newTenant()];
    await withTenant(db, a, (tx) => newService(tx, 'Haircut'));
    await expect(withTenant(db, a, (tx) => newService(tx, 'HAIRCUT'))).rejects.toBeInstanceOf(
      ServiceNameTakenError,
    );
    // Another business may use the same name.
    await expect(withTenant(db, b, (tx) => newService(tx, 'Haircut'))).resolves.toBeDefined();
  });

  it('updates, and refuses a rename onto another service', async () => {
    const tenant = await newTenant();
    const [cut, colour] = await withTenant(db, tenant, async (tx) => [
      await newService(tx, 'Cut'),
      await newService(tx, 'Colour'),
    ]);
    const updated = await withTenant(db, tenant, (tx) =>
      updateService(tx, cut, { ...haircut, name: 'Cut & finish', active: false }),
    );
    expect(updated).toMatchObject({ name: 'Cut & finish', active: false });
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(updated?.createdAt.getTime() ?? 0);
    await expect(
      withTenant(db, tenant, (tx) =>
        updateService(tx, colour, { ...haircut, name: 'cut & FINISH' }),
      ),
    ).rejects.toBeInstanceOf(ServiceNameTakenError);
  });

  it('finds only its own services by id, and locks one', async () => {
    const [a, b] = [await newTenant(), await newTenant()];
    const own = await withTenant(db, a, (tx) => newService(tx));
    const other = await withTenant(db, b, (tx) => newService(tx));
    await withTenant(db, a, async (tx) => {
      expect(await findServiceIds(tx, [own, other])).toEqual([own]);
      expect(await findServiceIds(tx, [])).toEqual([]);
      expect(await lockService(tx, own)).toMatchObject({ id: own });
      expect(await lockService(tx, other)).toBeUndefined();
      expect(await updateService(tx, other, haircut)).toBeUndefined();
    });
  });

  it.each([
    ['a duration below 5 minutes', 'duration_minutes = 4'],
    ['a buffer over 240 minutes', 'buffer_after_minutes = 241'],
    ['a "to" price without a "from" price', 'price_from_cents = NULL, price_to_cents = 100'],
    ['a "to" price below the "from" price', 'price_from_cents = 500, price_to_cents = 400'],
    ['an empty name', "name = ''"],
  ])('the database rejects %s', async (_label, assignment) => {
    const tenant = await newTenant();
    const id = await withTenant(db, tenant, (tx) => newService(tx));
    const error = await withTenant(db, tenant, (tx) =>
      tx.execute(sql.raw(`UPDATE services SET ${assignment} WHERE id = '${id}'`)),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514'); // check_violation
  });
});

describe('staff members', () => {
  it('links a member, lists with their user and services, and finds them by user', async () => {
    const tenant = await newTenant();
    const user = await insertUser(db, 'Jess');
    const { staff, cut, colour } = await withTenant(db, tenant, async (tx) => {
      const membership = await addMembership(tx, { userId: user, role: 'staff' });
      const staff = await newStaff(tx, membership.id);
      const [cut, colour] = [await newService(tx, 'Cut'), await newService(tx, 'Colour')];
      await replaceStaffServices(tx, staff, [cut, colour]);
      return { staff, cut, colour };
    });
    await withTenant(db, tenant, async (tx) => {
      const [listed] = await listStaffMembers(tx);
      expect(listed).toMatchObject({ id: staff, userId: user });
      expect(listed?.serviceIds).toEqual([cut, colour].sort());
      expect(await findStaffMemberOfUser(tx, user)).toMatchObject({ id: staff });
      expect(await lockStaffMember(tx, staff)).toMatchObject({ id: staff, userId: user });
      expect(await findStaffMember(tx, staff)).toEqual(await lockStaffMember(tx, staff));
      // Replacing the set removes what is no longer listed.
      await replaceStaffServices(tx, staff, [colour]);
      expect((await lockStaffMember(tx, staff))?.serviceIds).toEqual([colour]);
      await replaceStaffServices(tx, staff, []);
      expect((await lockStaffMember(tx, staff))?.serviceIds).toEqual([]);
    });
  });

  it('links one membership to at most one staff member', async () => {
    const tenant = await newTenant();
    const user = await insertUser(db, 'Jess');
    const membership = await withTenant(db, tenant, (tx) =>
      addMembership(tx, { userId: user, role: 'staff' }),
    );
    const first = await withTenant(db, tenant, (tx) => newStaff(tx, membership.id));
    await expect(
      withTenant(db, tenant, (tx) => newStaff(tx, membership.id)),
    ).rejects.toBeInstanceOf(StaffMemberLinkTakenError);
    const second = await withTenant(db, tenant, (tx) => newStaff(tx));
    await expect(
      withTenant(db, tenant, (tx) =>
        updateStaffMember(tx, second, {
          displayName: 'Marco',
          color: '#000000',
          active: true,
          membershipId: membership.id,
        }),
      ),
    ).rejects.toBeInstanceOf(StaffMemberLinkTakenError);
    expect(first).toBeDefined();
  });

  it('removing the member unlinks the staff member and keeps everything else', async () => {
    const tenant = await newTenant();
    const user = await insertUser(db, 'Jess');
    const staff = await withTenant(db, tenant, async (tx) => {
      const membership = await addMembership(tx, { userId: user, role: 'staff' });
      const staff = await newStaff(tx, membership.id);
      await replaceWorkingHours(tx, staff, [{ weekday: 2, startMinute: 540, endMinute: 1020 }]);
      return staff;
    });
    await withTenant(db, tenant, (tx) => deleteMembership(tx, user));
    await withTenant(db, tenant, async (tx) => {
      expect(await lockStaffMember(tx, staff)).toMatchObject({
        membershipId: null,
        userId: null,
        displayName: 'Jess',
      });
      expect(await listWorkingHours(tx, staff)).toHaveLength(1);
      expect(await findStaffMemberOfUser(tx, user)).toBeUndefined();
    });
  });

  it('cannot link a membership of another business', async () => {
    const [a, b] = [await newTenant(), await newTenant()];
    const user = await insertUser(db, 'Jess');
    const membershipOfB = await withTenant(db, b, (tx) =>
      addMembership(tx, { userId: user, role: 'staff' }),
    );
    const error = await withTenant(db, a, (tx) => newStaff(tx, membershipOfB.id)).catch(
      (e: unknown) => e,
    );
    expect(sqlState(error)).toBe('23503'); // foreign_key_violation: (tenant, membership) not in A
  });

  it.each([
    ['a colour that is not #rrggbb', "color = 'red'"],
    ['an empty name', "display_name = ''"],
  ])('the database rejects %s', async (_label, assignment) => {
    const tenant = await newTenant();
    const id = await withTenant(db, tenant, (tx) => newStaff(tx));
    const error = await withTenant(db, tenant, (tx) =>
      tx.execute(sql.raw(`UPDATE staff_members SET ${assignment} WHERE id = '${id}'`)),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514');
  });
});

describe('references stay inside a business', () => {
  // A foreign key check does not apply RLS, so a reference by id alone could point at another
  // business's row. Every reference includes the tenant, so these all fail.
  it.each([
    ['offer another business’s service', 'staff_services', 'service'],
    ['link another business’s staff member to a service', 'staff_services', 'staff'],
    ['give another business’s staff member hours', 'working_hours', 'staff'],
    ['give another business’s staff member time off', 'time_off', 'staff'],
    ['give another business’s staff member a booking rule', 'booking_rules', 'staff'],
  ])('cannot %s', async (_label, table, foreign) => {
    const [a, b] = [await newTenant(), await newTenant()];
    const ofB = await withTenant(db, b, async (tx) => ({
      staff: await newStaff(tx),
      service: await newService(tx),
    }));
    const error = await withTenant(db, a, async (tx) => {
      const own = { staff: await newStaff(tx), service: await newService(tx) };
      const staff = foreign === 'staff' ? ofB.staff : own.staff;
      const service = foreign === 'service' ? ofB.service : own.service;
      if (table === 'staff_services') return replaceStaffServices(tx, staff, [service]);
      if (table === 'working_hours') {
        return replaceWorkingHours(tx, staff, [{ weekday: 1, startMinute: 0, endMinute: 60 }]);
      }
      if (table === 'booking_rules') {
        return replaceBookingRules(tx, [notice(0, staff)]);
      }
      return insertTimeOff(tx, {
        staffMemberId: staff,
        startsAt: new Date('2026-10-20T13:00:00Z'),
        endsAt: new Date('2026-10-20T14:00:00Z'),
        createdBy: await insertUser(db),
      });
    }).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23503');
  });

  it('deleting a staff member removes their services, hours, time off and rules', async () => {
    const tenant = await newTenant();
    const staff = await withTenant(db, tenant, async (tx) => {
      const staff = await newStaff(tx);
      await replaceStaffServices(tx, staff, [await newService(tx)]);
      await replaceWorkingHours(tx, staff, [{ weekday: 1, startMinute: 0, endMinute: 60 }]);
      await insertTimeOff(tx, {
        staffMemberId: staff,
        startsAt: new Date('2026-10-20T13:00:00Z'),
        endsAt: new Date('2026-10-20T14:00:00Z'),
        createdBy: await insertUser(db),
      });
      await replaceBookingRules(tx, [notice(0, staff)]);
      return staff;
    });
    const counts = await withTenant(db, tenant, async (tx) => {
      await tx.execute(sql`DELETE FROM staff_members WHERE id = ${staff}`);
      const { rows } = await tx.execute<{ n: number }>(sql`
        SELECT (SELECT count(*) FROM staff_services)::int
             + (SELECT count(*) FROM working_hours)::int
             + (SELECT count(*) FROM time_off)::int
             + (SELECT count(*) FROM booking_rules)::int AS n`);
      return rows[0]?.n;
    });
    expect(counts).toBe(0);
  });
});

describe('working hours', () => {
  async function staffIn(tenant: TenantId): Promise<StaffMemberId> {
    return withTenant(db, tenant, (tx) => newStaff(tx));
  }

  it('replaces the whole week and lists by weekday and start', async () => {
    const tenant = await newTenant();
    const staff = await staffIn(tenant);
    await withTenant(db, tenant, async (tx) => {
      await replaceWorkingHours(tx, staff, [
        { weekday: 3, startMinute: 780, endMinute: 1020 },
        { weekday: 1, startMinute: 540, endMinute: 720 },
        { weekday: 3, startMinute: 540, endMinute: 780 },
      ]);
      expect(await listWorkingHours(tx, staff)).toEqual([
        { weekday: 1, startMinute: 540, endMinute: 720 },
        { weekday: 3, startMinute: 540, endMinute: 780 },
        { weekday: 3, startMinute: 780, endMinute: 1020 },
      ]);
      await replaceWorkingHours(tx, staff, [{ weekday: 5, startMinute: 600, endMinute: 900 }]);
      expect(await listWorkingHours(tx, staff)).toEqual([
        { weekday: 5, startMinute: 600, endMinute: 900 },
      ]);
      await replaceWorkingHours(tx, staff, []);
      expect(await listWorkingHours(tx, staff)).toEqual([]);
    });
  });

  it('the database rejects overlapping intervals on one day (exclusion constraint)', async () => {
    const tenant = await newTenant();
    const staff = await staffIn(tenant);
    const error = await withTenant(db, tenant, (tx) =>
      replaceWorkingHours(tx, staff, [
        { weekday: 2, startMinute: 540, endMinute: 780 },
        { weekday: 2, startMinute: 720, endMinute: 1020 },
      ]),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23P01'); // exclusion_violation
  });

  it.each([
    ['weekday 0', 0, 540, 600],
    ['weekday 8', 8, 540, 600],
    ['an end before the start', 1, 600, 540],
    ['an end after midnight', 1, 1380, 1441],
  ])('the database rejects %s', async (_label, weekday, startMinute, endMinute) => {
    const tenant = await newTenant();
    const staff = await staffIn(tenant);
    const error = await withTenant(db, tenant, (tx) =>
      replaceWorkingHours(tx, staff, [{ weekday, startMinute, endMinute }]),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514');
  });
});

describe('time off', () => {
  it('lists entries ending after `from`, by start, up to the limit, and deletes one', async () => {
    const tenant = await newTenant();
    const creator = await insertUser(db, 'Ana');
    const { staff, other, ids } = await withTenant(db, tenant, async (tx) => {
      const [staff, other] = [await newStaff(tx), await newStaff(tx)];
      const add = async (who: StaffMemberId, start: string, end: string) =>
        TimeOffIdSchema.parse(
          (
            await insertTimeOff(tx, {
              staffMemberId: who,
              startsAt: new Date(start),
              endsAt: new Date(end),
              createdBy: creator,
            })
          ).id,
        );
      const ids = {
        past: await add(staff, '2026-10-01T13:00:00Z', '2026-10-01T17:00:00Z'),
        later: await add(staff, '2026-11-02T13:00:00Z', '2026-11-02T17:00:00Z'),
        soon: await add(staff, '2026-10-20T13:00:00Z', '2026-10-21T13:00:00Z'),
        otherStaff: await add(other, '2026-10-20T13:00:00Z', '2026-10-21T13:00:00Z'),
      };
      return { staff, other, ids };
    });
    await withTenant(db, tenant, async (tx) => {
      const from = new Date('2026-10-17T00:00:00Z');
      expect((await listTimeOff(tx, staff, { from, limit: 10 })).map((t) => t.id)).toEqual([
        ids.soon,
        ids.later,
      ]);
      expect((await listTimeOff(tx, staff, { from, limit: 1 })).map((t) => t.id)).toEqual([
        ids.soon,
      ]);
      // Only the staff member's own entry can be deleted through their id.
      expect(await deleteTimeOff(tx, staff, ids.otherStaff)).toBeUndefined();
      expect(await deleteTimeOff(tx, staff, ids.soon)).toMatchObject({ id: ids.soon });
      expect(await deleteTimeOff(tx, staff, ids.soon)).toBeUndefined();
      expect((await listTimeOff(tx, other, { from, limit: 10 })).map((t) => t.id)).toEqual([
        ids.otherStaff,
      ]);
    });
  });

  it.each([
    ['an end before the start', '2026-10-20T13:00:00Z', '2026-10-20T12:00:00Z'],
    ['more than 366 days', '2026-10-20T13:00:00Z', '2027-10-22T13:00:00Z'],
  ])('the database rejects %s', async (_label, start, end) => {
    const tenant = await newTenant();
    const creator = await insertUser(db, 'Ana');
    const error = await withTenant(db, tenant, async (tx) =>
      insertTimeOff(tx, {
        staffMemberId: await newStaff(tx),
        startsAt: new Date(start),
        endsAt: new Date(end),
        createdBy: creator,
      }),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514');
  });
});

describe('booking rules', () => {
  it('replaces the whole set and lists it', async () => {
    const tenant = await newTenant();
    await withTenant(db, tenant, async (tx) => {
      const staff = await newStaff(tx);
      await replaceBookingRules(tx, [notice(60), notice(0, staff), blackout('2026-12-25')]);
      const rows = await listBookingRules(tx);
      expect(rows.map((r) => [r.type, r.staffMemberId, r.version, r.params])).toEqual(
        expect.arrayContaining([
          ['minimum_notice', null, 1, { minutes: 60 }],
          ['minimum_notice', staff, 1, { minutes: 0 }],
          ['blackout_window', null, 1, { startDate: '2026-12-25', endDate: '2026-12-25' }],
        ]),
      );
      expect(rows).toHaveLength(3);
      await replaceBookingRules(tx, [notice(30)]);
      expect((await listBookingRules(tx)).map((r) => r.params)).toEqual([{ minutes: 30 }]);
      await replaceBookingRules(tx, []);
      expect(await listBookingRules(tx)).toEqual([]);
    });
  });

  it("replacing one business's set leaves another's alone", async () => {
    const [a, b] = [await newTenant(), await newTenant()];
    await withTenant(db, b, (tx) => replaceBookingRules(tx, [notice(45)]));
    await withTenant(db, a, (tx) => replaceBookingRules(tx, [notice(10)]));
    await withTenant(db, a, (tx) => replaceBookingRules(tx, []));
    const ofB = await withTenant(db, b, (tx) => listBookingRules(tx));
    expect(ofB.map((r) => r.params)).toEqual([{ minutes: 45 }]);
  });

  it('allows one single-valued rule per business and per staff member (unique index)', async () => {
    const tenant = await newTenant();
    const staff = await withTenant(db, tenant, (tx) => newStaff(tx));
    for (const pair of [
      [notice(60), notice(30)],
      [notice(60, staff), notice(30, staff)],
    ]) {
      const error = await withTenant(db, tenant, (tx) => replaceBookingRules(tx, pair)).catch(
        (e: unknown) => e,
      );
      expect(sqlState(error)).toBe('23505');
    }
    // Several blackout windows, and a business rule next to a staff member's, are fine.
    await withTenant(db, tenant, (tx) =>
      replaceBookingRules(tx, [
        notice(60),
        notice(30, staff),
        blackout('2026-12-25'),
        blackout('2026-12-25'),
        blackout('2026-12-25', staff),
      ]),
    );
  });

  it.each([
    ['an unknown type', sql`'learned_rule'`, sql`1`, sql`'{}'::jsonb`],
    ['version 0', sql`'minimum_notice'`, sql`0`, sql`'{"minutes": 60}'::jsonb`],
    ['params that are not an object', sql`'minimum_notice'`, sql`1`, sql`'[60]'::jsonb`],
  ])('the database rejects %s', async (_label, type, version, params) => {
    const tenant = await newTenant();
    const error = await withTenant(db, tenant, (tx) =>
      tx.execute(
        sql`INSERT INTO booking_rules (id, type, version, params) VALUES (gen_random_uuid(), ${type}, ${version}, ${params})`,
      ),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514');
  });

  it("the rules lock makes a second change to a business's rules wait", async () => {
    const tenant = await newTenant();
    const order: string[] = [];
    let releaseFirst = (): void => undefined;
    const firstHolds = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstLocked = (): void => undefined;
    const locked = new Promise<void>((resolve) => {
      firstLocked = resolve;
    });
    const first = withTenant(db, tenant, async (tx) => {
      await lockBookingRules(tx);
      firstLocked();
      await firstHolds;
      order.push('first');
    });
    await locked;
    const second = withTenant(db, tenant, async (tx) => {
      await lockBookingRules(tx);
      order.push('second');
    });
    // Another business is not held up.
    await withTenant(db, await newTenant(), (tx) => lockBookingRules(tx));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(order).toEqual([]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });
});

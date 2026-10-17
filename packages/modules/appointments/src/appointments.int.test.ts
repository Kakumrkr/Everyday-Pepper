import {
  ServiceIdSchema,
  type BookingRulesInput,
  StaffMemberIdSchema,
  TenantIdSchema,
  TimeOffIdSchema,
  type MembershipRole,
  type ServiceInput,
  type StaffMember,
  type TenantId,
  type UserId,
} from '@floty/contracts';
import {
  createBusiness,
  ForbiddenError,
  ManualClock,
  MemberNotFoundError,
  type Actor,
} from '@floty/core';
import {
  addMembership,
  deleteMembership,
  listAuditEntries,
  ServiceNameTakenError,
  StaffMemberLinkTakenError,
  withTenant,
  type Database,
} from '@floty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { ServiceNotFoundError, StaffMemberNotFoundError, TimeOffNotFoundError } from './errors.js';
import { getWorkingHours, replaceWorkingHours } from './services/hours.js';
import { getBookingRules, replaceBookingRules } from './services/rules.js';
import { createService, listServices, updateService } from './services/services.js';
import { createStaffMember, listStaff, updateStaffMember } from './services/staff.js';
import { addTimeOff, listTimeOff, removeTimeOff } from './services/time-off.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The appointments services against real Postgres (ADR-0015): who may do what, an audit entry
// for every change (and none for no change), ids of other businesses, concurrent edits.

let database: TestDatabase;
let db: Database;
let slugs = 0;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

interface Business {
  tenantId: TenantId;
  owner: Actor;
  manager: Actor;
  /** A staff member's login; linked to `jess` by `withStaff`. */
  staff: Actor;
  /** Another staff login, linked to `marco`. */
  colleague: Actor;
}

async function newBusiness(): Promise<Business> {
  slugs += 1;
  const ownerId = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Juniper Hair Studio',
    slug: `juniper-appointments-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const actor = (userId: UserId, role: MembershipRole): Actor => ({
    context: { tenantId, userId, role },
    requestId: `req-${role}`,
  });
  const [managerId, staffId, colleagueId] = [
    await insertUser(db, 'Marco'),
    await insertUser(db, 'Jess'),
    await insertUser(db, 'Priya'),
  ];
  await withTenant(db, tenantId, async (tx) => {
    await addMembership(tx, { userId: managerId, role: 'manager' });
    await addMembership(tx, { userId: staffId, role: 'staff' });
    await addMembership(tx, { userId: colleagueId, role: 'staff' });
  });
  return {
    tenantId,
    owner: actor(ownerId, 'owner'),
    manager: actor(managerId, 'manager'),
    staff: actor(staffId, 'staff'),
    colleague: actor(colleagueId, 'staff'),
  };
}

const haircut: ServiceInput = {
  name: "Women's haircut",
  category: 'Cuts',
  durationMinutes: 60,
  bufferAfterMinutes: 10,
  priceFromCents: 6500,
};

/** A business with a haircut service and two linked staff members, Jess and Marco. */
async function withStaff() {
  const business = await newBusiness();
  const service = await createService(db, business.owner, haircut);
  const jess = await createStaffMember(db, business.owner, {
    displayName: 'Jess',
    userId: business.staff.context.userId,
    serviceIds: [service.id],
  });
  const marco = await createStaffMember(db, business.owner, {
    displayName: 'Marco',
    userId: business.colleague.context.userId,
  });
  return { ...business, service, jess, marco };
}

async function auditOf(tenantId: TenantId) {
  return withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 100 }));
}

describe('services', () => {
  it('owners and managers add and change services; everyone reads them', async () => {
    const business = await newBusiness();
    const created = await createService(db, business.manager, haircut);
    expect(created).toMatchObject({ name: "Women's haircut", priceFromCents: 6500, active: true });

    const updated = await updateService(db, business.owner, created.id, {
      ...haircut,
      priceFromCents: 7000,
      priceToCents: 9000,
    });
    expect(updated).toMatchObject({ priceFromCents: 7000, priceToCents: 9000 });

    for (const actor of [business.owner, business.manager, business.staff]) {
      expect(await listServices(db, actor)).toEqual([updated]);
    }
  });

  it('staff may not add or change services', async () => {
    const business = await newBusiness();
    const service = await createService(db, business.owner, haircut);
    await expect(createService(db, business.staff, haircut)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      updateService(db, business.staff, service.id, { ...haircut, active: false }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects a duplicate name and invalid input', async () => {
    const business = await newBusiness();
    await createService(db, business.owner, haircut);
    await expect(
      createService(db, business.owner, { ...haircut, name: "WOMEN'S HAIRCUT" }),
    ).rejects.toBeInstanceOf(ServiceNameTakenError);
    await expect(
      createService(db, business.owner, { ...haircut, name: 'Colour', priceToCents: 100 }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("does not find another business's service, or one that does not exist", async () => {
    const [a, b] = [await newBusiness(), await newBusiness()];
    const ofB = await createService(db, b.owner, haircut);
    await expect(updateService(db, a.owner, ofB.id, haircut)).rejects.toBeInstanceOf(
      ServiceNotFoundError,
    );
    await expect(
      updateService(db, a.owner, ServiceIdSchema.parse(crypto.randomUUID()), haircut),
    ).rejects.toBeInstanceOf(ServiceNotFoundError);
    expect(await listServices(db, a.owner)).toEqual([]);
  });

  it('audits creation and changes by whom, but not an unchanged save', async () => {
    const business = await newBusiness();
    const service = await createService(db, business.owner, haircut);
    await updateService(db, business.manager, service.id, haircut); // no change
    await updateService(db, business.manager, service.id, { ...haircut, active: false });
    const entries = (await auditOf(business.tenantId)).filter((e) => e.entity.id === service.id);
    expect(entries.map((e) => [e.action, e.actor.userId])).toEqual([
      ['service.updated', business.manager.context.userId],
      ['service.created', business.owner.context.userId],
    ]);
    expect(entries[0]).toMatchObject({ before: { active: true }, after: { active: false } });
  });
});

describe('staff members', () => {
  it('owners and managers add staff with a login link and services; everyone reads them', async () => {
    const { owner, manager, staff, colleague, service, jess, marco } = await withStaff();
    expect(jess).toMatchObject({
      displayName: 'Jess',
      userId: staff.context.userId,
      serviceIds: [service.id],
      active: true,
    });
    const unlinked = await createStaffMember(db, manager, { displayName: 'Sam' });
    expect(unlinked).toMatchObject({ userId: null, serviceIds: [] });
    const names = (await listStaff(db, colleague)).map((s: StaffMember) => s.displayName);
    expect(names).toEqual(['Jess', 'Marco', 'Sam']);
    expect(await listStaff(db, owner)).toContainEqual(marco);
  });

  it('updates fields, link and services together', async () => {
    const { manager, staff, service, jess, marco } = await withStaff();
    const second = await createService(db, manager, { ...haircut, name: 'Colour' });
    const updated = await updateStaffMember(db, manager, jess.id, {
      displayName: 'Jess L.',
      color: '#123ABC',
      active: false,
      userId: null,
      serviceIds: [second.id, service.id],
    });
    expect(updated).toMatchObject({
      displayName: 'Jess L.',
      color: '#123abc',
      active: false,
      userId: null,
    });
    expect(updated.serviceIds).toEqual([second.id, service.id].sort());
    // The login Jess no longer uses can now be linked to someone else.
    expect(
      await updateStaffMember(db, manager, marco.id, {
        displayName: 'Marco',
        userId: staff.context.userId,
      }),
    ).toMatchObject({ userId: staff.context.userId });
  });

  it('staff may not add or change staff members', async () => {
    const { staff, jess } = await withStaff();
    await expect(createStaffMember(db, staff, { displayName: 'Me' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      updateStaffMember(db, staff, jess.id, { displayName: 'Boss' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('links only members of the business, each to one staff member', async () => {
    const [a, b] = [await withStaff(), await newBusiness()];
    // B's owner is not a member of A.
    await expect(
      createStaffMember(db, a.owner, { displayName: 'X', userId: b.owner.context.userId }),
    ).rejects.toBeInstanceOf(MemberNotFoundError);
    // Jess's login is already linked.
    await expect(
      createStaffMember(db, a.owner, { displayName: 'X', userId: a.staff.context.userId }),
    ).rejects.toBeInstanceOf(StaffMemberLinkTakenError);
  });

  it("offers only the business's own services", async () => {
    const [a, b] = [await withStaff(), await newBusiness()];
    const ofB = await createService(db, b.owner, haircut);
    await expect(
      createStaffMember(db, a.owner, { displayName: 'X', serviceIds: [ofB.id] }),
    ).rejects.toBeInstanceOf(ServiceNotFoundError);
    await expect(
      updateStaffMember(db, a.owner, a.jess.id, {
        displayName: 'Jess',
        serviceIds: [a.service.id, ofB.id],
      }),
    ).rejects.toBeInstanceOf(ServiceNotFoundError);
  });

  it("does not find another business's staff member", async () => {
    const [a, b] = [await withStaff(), await withStaff()];
    await expect(
      updateStaffMember(db, a.owner, b.jess.id, { displayName: 'Stolen' }),
    ).rejects.toBeInstanceOf(StaffMemberNotFoundError);
  });

  it('audits without the display name, and not an unchanged save', async () => {
    const { tenantId, owner, staff, service, jess } = await withStaff();
    await updateStaffMember(db, owner, jess.id, {
      displayName: 'Jess Lee', // a name change alone is not audited: names stay out of the log
      userId: staff.context.userId,
      serviceIds: [service.id],
    });
    await updateStaffMember(db, owner, jess.id, { displayName: 'Jess Lee', active: false });
    const entries = (await auditOf(tenantId)).filter((e) => e.entity.id === jess.id);
    expect(entries.map((e) => e.action)).toEqual(['staff_member.updated', 'staff_member.created']);
    expect(entries[0]).toMatchObject({
      before: { active: true, userId: staff.context.userId, serviceIds: [service.id] },
      after: { active: false, userId: null, serviceIds: [] },
    });
    expect(JSON.stringify(entries)).not.toContain('Jess');
  });
});

describe('working hours', () => {
  const week = {
    intervals: [
      { weekday: 2, start: '13:00', end: '17:00' },
      { weekday: 2, start: '09:00', end: '12:00' },
      { weekday: 6, start: '10:00', end: '16:00' },
    ],
  };

  it('owners and managers set the week; everyone reads it, sorted', async () => {
    const { manager, colleague, jess } = await withStaff();
    expect(await getWorkingHours(db, colleague, jess.id)).toEqual({ intervals: [] });
    const set = await replaceWorkingHours(db, manager, jess.id, week);
    expect(set.intervals.map((i) => `${String(i.weekday)} ${i.start}-${i.end}`)).toEqual([
      '2 09:00-12:00',
      '2 13:00-17:00',
      '6 10:00-16:00',
    ]);
    expect(await getWorkingHours(db, colleague, jess.id)).toEqual(set);
  });

  it('staff may not change hours, not even their own', async () => {
    const { staff, jess } = await withStaff();
    await expect(replaceWorkingHours(db, staff, jess.id, week)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('rejects overlapping intervals before touching the database', async () => {
    const { owner, jess } = await withStaff();
    await expect(
      replaceWorkingHours(db, owner, jess.id, {
        intervals: [
          { weekday: 1, start: '09:00', end: '13:00' },
          { weekday: 1, start: '12:00', end: '17:00' },
        ],
      }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("does not find another business's staff member", async () => {
    const [a, b] = [await withStaff(), await withStaff()];
    await expect(replaceWorkingHours(db, a.owner, b.jess.id, week)).rejects.toBeInstanceOf(
      StaffMemberNotFoundError,
    );
    await expect(getWorkingHours(db, a.owner, b.jess.id)).rejects.toBeInstanceOf(
      StaffMemberNotFoundError,
    );
  });

  it('audits a changed week, not an unchanged one', async () => {
    const { tenantId, owner, jess } = await withStaff();
    await replaceWorkingHours(db, owner, jess.id, week);
    await replaceWorkingHours(db, owner, jess.id, week);
    const entries = (await auditOf(tenantId)).filter((e) => e.action === 'working_hours.replaced');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entity: { id: jess.id }, before: { intervals: [] } });
  });

  it('serialises concurrent changes to one week', async () => {
    const { owner, manager, jess } = await withStaff();
    const other = { intervals: [{ weekday: 2, start: '10:00', end: '18:00' }] };
    const results = await Promise.allSettled([
      replaceWorkingHours(db, owner, jess.id, week),
      replaceWorkingHours(db, manager, jess.id, other),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const final = await getWorkingHours(db, owner, jess.id);
    expect([weekString(week), weekString(other)]).toContain(weekString(final));
  });
});

describe('booking rules', () => {
  const rulesFor = (staffMemberId: string): BookingRulesInput => ({
    rules: [
      { type: 'blackout_window', params: { startDate: '2026-12-25', endDate: '2026-12-26' } },
      { type: 'minimum_notice', staffMemberId, params: { minutes: 0 } },
      { type: 'minimum_notice', params: { minutes: 1440 } },
    ],
  });

  it('owners and managers set the rules; everyone reads them, sorted', async () => {
    const { owner, manager, staff, jess } = await withStaff();
    expect(await getBookingRules(db, staff)).toEqual({ rules: [] });
    const set = await replaceBookingRules(db, manager, rulesFor(jess.id));
    expect(set.rules.map((r) => [r.staffMemberId, r.type])).toEqual([
      [null, 'minimum_notice'],
      [null, 'blackout_window'],
      [jess.id, 'minimum_notice'],
    ]);
    expect(await getBookingRules(db, staff)).toEqual(set);
    expect(await replaceBookingRules(db, owner, { rules: [] })).toEqual({ rules: [] });
  });

  it('staff may not change the rules, not even their own', async () => {
    const { staff, jess } = await withStaff();
    await expect(replaceBookingRules(db, staff, rulesFor(jess.id))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('rejects invalid or duplicate rules before touching the database', async () => {
    const { owner } = await withStaff();
    for (const rules of [
      [{ type: 'slot_interval', params: { minutes: 7 } }],
      [
        { type: 'minimum_notice', params: { minutes: 60 } },
        { type: 'minimum_notice', params: { minutes: 30 } },
      ],
    ]) {
      await expect(
        replaceBookingRules(db, owner, { rules } as BookingRulesInput),
      ).rejects.toBeInstanceOf(ZodError);
    }
  });

  it("refuses rules for another business's staff member, or an unknown one", async () => {
    const [a, b] = [await withStaff(), await withStaff()];
    await expect(replaceBookingRules(db, a.owner, rulesFor(b.jess.id))).rejects.toBeInstanceOf(
      StaffMemberNotFoundError,
    );
    await expect(
      replaceBookingRules(db, a.owner, rulesFor('0199f0a4-0000-7000-8000-000000000000')),
    ).rejects.toBeInstanceOf(StaffMemberNotFoundError);
    expect(await getBookingRules(db, a.owner)).toEqual({ rules: [] });
  });

  it("does not show one business's rules to another", async () => {
    const [a, b] = [await withStaff(), await withStaff()];
    await replaceBookingRules(db, a.owner, rulesFor(a.jess.id));
    expect(await getBookingRules(db, b.owner)).toEqual({ rules: [] });
  });

  it('audits a changed set with before and after, not an unchanged one', async () => {
    const { tenantId, owner, jess } = await withStaff();
    await replaceBookingRules(db, owner, rulesFor(jess.id));
    await replaceBookingRules(db, owner, rulesFor(jess.id));
    const entries = (await auditOf(tenantId)).filter((e) => e.action === 'booking_rules.replaced');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entity: { type: 'tenant', id: tenantId },
      actor: { userId: owner.context.userId },
      before: { rules: [] },
    });
    expect(entries[0]?.after).toMatchObject({ rules: { length: 3 } });
  });

  it('serialises concurrent changes, so the audit trail chains exactly', async () => {
    const { tenantId, owner, manager, jess } = await withStaff();
    const other = { rules: [{ type: 'slot_interval' as const, params: { minutes: 30 as const } }] };
    const results = await Promise.allSettled([
      replaceBookingRules(db, owner, rulesFor(jess.id)),
      replaceBookingRules(db, manager, other),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const entries = (await auditOf(tenantId))
      .filter((e) => e.action === 'booking_rules.replaced')
      .reverse();
    expect(entries).toHaveLength(2);
    // The second change starts from what the first one left.
    expect(entries[1]?.before).toEqual(entries[0]?.after);
    expect(await getBookingRules(db, owner)).toEqual(entries[1]?.after);
  });
});

function weekString(hours: { intervals: { weekday: number; start: string; end: string }[] }) {
  return [...hours.intervals]
    .map((i) => `${String(i.weekday)} ${i.start}-${i.end}`)
    .sort()
    .join(', ');
}

describe('time off', () => {
  const span = { startsAt: '2026-10-20T13:00:00.000Z', endsAt: '2026-10-20T17:00:00.000Z' };

  it('a staff member adds, lists and removes their own time off', async () => {
    const { staff, colleague, jess } = await withStaff();
    const entry = await addTimeOff(db, staff, jess.id, span);
    expect(entry).toMatchObject({ staffMemberId: jess.id, ...span });
    const clock = new ManualClock('2026-10-17T12:00:00.000Z');
    // Everyone may see it.
    expect(await listTimeOff(db, colleague, jess.id, {}, { clock })).toEqual([entry]);
    await removeTimeOff(db, staff, jess.id, entry.id);
    expect(await listTimeOff(db, staff, jess.id, {}, { clock })).toEqual([]);
  });

  it("a staff member cannot add or remove a colleague's time off", async () => {
    const { manager, staff, marco } = await withStaff();
    await expect(addTimeOff(db, staff, marco.id, span)).rejects.toBeInstanceOf(ForbiddenError);
    const ofMarco = await addTimeOff(db, manager, marco.id, span);
    await expect(removeTimeOff(db, staff, marco.id, ofMarco.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('a staff member whose login is unlinked (or removed) manages no time off', async () => {
    const { tenantId, owner, staff, jess } = await withStaff();
    await updateStaffMember(db, owner, jess.id, { displayName: 'Jess', userId: null });
    await expect(addTimeOff(db, staff, jess.id, span)).rejects.toBeInstanceOf(ForbiddenError);

    const relinked = await updateStaffMember(db, owner, jess.id, {
      displayName: 'Jess',
      userId: staff.context.userId,
    });
    expect(relinked.userId).toBe(staff.context.userId);
    await withTenant(db, tenantId, (tx) => deleteMembership(tx, staff.context.userId));
    await expect(addTimeOff(db, staff, jess.id, span)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("owners and managers manage anyone's time off", async () => {
    const { owner, manager, jess, marco } = await withStaff();
    const entry = await addTimeOff(db, manager, jess.id, span);
    await addTimeOff(db, owner, marco.id, span);
    await removeTimeOff(db, owner, jess.id, entry.id);
  });

  it('lists from `from`, up to `limit`', async () => {
    const { owner, jess } = await withStaff();
    const early = await addTimeOff(db, owner, jess.id, span);
    const late = await addTimeOff(db, owner, jess.id, {
      startsAt: '2026-11-02T13:00:00.000Z',
      endsAt: '2026-11-03T13:00:00.000Z',
    });
    expect(await listTimeOff(db, owner, jess.id, { from: '2026-10-21T00:00:00.000Z' })).toEqual([
      late,
    ]);
    expect(
      await listTimeOff(db, owner, jess.id, { from: '2026-10-01T00:00:00.000Z', limit: 1 }),
    ).toEqual([early]);
  });

  it('answers not found for an unknown entry, another staff member’s entry, or another business', async () => {
    const [a, b] = [await withStaff(), await withStaff()];
    const ofMarco = await addTimeOff(db, a.owner, a.marco.id, span);
    await expect(removeTimeOff(db, a.owner, a.jess.id, ofMarco.id)).rejects.toBeInstanceOf(
      TimeOffNotFoundError,
    );
    await expect(
      removeTimeOff(db, a.owner, a.jess.id, TimeOffIdSchema.parse(crypto.randomUUID())),
    ).rejects.toBeInstanceOf(TimeOffNotFoundError);
    await expect(addTimeOff(db, a.owner, b.jess.id, span)).rejects.toBeInstanceOf(
      StaffMemberNotFoundError,
    );
    await expect(
      listTimeOff(db, a.owner, StaffMemberIdSchema.parse(crypto.randomUUID())),
    ).rejects.toBeInstanceOf(StaffMemberNotFoundError);
  });

  it('rejects an invalid span', async () => {
    const { owner, jess } = await withStaff();
    await expect(
      addTimeOff(db, owner, jess.id, { startsAt: span.endsAt, endsAt: span.startsAt }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it('audits adding and removing, by whom', async () => {
    const { tenantId, staff, jess } = await withStaff();
    const entry = await addTimeOff(db, staff, jess.id, span);
    await removeTimeOff(db, staff, jess.id, entry.id);
    const entries = (await auditOf(tenantId)).filter((e) => e.entity.id === entry.id);
    expect(entries.map((e) => [e.action, e.actor.userId])).toEqual([
      ['time_off.deleted', staff.context.userId],
      ['time_off.created', staff.context.userId],
    ]);
    expect(entries[1]).toMatchObject({ after: { staffMemberId: jess.id, ...span } });
  });
});

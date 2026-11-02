import { TenantIdSchema, TenantSlugSchema, type TenantId, type UserId } from '@pepper/contracts';
import { createBusiness, ForbiddenError, type Actor } from '@pepper/core';
import {
  activationEvents,
  addMembership,
  findCurrentTenant,
  listAuditEntries,
  withTenant,
  type Database,
} from '@pepper/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { replaceWorkingHours } from './services/hours.js';
import { seedBusinessIn } from './services/seed.js';
import { createService, listServices, updateService } from './services/services.js';
import { recordBookingStep } from './services/remembered-devices.js';
import { acknowledgeSetupReview, getSetupReview } from './services/setup.js';
import { createStaffMember, updateStaffMember } from './services/staff.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// Home's setup review (S46, PCR-009, AC-W1-11/12): what a business is set up with and what
// currently stops clients from booking, for owners and managers; "I've checked these" is
// remembered per business, changes no setup and does not silence the warnings.

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

const TUE_SAT = {
  intervals: [2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '09:00', end: '18:00' })),
};

async function newBusiness(options: { seeded?: boolean } = {}) {
  slugs += 1;
  const ownerId = await insertUser(db, 'Ana');
  const tenant = await createBusiness(
    db,
    ownerId,
    { name: 'Fade', slug: `setup-${String(slugs)}`, timeZone: 'America/Chicago' },
    {
      seed:
        options.seeded === true
          ? async (tx, actor) => {
              await seedBusinessIn(tx, actor, {
                services: [
                  {
                    service: { name: 'Cut', durationMinutes: 30, priceFromCents: 3000 },
                    rebookAfterDays: null,
                  },
                  {
                    service: {
                      name: 'Cut and beard',
                      durationMinutes: 45,
                      priceFromCents: 4000,
                      priceToCents: 5500,
                    },
                    rebookAfterDays: null,
                  },
                  { service: { name: 'Consultation', durationMinutes: 15 }, rebookAfterDays: null },
                ],
                owner: { userId: ownerId, displayName: 'Ana' },
                hours: TUE_SAT,
              });
            }
          : undefined,
    },
  );
  const tenantId = TenantIdSchema.parse(tenant.id);
  const actor = (userId: UserId, role: 'owner' | 'manager' | 'staff'): Actor => ({
    context: { tenantId, userId, role },
    requestId: `req-${role}`,
  });
  const [managerId, staffId] = [await insertUser(db, 'Marco'), await insertUser(db, 'Jess')];
  await withTenant(db, tenantId, async (tx) => {
    await addMembership(tx, { userId: managerId, role: 'manager' });
    await addMembership(tx, { userId: staffId, role: 'staff' });
  });
  return {
    tenantId,
    slug: TenantSlugSchema.parse(tenant.slug),
    owner: actor(ownerId, 'owner'),
    manager: actor(managerId, 'manager'),
    staff: actor(staffId, 'staff'),
  };
}

const kinds = async (tenantId: TenantId) =>
  (await withTenant(db, tenantId, (tx) => tx.select().from(activationEvents)))
    .map((r) => r.kind)
    .sort();

describe('the setup review (AC-W1-11)', () => {
  it('shows a seeded business its menu, hours, zone and the owner as provider, not yet reviewed', async () => {
    const { owner } = await newBusiness({ seeded: true });
    const review = await getSetupReview(db, owner);
    expect(review).toMatchObject({
      reviewedAt: null,
      timeZone: 'America/Chicago',
      services: { count: 3, lowestPriceCents: 3000, highestPriceCents: 5500 },
      warnings: [],
    });
    expect(review.providers).toEqual([
      expect.objectContaining({ displayName: 'Ana', isYou: true, serviceCount: 3 }),
    ]);
    expect(review.providers[0]?.hours.intervals).toHaveLength(5);
  });

  it('remembers "checked" per business, once, without changing setup or activation', async () => {
    const business = await newBusiness({ seeded: true });
    const other = await newBusiness({ seeded: true });
    const servicesBefore = await listServices(db, business.owner);
    const eventsBefore = await kinds(business.tenantId);
    const at = new Date('2026-10-29T16:00:00.000Z');

    const reviewed = await acknowledgeSetupReview(db, business.manager, at);
    expect(reviewed.reviewedAt).toBe(at.toISOString());
    // A later session, as another member, still sees it; a second tap keeps the first time.
    expect((await getSetupReview(db, business.owner)).reviewedAt).toBe(at.toISOString());
    await acknowledgeSetupReview(db, business.owner, new Date('2026-10-30T16:00:00.000Z'));
    expect((await getSetupReview(db, business.owner)).reviewedAt).toBe(at.toISOString());

    expect(await listServices(db, business.owner)).toEqual(servicesBefore);
    expect(await kinds(business.tenantId)).toEqual(eventsBefore);
    expect((await getSetupReview(db, other.owner)).reviewedAt).toBeNull();

    const audit = await withTenant(db, business.tenantId, (tx) =>
      listAuditEntries(tx, { limit: 100 }),
    );
    const entries = audit.filter((entry) => entry.action === 'tenant.updated');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      before: { setupReviewed: false },
      after: { setupReviewed: true },
    });
  });

  it('is for owners and managers only', async () => {
    const { staff, tenantId } = await newBusiness({ seeded: true });
    await expect(getSetupReview(db, staff)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(acknowledgeSetupReview(db, staff)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await withTenant(db, tenantId, findCurrentTenant))?.setupReviewedAt).toBeNull();
  });

  it('shows an existing, unseeded business that it has nothing to book yet', async () => {
    const { owner } = await newBusiness();
    expect(await getSetupReview(db, owner)).toMatchObject({
      reviewedAt: null,
      services: { count: 0, lowestPriceCents: null, highestPriceCents: null },
      providers: [],
      warnings: [{ kind: 'no_services' }],
    });
  });
});

describe('current readiness warnings (AC-W1-12)', () => {
  it('come from today’s setup, after the review too, and clear when it is fixed', async () => {
    const { owner } = await newBusiness({ seeded: true });
    await acknowledgeSetupReview(db, owner);
    const color = await createService(db, owner, { name: 'Color', durationMinutes: 90 });
    const ben = await createStaffMember(db, owner, { displayName: 'Ben', serviceIds: [color.id] });

    expect((await getSetupReview(db, owner)).warnings).toEqual([
      { kind: 'staff_without_hours', staffMemberId: ben.id, displayName: 'Ben' },
      { kind: 'service_without_provider', serviceId: color.id, name: 'Color' },
    ]);

    await replaceWorkingHours(db, owner, ben.id, TUE_SAT);
    expect((await getSetupReview(db, owner)).warnings).toEqual([]);

    // Ben leaves: Color has no one again, even though the business was bookable before.
    await updateStaffMember(db, owner, ben.id, {
      displayName: 'Ben',
      serviceIds: [color.id],
      active: false,
    });
    expect((await getSetupReview(db, owner)).warnings).toEqual([
      { kind: 'service_without_provider', serviceId: color.id, name: 'Color' },
    ]);
    await updateService(db, owner, color.id, { name: 'Color', durationMinutes: 90, active: false });
    expect((await getSetupReview(db, owner)).warnings).toEqual([]);
  });
});

describe('the booking page’s week (S47.2, AC-W1-14)', () => {
  it('counts the last 7 days’ visits and bookings of this business only', async () => {
    const a = await newBusiness({ seeded: true });
    const other = await newBusiness({ seeded: true });
    expect((await getSetupReview(db, a.owner)).week).toEqual({ visits: 0, booked: 0 });
    const visit = async (slug: typeof a.slug, steps: ('service' | 'done' | 'waitlisted')[]) => {
      const visitId = randomUUID();
      for (const step of steps) await recordBookingStep(db, slug, { visitId, step });
    };
    await visit(a.slug, ['service', 'done']);
    await visit(a.slug, ['service', 'waitlisted']);
    await visit(a.slug, ['service']);
    await visit(other.slug, ['service', 'done']);
    // A visit from eight days ago is not this week's.
    await withTenant(db, a.tenantId, (tx) =>
      tx.execute(
        `INSERT INTO booking_funnel_events (id, visit_id, step, occurred_at) VALUES (gen_random_uuid(), gen_random_uuid(), 'service', now() - interval '8 days')`,
      ),
    );
    expect((await getSetupReview(db, a.owner)).week).toEqual({ visits: 3, booked: 2 });
    expect((await getSetupReview(db, other.owner)).week).toEqual({ visits: 1, booked: 1 });
  });
});

import { TenantIdSchema, type TenantId } from '@pepper/contracts';
import { createBusiness, createClient, ManualClock, type Actor } from '@pepper/core';
import { activationEvents, recordActivation, withTenant, type Database } from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBooking } from './services/bookings.js';
import { replaceWorkingHours } from './services/hours.js';
import { createService, updateService } from './services/services.js';
import { createStaffMember, updateStaffMember } from './services/staff.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// Activation events (S45, ADR-0046, AC-W1-10): `bookable` the first time an active service is
// offered by an active staff member with hours, `first_booking` with the first booking; each
// once per business, ids and times only, and invisible to other businesses.

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

// Monday 2 November 2026, 07:00 in New York (EST).
const clock = () => new ManualClock('2026-11-02T12:00:00.000Z');
const WEEK = {
  intervals: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
};

async function newBusiness(): Promise<{ tenantId: TenantId; owner: Actor }> {
  slugs += 1;
  const ownerId = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Juniper',
    slug: `activation-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  return { tenantId, owner: { context: { tenantId, userId: ownerId, role: 'owner' } } };
}

async function kinds(tenantId: TenantId): Promise<string[]> {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx.select().from(activationEvents).orderBy(activationEvents.kind),
  );
  return rows.map((r) => r.kind);
}

describe('activation events (AC-W1-10)', () => {
  it('records bookable once the service, its staff member and their hours all exist', async () => {
    const { tenantId, owner } = await newBusiness();
    expect(await kinds(tenantId)).toEqual(['business_created']);

    const service = await createService(db, owner, { name: 'Haircut', durationMinutes: 60 });
    const jess = await createStaffMember(db, owner, { displayName: 'Jess' });
    await updateStaffMember(db, owner, jess.id, { displayName: 'Jess', serviceIds: [service.id] });
    expect(await kinds(tenantId)).toEqual(['business_created']);

    await replaceWorkingHours(db, owner, jess.id, WEEK);
    expect(await kinds(tenantId)).toEqual(['bookable', 'business_created']);

    // Later changes record nothing more, even after it stops and starts being bookable.
    await updateService(db, owner, service.id, {
      name: 'Haircut',
      durationMinutes: 60,
      active: false,
    });
    await updateService(db, owner, service.id, { name: 'Haircut', durationMinutes: 60 });
    expect(await kinds(tenantId)).toEqual(['bookable', 'business_created']);
  });

  it('does not count an inactive staff member, or one without the service', async () => {
    const { tenantId, owner } = await newBusiness();
    const service = await createService(db, owner, { name: 'Haircut', durationMinutes: 60 });
    const off = await createStaffMember(db, owner, {
      displayName: 'Off',
      active: false,
      serviceIds: [service.id],
    });
    await replaceWorkingHours(db, owner, off.id, WEEK);
    const other = await createStaffMember(db, owner, { displayName: 'Other' });
    await replaceWorkingHours(db, owner, other.id, WEEK);
    expect(await kinds(tenantId)).toEqual(['business_created']);
  });

  it('records the first booking once, and no other business sees the events', async () => {
    const { tenantId, owner } = await newBusiness();
    const service = await createService(db, owner, { name: 'Haircut', durationMinutes: 60 });
    const jess = await createStaffMember(db, owner, {
      displayName: 'Jess',
      serviceIds: [service.id],
    });
    await replaceWorkingHours(db, owner, jess.id, WEEK);
    const client = await createClient(db, owner, { name: 'Maria Lopez' });
    const book = (startsAt: string) =>
      createBooking(
        db,
        owner,
        {
          clientId: client.id,
          serviceId: service.id,
          staffMemberId: jess.id,
          startsAt,
          notifyClient: false,
        },
        { clock: clock() },
      );
    await book('2026-11-03T15:00:00.000Z');
    await book('2026-11-03T17:00:00.000Z');
    expect(await kinds(tenantId)).toEqual(['bookable', 'business_created', 'first_booking']);

    const stranger = await newBusiness();
    expect(await kinds(stranger.tenantId)).toEqual(['business_created']);
  });

  it('records an event racing with itself once (unique per business and kind)', async () => {
    const { tenantId } = await newBusiness();
    const results = await Promise.all(
      [1, 2, 3].map(() => withTenant(db, tenantId, (tx) => recordActivation(tx, 'first_booking'))),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await kinds(tenantId)).toEqual(['business_created', 'first_booking']);
  });
});

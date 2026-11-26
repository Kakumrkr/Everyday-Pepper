// A Google busy time blocks a staff member's bookable time like time off (S70, ADR-0069 §6,
// AC-X-156), through the one availability path: what is offered, a team booking, a move.
import { TenantIdSchema, type MembershipRole, type UserId } from '@pepper/contracts';
import { createBusiness, createClient, ManualClock, type Actor } from '@pepper/core';
import {
  addMembership,
  findMembership,
  findStaffMemberOfMembership,
  newId,
  saveCalendarConnection,
  storeCalendarRead,
  withTenant,
  type Database,
} from '@pepper/db';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SlotUnavailableError } from './errors.js';
import { findAvailability } from './services/availability.js';
import { changeBooking, createBooking } from './services/bookings.js';
import { replaceWorkingHours } from './services/hours.js';
import { createService } from './services/services.js';
import { createStaffMember } from './services/staff.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

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

// Monday 2 November 2026, 07:00 in New York.
const NOW = '2026-11-02T12:00:00.000Z';
/** Tuesday 3 November, `HH:MM` in New York (UTC-5). */
const tue = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, 3, (h ?? 0) + 5, m ?? 0)).toISOString();
};

/** Jess works 09:00–17:00 and offers a 60-minute haircut; her Google Calendar is connected. */
async function business() {
  slugs += 1;
  const ownerId = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Juniper',
    slug: `juniper-google-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const actor = (userId: UserId, role: MembershipRole): Actor => ({
    context: { tenantId, userId, role },
  });
  const owner = actor(ownerId, 'owner');
  const jessUser = await insertUser(db, 'Jess');
  await withTenant(db, tenantId, (tx) => addMembership(tx, { userId: jessUser, role: 'staff' }));
  const service = await createService(db, owner, { name: 'Haircut', durationMinutes: 60 });
  const jess = await createStaffMember(db, owner, {
    displayName: 'Jess',
    userId: jessUser,
    serviceIds: [service.id],
  });
  await replaceWorkingHours(db, owner, jess.id, {
    intervals: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
  });
  const client = await createClient(db, owner, {
    name: 'Maria Lopez',
    email: 'maria@example.test',
  });
  return { tenantId, owner, jessUser, service, jess, client, clock: new ManualClock(NOW) };
}

type Business = Awaited<ReturnType<typeof business>>;

/** Jess's Google Calendar says she is busy from `start` to `end`. */
async function googleBusy(b: Business, start: string, end: string): Promise<void> {
  await withTenant(db, b.tenantId, async (tx) => {
    const membership = await findMembership(tx, b.jessUser);
    const membershipId = membership?.id ?? '';
    expect((await findStaffMemberOfMembership(tx, membershipId))?.id).toBe(b.jess.id);
    const connection = await saveCalendarConnection(
      tx,
      {
        id: newId(),
        staffMemberId: b.jess.id,
        membershipId,
        provider: 'sandbox',
        accountEmail: 'jess@example.com',
        refreshTokenSealed: randomBytes(40),
        accessTokenSealed: randomBytes(40),
        accessTokenExpiresAt: new Date(NOW),
        createdBy: b.jessUser,
        connectedAt: new Date(NOW),
        writesBookings: false,
      },
      false,
    );
    await storeCalendarRead(
      tx,
      connection,
      [{ start: Date.parse(start), end: Date.parse(end) }],
      new Date(NOW),
    );
  });
}

const request = (b: Business, startsAt: string) => ({
  clientId: b.client.id,
  serviceId: b.service.id,
  staffMemberId: b.jess.id,
  startsAt,
});

describe('a Google busy time (AC-X-156)', () => {
  it('is not offered, like time off', async () => {
    const b = await business();
    const query = { serviceId: b.service.id, from: tue('00:00'), to: tue('23:59') };
    const before = await findAvailability(db, b.owner, query, { clock: b.clock });
    expect(before.map((s) => s.startsAt)).toContain(tue('12:00'));
    await googleBusy(b, tue('12:00'), tue('13:00'));
    const after = await findAvailability(db, b.owner, query, { clock: b.clock });
    const overlaps = after.filter(
      (s) =>
        Date.parse(s.startsAt) < Date.parse(tue('13:00')) &&
        Date.parse(s.endsAt) > Date.parse(tue('12:00')),
    );
    expect(overlaps).toEqual([]);
    expect(after.map((s) => s.startsAt)).toContain(tue('11:00'));
    expect(after.map((s) => s.startsAt)).toContain(tue('13:00'));
  });

  it('refuses a team booking onto it with the nearest free times', async () => {
    const b = await business();
    await googleBusy(b, tue('12:00'), tue('13:00'));
    const error = await createBooking(db, b.owner, request(b, tue('12:30')), {
      clock: b.clock,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SlotUnavailableError);
    expect((error as SlotUnavailableError).alternatives).toHaveLength(3);
  });

  it('refuses a move onto it', async () => {
    const b = await business();
    const booking = await createBooking(db, b.owner, request(b, tue('10:00')), { clock: b.clock });
    await googleBusy(b, tue('15:00'), tue('16:00'));
    await expect(
      changeBooking(db, b.owner, booking.id, { startsAt: tue('15:00') }, { clock: b.clock }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);
    // A free time still moves.
    expect(
      (await changeBooking(db, b.owner, booking.id, { startsAt: tue('16:00') }, { clock: b.clock }))
        .startsAt,
    ).toBe(tue('16:00'));
  });
});

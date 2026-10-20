import { randomBytes } from 'node:crypto';
import {
  BookingIdSchema,
  BookingRequestIdSchema,
  ClientIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  type ServiceId,
  type TenantId,
} from '@pepper/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { insertService, insertStaffMember } from './repositories/appointments.js';
import {
  addVerificationAttempt,
  countBookingVerificationsExpiringAfter,
  findBookingByManageTokenHash,
  insertBookingVerification,
  lockBookingByManageTokenHash,
  lockBookingVerification,
  setVerificationBooking,
  type NewBookingVerification,
} from './repositories/booking-verifications.js';
import { insertBooking } from './repositories/bookings.js';
import { insertClient } from './repositories/clients.js';
import {
  createTenant,
  findCurrentTenant,
  updateCurrentTenantBrandColor,
  withPublicTenant,
} from './repositories/tenants.js';
import { withTenant, type TenantTx } from './tenant.js';
import { sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

// Booking requests, link tokens and the brand color against real Postgres (ADR-0022). The
// isolation of the table and of the slug lookup is in isolation.int.test.ts.

let database: TestDatabase;
let db: Database;
let tenant: TenantId;
let service: ServiceId;

const hash = () => randomBytes(32).toString('hex');

function request(overrides: Partial<NewBookingVerification> = {}): NewBookingVerification {
  return {
    serviceId: service,
    staffMemberId: null,
    startsAt: new Date('2026-10-23T15:00:00Z'),
    name: 'Ana Ruiz',
    email: 'ana@example.test',
    phone: '+15551234567',
    codeHash: hash(),
    expiresAt: new Date('2026-10-20T15:10:00Z'),
    ...overrides,
  };
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  const created = await createTenant(db, {
    name: 'Plum Salon',
    slug: 'plum-salon',
    timeZone: 'America/Chicago',
  });
  tenant = TenantIdSchema.parse(created.id);
  service = await withTenant(db, tenant, async (tx) =>
    ServiceIdSchema.parse(
      (
        await insertService(tx, {
          name: 'Cut',
          category: null,
          durationMinutes: 45,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          priceFromCents: 5000,
          priceToCents: null,
          active: true,
        })
      ).id,
    ),
  );
});

afterAll(async () => {
  await database.stop();
});

describe('brand color', () => {
  it('starts unset, can be set and cleared', async () => {
    const color = (value: string | null) =>
      withTenant(
        db,
        tenant,
        async (tx) => (await updateCurrentTenantBrandColor(tx, value))?.brandColor,
      );
    expect(
      await withTenant(db, tenant, async (tx) => (await findCurrentTenant(tx))?.brandColor),
    ).toBe(null);
    expect(await color('#7A3E6C')).toBe('#7a3e6c');
    expect(await color(null)).toBe(null);
  });

  it('the database refuses a malformed color', async () => {
    const error = await withTenant(db, tenant, (tx) =>
      tx.execute(`UPDATE tenants SET brand_color = 'plum'`),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514');
  });
});

describe('booking requests', () => {
  it('stores a request and finds it, locked, by id in the business of the slug', async () => {
    const stored = await withPublicTenant(db, 'plum-salon', (tx) =>
      insertBookingVerification(tx, request()),
    );
    expect(stored).toMatchObject({ tenantId: tenant, attempts: 0, bookingId: null });
    const id = BookingRequestIdSchema.parse(stored?.id);
    const found = await withPublicTenant(db, 'plum-salon', (tx) => lockBookingVerification(tx, id));
    expect(found?.email).toBe('ana@example.test');
  });

  it('counts attempts and records the booking', async () => {
    const id = await withPublicTenant(db, 'plum-salon', async (tx) =>
      BookingRequestIdSchema.parse((await insertBookingVerification(tx, request())).id),
    );
    if (id === undefined) throw new Error('no business');
    expect(await withPublicTenant(db, 'plum-salon', (tx) => addVerificationAttempt(tx, id))).toBe(
      1,
    );
    expect(await withPublicTenant(db, 'plum-salon', (tx) => addVerificationAttempt(tx, id))).toBe(
      2,
    );
    const booking = await withPublicTenant(db, 'plum-salon', async (tx) => {
      const made = await bookAt(tx, '2026-10-23T15:00:00Z', null);
      await setVerificationBooking(tx, id, made);
      return made;
    });
    const row = await withPublicTenant(db, 'plum-salon', (tx) => lockBookingVerification(tx, id));
    expect(row).toMatchObject({ attempts: 2, bookingId: booking });
  });

  it('counts the requests for an email whose code expires after a time', async () => {
    const email = `count-${hash().slice(0, 8)}@example.test`;
    const expiresAt = new Date('2026-10-20T15:10:00Z');
    await withPublicTenant(db, 'plum-salon', async (tx) => {
      await insertBookingVerification(tx, request({ email, expiresAt }));
      await insertBookingVerification(tx, request({ email, expiresAt }));
      await insertBookingVerification(tx, request({ email: 'other@example.test', expiresAt }));
    });
    const count = (after: string) =>
      withPublicTenant(db, 'plum-salon', (tx) =>
        countBookingVerificationsExpiringAfter(tx, email.toUpperCase(), new Date(after)),
      );
    expect(await count('2026-10-20T15:09:59Z')).toBe(2);
    expect(await count('2026-10-20T15:10:00Z')).toBe(0);
  });

  it('the database refuses a malformed code hash', async () => {
    const error = await withPublicTenant(db, 'plum-salon', (tx) =>
      tx.execute(`UPDATE booking_verifications SET code_hash = 'x'`),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514');
  });
});

describe('link tokens', () => {
  it('finds a booking by the hash of its link token, and only by it', async () => {
    const tokenHash = hash();
    const id = await withPublicTenant(db, 'plum-salon', (tx) =>
      bookAt(tx, '2026-10-24T15:00:00Z', tokenHash),
    );
    expect(
      (
        await withPublicTenant(db, 'plum-salon', (tx) =>
          findBookingByManageTokenHash(tx, tokenHash),
        )
      )?.id,
    ).toBe(id);
    expect(
      (
        await withPublicTenant(db, 'plum-salon', (tx) =>
          lockBookingByManageTokenHash(tx, tokenHash),
        )
      )?.id,
    ).toBe(id);
    expect(
      await withPublicTenant(db, 'plum-salon', (tx) => findBookingByManageTokenHash(tx, hash())),
    ).toBeUndefined();
  });

  it('a token hash belongs to one booking only', async () => {
    const tokenHash = hash();
    await withPublicTenant(db, 'plum-salon', (tx) => bookAt(tx, '2026-10-25T15:00:00Z', tokenHash));
    const error = await withPublicTenant(db, 'plum-salon', (tx) =>
      bookAt(tx, '2026-10-26T15:00:00Z', tokenHash),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23505');
  });
});

/** A booking made in the transaction's business, with its own client and staff member. */
async function bookAt(tx: TenantTx, startsAt: string, manageTokenHash: string | null) {
  const client = await insertClient(tx, {
    name: 'Ana Ruiz',
    email: `ana-${hash().slice(0, 12)}@example.test`,
    phone: null,
    source: 'booking_page',
  });
  const staff = await insertStaffMember(tx, {
    displayName: 'Jess',
    color: '#2a7230',
    active: true,
    membershipId: null,
  });
  const start = new Date(startsAt);
  const booking = await insertBooking(tx, {
    clientId: ClientIdSchema.parse(client.id),
    serviceId: service,
    staffMemberId: StaffMemberIdSchema.parse(staff.id),
    startsAt: start,
    endsAt: new Date(start.getTime() + 45 * 60_000),
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    priceFromCents: 5000,
    priceToCents: null,
    source: 'booking_page',
    overridden: false,
    idempotencyKey: null,
    createdBy: null,
    manageTokenHash,
  });
  return BookingIdSchema.parse(booking.id);
}

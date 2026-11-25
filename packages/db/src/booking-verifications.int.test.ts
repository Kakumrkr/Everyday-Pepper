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
import { countFunnelSteps, recordFunnelStep } from './repositories/booking-funnel.js';
import { insertBooking } from './repositories/bookings.js';
import { insertClient } from './repositories/clients.js';
import {
  deleteRememberedDevice,
  insertRememberedDevice,
  useRememberedDevice,
} from './repositories/remembered-devices.js';
import {
  createTenant,
  findCurrentTenant,
  updateCurrentTenantBookingPage,
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
        async (tx) => (await updateCurrentTenantBookingPage(tx, { brandColor: value }))?.brandColor,
      );
    expect(
      await withTenant(db, tenant, async (tx) => (await findCurrentTenant(tx))?.brandColor),
    ).toBe(null);
    expect(await color('#7A3E6C')).toBe('#7a3e6c');
    expect(await color(null)).toBe(null);
  });

  it('sets the profile fields it is given and keeps the others (S47)', async () => {
    const update = (settings: Parameters<typeof updateCurrentTenantBookingPage>[1]) =>
      withTenant(db, tenant, (tx) => updateCurrentTenantBookingPage(tx, settings));
    await update({ brandColor: '#7a3e6c' });
    const after = await update({
      phone: '(555) 123-4567',
      publicAddress: '12 Main St\nAustin, TX 78701',
      cancellationPolicy: 'Cancel 24 hours ahead.',
    });
    expect(after).toMatchObject({
      brandColor: '#7a3e6c',
      phone: '+15551234567',
      publicAddress: '12 Main St\nAustin, TX 78701',
      cancellationPolicy: 'Cancel 24 hours ahead.',
      mailingAddress: null,
    });
    expect(await update({ phone: null })).toMatchObject({
      phone: null,
      cancellationPolicy: 'Cancel 24 hours ahead.',
    });
    await update({ brandColor: null, publicAddress: null, cancellationPolicy: null });
  });

  it('stores the cancellation policy’s costs, and clears them (S67.2, AC-X-130)', async () => {
    const update = (settings: Parameters<typeof updateCurrentTenantBookingPage>[1]) =>
      withTenant(db, tenant, (tx) => updateCurrentTenantBookingPage(tx, settings));
    const fees = {
      lateCancel: { kind: 'none' },
      noShow: { kind: 'percent', percent: 50 },
    } as const;
    expect((await update({ cancellationFees: fees }))?.cancellationFees).toEqual(fees);
    expect((await update({ phone: null }))?.cancellationFees).toEqual(fees);
    expect((await update({ cancellationFees: null }))?.cancellationFees).toBeNull();
    // A shape the contract refuses never reaches the database.
    await expect(
      update({
        cancellationFees: { lateCancel: { kind: 'deposit' }, noShow: fees.noShow },
      } as never),
    ).rejects.toThrow();
  });

  it('the database refuses a malformed phone, address or policy (S47)', async () => {
    for (const statement of [
      `UPDATE tenants SET phone = '555-1234'`,
      `UPDATE tenants SET public_address = 'x'`,
      `UPDATE tenants SET cancellation_policy = ''`,
      `UPDATE tenants SET cancellation_policy = repeat('a', 601)`,
      // The policy's costs are an object with both (S67.2).
      `UPDATE tenants SET cancellation_fees = '[]'::jsonb`,
      `UPDATE tenants SET cancellation_fees = '{"lateCancel": {"kind": "none"}}'::jsonb`,
    ]) {
      const error = await withTenant(db, tenant, (tx) => tx.execute(statement)).catch(
        (e: unknown) => e,
      );
      expect(sqlState(error)).toBe('23514');
    }
  });

  it('the database refuses a malformed color', async () => {
    const error = await withTenant(db, tenant, (tx) =>
      tx.execute(`UPDATE tenants SET brand_color = 'plum'`),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514');
  });
});

describe('remembered devices (S47, ADR-0047)', () => {
  const page = <T>(work: (tx: TenantTx) => Promise<T>) => withPublicTenant(db, 'plum-salon', work);
  const now = new Date('2026-10-20T15:00:00Z');
  const later = new Date('2027-01-18T15:00:00Z');

  it('finds a device only by its hash, for its email, before it expires, and moves the expiry', async () => {
    const tokenHash = hash();
    await page((tx) =>
      insertRememberedDevice(tx, { email: 'Ana@Example.test', tokenHash, expiresAt: later, now }),
    );
    const use = (email: string, at: Date, token = tokenHash) =>
      page((tx) =>
        useRememberedDevice(tx, {
          email,
          tokenHash: token,
          expiresAt: new Date(at.getTime() + 90 * 86_400_000),
          now: at,
        }),
      );
    expect(await use('bo@example.test', now)).toBeUndefined();
    expect(await use('ana@example.test', now, hash())).toBeUndefined();
    const used = await use('ana@example.test', new Date('2027-01-01T00:00:00Z'));
    expect(used?.expiresAt.toISOString()).toBe('2027-04-01T00:00:00.000Z');
    expect(await use('ana@example.test', new Date('2027-05-01T00:00:00Z'))).toBeUndefined();
  });

  it('is forgotten by its hash, and a new one clears the expired', async () => {
    const tokenHash = hash();
    await page((tx) =>
      insertRememberedDevice(tx, { email: 'ana@example.test', tokenHash, expiresAt: later, now }),
    );
    expect(await page((tx) => deleteRememberedDevice(tx, tokenHash))).toBe(true);
    expect(await page((tx) => deleteRememberedDevice(tx, tokenHash))).toBe(false);

    const old = hash();
    await page((tx) =>
      insertRememberedDevice(tx, {
        email: 'ana@example.test',
        tokenHash: old,
        expiresAt: now,
        now,
      }),
    );
    await page((tx) =>
      insertRememberedDevice(tx, {
        email: 'ana@example.test',
        tokenHash: hash(),
        expiresAt: later,
        now: new Date(now.getTime() + 1000),
      }),
    );
    expect(await page((tx) => deleteRememberedDevice(tx, old))).toBe(false);
  });
});

describe('the booking funnel (S47, ADR-0047)', () => {
  it('records a step once per visit and counts visits per step in a period', async () => {
    const page = <T>(work: (tx: TenantTx) => Promise<T>) =>
      withPublicTenant(db, 'plum-salon', work);
    const visit = '7d0c3c56-1f6e-4c56-9d8e-0f3f1b2d4a10';
    expect(await page((tx) => recordFunnelStep(tx, { visitId: visit, step: 'service' }))).toBe(
      true,
    );
    expect(await page((tx) => recordFunnelStep(tx, { visitId: visit, step: 'service' }))).toBe(
      false,
    );
    await page((tx) => recordFunnelStep(tx, { visitId: visit, step: 'time' }));
    await page((tx) =>
      recordFunnelStep(tx, { visitId: '0b8e7a1c-2f0d-4f6b-8c3e-5a9d7e6f1b20', step: 'service' }),
    );
    const counts = await withTenant(db, tenant, (tx) =>
      countFunnelSteps(tx, {
        from: new Date(Date.now() - 60_000),
        to: new Date(Date.now() + 60_000),
      }),
    );
    expect(counts).toEqual({
      service: 2,
      staff: 0,
      time: 1,
      details: 0,
      verify: 0,
      done: 0,
      waitlisted: 0,
    });
    const none = await withTenant(db, tenant, (tx) =>
      countFunnelSteps(tx, { from: new Date('2020-01-01'), to: new Date('2020-02-01') }),
    );
    expect(none.service).toBe(0);
  });

  it('the database refuses an unknown step and changes to an event', async () => {
    const error = await withTenant(db, tenant, (tx) =>
      tx.execute(
        `INSERT INTO booking_funnel_events (id, visit_id, step) VALUES (gen_random_uuid(), gen_random_uuid(), 'paid')`,
      ),
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

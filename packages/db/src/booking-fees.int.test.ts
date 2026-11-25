// No-show fees' records (S68, ADR-0068 amendment, AC-X-136/139/142): one fee per booking, moves
// only from the statuses named, the terms stored with a booking's payment and their checks. Part
// of the isolation evidence with isolation.int.test.ts.
import {
  ClientIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  type TenantId,
} from '@pepper/contracts';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import { insertService, insertStaffMember } from './repositories/appointments.js';
import { insertBooking } from './repositories/bookings.js';
import { insertClient } from './repositories/clients.js';
import {
  findBookingFeeByBooking,
  insertBookingFee,
  moveBookingFee,
  type NewBookingFee,
} from './repositories/booking-fees.js';
import { insertBookingPayment, moveBookingPayment } from './repositories/booking-payments.js';
import { createTenant } from './repositories/tenants.js';
import { withTenant, type TenantTx } from './tenant.js';
import { sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

let database: TestDatabase;
let db: Database;

const hex = () => randomBytes(8).toString('hex');

async function business(slug: string): Promise<TenantId> {
  return TenantIdSchema.parse(
    (await createTenant(db, { name: slug, slug, timeZone: 'America/New_York' })).id,
  );
}

/** A booked visit with a card kept: the booking and its payment. */
async function visitWithCard(tx: TenantTx): Promise<{ bookingId: string; paymentId: string }> {
  const client = await insertClient(tx, {
    name: 'Ana Ruiz',
    email: null,
    phone: null,
    source: 'team',
  });
  const service = await insertService(tx, {
    name: `Cut ${hex()}`,
    category: null,
    durationMinutes: 45,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    priceFromCents: 4000,
    priceToCents: null,
    active: true,
  });
  const staff = await insertStaffMember(tx, {
    displayName: 'Jo',
    color: '#2a7230',
    active: true,
    membershipId: null,
  });
  const booking = await insertBooking(tx, {
    clientId: ClientIdSchema.parse(client.id),
    serviceId: ServiceIdSchema.parse(service.id),
    staffMemberId: StaffMemberIdSchema.parse(staff.id),
    startsAt: new Date('2026-10-20T14:00:00Z'),
    endsAt: new Date('2026-10-20T14:45:00Z'),
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    priceFromCents: 4000,
    priceToCents: null,
    source: 'booking_page',
    overridden: false,
    idempotencyKey: null,
    createdBy: null,
  });
  const payment = await insertBookingPayment(tx, {
    requestId: newId(),
    provider: 'sandbox',
    livemode: false,
    kind: 'card',
    intentId: `seti_${hex()}`,
    customerId: `cus_${hex()}`,
    accountId: `acct_${hex()}`,
    amountCents: 0,
    refundHours: 24,
  });
  if (payment === undefined) throw new Error('payment not stored');
  const booked = await moveBookingPayment(tx, payment.id, ['started'], {
    status: 'card_saved',
    bookingId: booking.id,
    policySentence: 'Please cancel at least a day before your visit. No-shows may be charged $20.',
    noShowFeeCents: 2000,
  });
  expect(booked).toMatchObject({ noShowFeeCents: 2000 });
  return { bookingId: booking.id, paymentId: payment.id };
}

function fee(visit: { bookingId: string; paymentId: string }): NewBookingFee {
  return {
    bookingId: visit.bookingId,
    bookingPaymentId: visit.paymentId,
    provider: 'sandbox',
    livemode: false,
    amountCents: 2000,
    policySentence: 'No-shows may be charged $20.',
    agreedAt: new Date('2026-10-01T12:00:00Z'),
    approvedBy: newId(),
    approvedAt: new Date('2026-10-20T16:00:00Z'),
  };
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

describe('booking fees', () => {
  it('holds one fee per booking; a second insert keeps the first', async () => {
    const tenant = await business(`fees-one-${hex()}`);
    await withTenant(db, tenant, async (tx) => {
      const visit = await visitWithCard(tx);
      const first = await insertBookingFee(tx, fee(visit));
      expect(first).toMatchObject({ status: 'queued', amountCents: 2000 });
      expect(await insertBookingFee(tx, { ...fee(visit), amountCents: 900 })).toBeUndefined();
      expect(await findBookingFeeByBooking(tx, visit.bookingId)).toMatchObject({
        id: first?.id,
        amountCents: 2000,
      });
    });
  });

  it('moves only from the statuses named', async () => {
    const tenant = await business(`fees-move-${hex()}`);
    await withTenant(db, tenant, async (tx) => {
      const row = await insertBookingFee(tx, fee(await visitWithCard(tx)));
      if (row === undefined) throw new Error('fee not stored');
      expect(await moveBookingFee(tx, row.id, ['charging'], { status: 'charged' })).toBeUndefined();
      const charging = await moveBookingFee(tx, row.id, ['queued'], { status: 'charging' });
      expect(charging?.status).toBe('charging');
      // An Undo racing the charge can't cancel it any more.
      expect(await moveBookingFee(tx, row.id, ['queued'], { status: 'cancelled' })).toBeUndefined();
      const charged = await moveBookingFee(tx, row.id, ['charging'], {
        status: 'charged',
        intentId: 'pi_fee1',
        chargedAt: new Date(),
      });
      expect(charged).toMatchObject({ status: 'charged', intentId: 'pi_fee1' });
    });
  });

  it('refuses an amount under $0.50, an unknown status and a bad decline code', async () => {
    const tenant = await business(`fees-checks-${hex()}`);
    const refused = (statement: (tx: TenantTx) => Promise<unknown>) =>
      withTenant(db, tenant, statement).catch((error: unknown) => error);
    const visit = await withTenant(db, tenant, (tx) => visitWithCard(tx));
    const small = await refused((tx) =>
      tx.execute(
        sql`INSERT INTO booking_fees (id, booking_id, booking_payment_id, provider, livemode, amount_cents, policy_sentence, agreed_at, approved_by, approved_at)
            VALUES (${newId()}, ${visit.bookingId}, ${visit.paymentId}, 'sandbox', false, 49, 'x', now(), ${newId()}, now())`,
      ),
    );
    expect(sqlState(small)).toBe('23514');
    const row = await withTenant(db, tenant, (tx) => insertBookingFee(tx, fee(visit)));
    if (row === undefined) throw new Error('fee not stored');
    const status = await refused((tx) =>
      tx.execute(sql`UPDATE booking_fees SET status = 'taken' WHERE id = ${row.id}`),
    );
    expect(sqlState(status)).toBe('23514');
    const code = await refused((tx) =>
      tx.execute(sql`UPDATE booking_fees SET failure_code = 'Card Declined!' WHERE id = ${row.id}`),
    );
    expect(sqlState(code)).toBe('23514');
    const removed = await refused((tx) =>
      tx.execute(sql`DELETE FROM booking_fees WHERE id = ${row.id}`),
    );
    expect(sqlState(removed)).toBe('42501');
  });

  it('keeps a payment’s fee only with the sentence it came from', async () => {
    const tenant = await business(`fees-terms-${hex()}`);
    const visit = await withTenant(db, tenant, (tx) => visitWithCard(tx));
    const error = await withTenant(db, tenant, (tx) =>
      tx.execute(
        sql`UPDATE booking_payments SET policy_sentence = NULL WHERE id = ${visit.paymentId}`,
      ),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514');
  });

  it('can’t point at another business’s booking or payment', async () => {
    const one = await business(`fees-a-${hex()}`);
    const two = await business(`fees-b-${hex()}`);
    const visit = await withTenant(db, one, (tx) => visitWithCard(tx));
    const error = await withTenant(db, two, (tx) => insertBookingFee(tx, fee(visit))).catch(
      (e: unknown) => e,
    );
    expect(sqlState(error)).toBe('23503');
  });
});

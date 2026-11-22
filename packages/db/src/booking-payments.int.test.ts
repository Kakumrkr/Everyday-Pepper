// Booking page payments' records (S66, ADR-0068, AC-X-111/112/116/119): one payment per request,
// moves only from the statuses named, a booking once booked, the sweep's definer (ids only, open
// payments only), the service's deposit columns and the business's refund window. Part of the
// isolation evidence with isolation.int.test.ts.
import {
  ServiceIdSchema,
  ServiceInputSchema,
  TenantIdSchema,
  type TenantId,
} from '@pepper/contracts';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import { depositRuleOf, insertService, updateService } from './repositories/appointments.js';
import {
  findBookingPaymentByRequest,
  insertBookingPayment,
  listOpenBookingPayments,
  moveBookingPayment,
  type NewBookingPayment,
} from './repositories/booking-payments.js';
import { createTenant, updateCurrentTenantBookingPage } from './repositories/tenants.js';
import { withTenant } from './tenant.js';
import { sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

let database: TestDatabase;
let db: Database;

const hex = () => randomBytes(8).toString('hex');

function payment(overrides: Partial<NewBookingPayment> = {}): NewBookingPayment {
  return {
    requestId: newId(),
    provider: 'sandbox',
    livemode: false,
    kind: 'deposit',
    intentId: `pi_${hex()}`,
    customerId: `cus_${hex()}`,
    accountId: `acct_${hex()}`,
    amountCents: 1500,
    refundHours: 24,
    ...overrides,
  };
}

async function business(slug: string): Promise<TenantId> {
  return TenantIdSchema.parse(
    (await createTenant(db, { name: slug, slug, timeZone: 'America/New_York' })).id,
  );
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

describe('booking_payments', () => {
  it('holds one payment per request; a second insert keeps the first', async () => {
    const tenant = await business('dep-one');
    const first = payment();
    const stored = await withTenant(db, tenant, (tx) => insertBookingPayment(tx, first));
    const again = await withTenant(db, tenant, (tx) =>
      insertBookingPayment(tx, payment({ requestId: first.requestId })),
    );
    expect(stored?.status).toBe('started');
    expect(again).toBeUndefined();
    const found = await withTenant(db, tenant, (tx) =>
      findBookingPaymentByRequest(tx, first.requestId),
    );
    expect(found?.intentId).toBe(first.intentId);
  });

  it('moves only from the statuses named', async () => {
    const tenant = await business('dep-move');
    const row = await withTenant(db, tenant, (tx) => insertBookingPayment(tx, payment()));
    if (row === undefined) throw new Error('not stored');
    const voided = await withTenant(db, tenant, (tx) =>
      moveBookingPayment(tx, row.id, ['started'], { status: 'voided', settledAt: new Date() }),
    );
    expect(voided?.status).toBe('voided');
    const twice = await withTenant(db, tenant, (tx) =>
      moveBookingPayment(tx, row.id, ['started'], { status: 'voided' }),
    );
    expect(twice).toBeUndefined();
  });

  it('needs a booking once booked, and the kind’s own intent and amount', async () => {
    const tenant = await business('dep-checks');
    const row = await withTenant(db, tenant, (tx) => insertBookingPayment(tx, payment()));
    if (row === undefined) throw new Error('not stored');
    const noBooking = await withTenant(db, tenant, (tx) =>
      moveBookingPayment(tx, row.id, ['started'], { status: 'booked' }),
    ).catch((error: unknown) => error);
    expect(sqlState(noBooking)).toBe('23514');
    const card = await withTenant(db, tenant, (tx) =>
      insertBookingPayment(
        tx,
        payment({ kind: 'card', intentId: `seti_${hex()}`, amountCents: 0 }),
      ),
    );
    expect(card?.kind).toBe('card');
    for (const bad of [
      payment({ kind: 'card', intentId: `seti_${hex()}`, amountCents: 100 }),
      payment({ kind: 'deposit', amountCents: 49 }),
    ]) {
      const error = await withTenant(db, tenant, (tx) => insertBookingPayment(tx, bad)).catch(
        (e: unknown) => e,
      );
      expect(sqlState(error)).toBe('23514');
    }
  });

  it('is the business’s alone', async () => {
    const a = await business('dep-own-a');
    const b = await business('dep-own-b');
    const input = payment();
    await withTenant(db, a, (tx) => insertBookingPayment(tx, input));
    const fromB = await withTenant(db, b, (tx) => findBookingPaymentByRequest(tx, input.requestId));
    expect(fromB).toBeUndefined();
  });

  it('can’t be deleted by the app', async () => {
    const tenant = await business('dep-nodelete');
    await withTenant(db, tenant, (tx) => insertBookingPayment(tx, payment()));
    const error = await withTenant(db, tenant, (tx) =>
      tx.execute(sql`DELETE FROM booking_payments`),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('42501');
  });

  it('answers open payments untouched since a moment, across businesses, ids only', async () => {
    const a = await business('dep-sweep-a');
    const b = await business('dep-sweep-b');
    const open = await withTenant(db, a, (tx) => insertBookingPayment(tx, payment()));
    const other = await withTenant(db, b, (tx) => insertBookingPayment(tx, payment()));
    const closed = await withTenant(db, b, (tx) => insertBookingPayment(tx, payment()));
    if (open === undefined || other === undefined || closed === undefined) throw new Error('seed');
    await withTenant(db, b, (tx) =>
      moveBookingPayment(tx, closed.id, ['started'], { status: 'voided' }),
    );
    const later = new Date(Date.now() + 60_000);
    const found = await listOpenBookingPayments(db, later, 500);
    const ids = found.map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([open.id, other.id]));
    expect(ids).not.toContain(closed.id);
    expect(found.find((row) => row.id === open.id)?.tenantId).toBe(a);
    expect(await listOpenBookingPayments(db, new Date(0), 500)).toEqual([]);
  });
});

describe('deposit rules on services and the refund window', () => {
  it('stores each rule and reads it back; a rule left out on update stays', async () => {
    const tenant = await business('dep-rules');
    await withTenant(db, tenant, async (tx) => {
      const base = ServiceInputSchema.parse({
        name: 'Fade',
        durationMinutes: 30,
        priceFromCents: 4000,
      });
      const none = await insertService(tx, base);
      expect(depositRuleOf(none)).toEqual({ kind: 'none' });
      const fixed = await insertService(tx, {
        ...base,
        name: 'Beard',
        deposit: { kind: 'fixed', amountCents: 1000 },
      });
      expect(depositRuleOf(fixed)).toEqual({ kind: 'fixed', amountCents: 1000 });
      const percent = await insertService(tx, {
        ...base,
        name: 'Color',
        deposit: { kind: 'percent', percent: 25 },
      });
      expect([percent.depositKind, percent.depositValue]).toEqual(['percent', 25]);
      const card = await insertService(tx, { ...base, name: 'Lash', deposit: { kind: 'card' } });
      expect(depositRuleOf(card)).toEqual({ kind: 'card' });
      const kept = await updateService(tx, ServiceIdSchema.parse(fixed.id), {
        ...base,
        name: 'Beard trim',
      });
      expect(depositRuleOf(kept ?? fixed)).toEqual({ kind: 'fixed', amountCents: 1000 });
    });
  });

  it('refuses a percent rule without a price in the database too', async () => {
    const tenant = await business('dep-percent');
    const error = await withTenant(db, tenant, (tx) =>
      tx.execute(
        sql`INSERT INTO services (id, name, duration_minutes, deposit_kind, deposit_value) VALUES (gen_random_uuid(), 'Cut', 30, 'percent', 20)`,
      ),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514');
  });

  it('keeps the refund window at 24 hours until set, 0–168', async () => {
    const tenant = await business('dep-window');
    await withTenant(db, tenant, async (tx) => {
      const set = await updateCurrentTenantBookingPage(tx, { depositRefundHours: 48 });
      expect(set?.depositRefundHours).toBe(48);
      const kept = await updateCurrentTenantBookingPage(tx, { phone: null });
      expect(kept?.depositRefundHours).toBe(48);
    });
    const error = await withTenant(db, tenant, (tx) =>
      tx.execute(sql`UPDATE tenants SET deposit_refund_hours = 169`),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514');
    const fresh = await createTenant(db, { name: 'w', slug: 'dep-window-2', timeZone: 'UTC' });
    expect(fresh.depositRefundHours).toBe(24);
  });
});

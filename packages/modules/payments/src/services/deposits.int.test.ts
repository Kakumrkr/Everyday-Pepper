// Deposits and cards on file against real Postgres (S66, ADR-0068): one payment per request
// (AC-X-114), booked only when Stripe says it's authorized (AC-X-115), the capture and the refund
// through the outbox once each (AC-X-117…119), the sweep (AC-X-116). The sandbox stands in for
// Stripe; every call it gets is counted.
import {
  ClientIdSchema,
  OutboxMessageIdSchema,
  OutboxPaymentSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  type DepositTerms,
  type OutboxPayment,
  type TenantId,
} from '@pepper/contracts';
import { createBusiness, ManualClock, openOutboxContent, outboxKeyFrom } from '@pepper/core';
import {
  findBookingPaymentByRequest,
  insertBooking,
  insertClient,
  insertService,
  insertStaffMember,
  listAuditEntries,
  newId,
  savePushSubscription,
  withTenant,
  type BookingPaymentRow,
  type Database,
  type TenantTx,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepositsUnavailableError, PaymentNotAuthorizedError } from '../errors.js';
import { insertUser, startTestDatabase, type TestDatabase } from '../int-support.js';
import { PaymentsProviderError } from '../provider.js';
import { MemorySandboxAccountStore, SandboxPaymentsProvider } from '../sandbox.js';
import { startPaymentOnboarding, syncOwnPaymentAccount, type PaymentsDeps } from './accounts.js';
import {
  attachBookingPaymentIn,
  requireAuthorizedPayment,
  runPaymentJob,
  moveDepositWindowIn,
  settleDepositOnCancelIn,
  startBookingPayment,
  sweepBookingPayments,
  UNUSED_PAYMENT_MS,
  type VerifiedPaymentRequest,
} from './deposits.js';

let database: TestDatabase;
let db: Database;
let slugs = 0;
const START = new Date('2099-03-01T15:00:00Z');
const VISIT = new Date('2099-03-10T17:00:00Z');
const outboxKey = outboxKeyFrom('an-integration-test-outbox-secret-32+');

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

class CountingSandbox extends SandboxPaymentsProvider {
  calls: string[] = [];
  override capturePaymentIntent(id: string, key: string) {
    this.calls.push('capture');
    return super.capturePaymentIntent(id, key);
  }
  override cancelPaymentIntent(id: string, key: string) {
    this.calls.push('cancel');
    return super.cancelPaymentIntent(id, key);
  }
  override createRefund(id: string, key: string) {
    this.calls.push('refund');
    return super.createRefund(id, key);
  }
}

async function newBusiness(options: { ready?: boolean } = {}) {
  slugs += 1;
  const ownerId = await insertUser(db, 'owner');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Fade Room',
    slug: `deposits-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const clock = new ManualClock(START);
  const sandbox = new CountingSandbox({
    store: new MemorySandboxAccountStore(),
    baseUrl: 'https://app.example',
    now: () => clock.now(),
  });
  const deps: PaymentsDeps = {
    db,
    provider: sandbox,
    clock,
    outboxKey,
    baseUrl: 'https://app.example',
  };
  const owner = { context: { tenantId, userId: ownerId, role: 'owner' as const } };
  await startPaymentOnboarding(deps, owner);
  if (options.ready !== false) {
    const row = await withTenant(db, tenantId, (tx) =>
      tx.execute<{ id: string }>('SELECT provider_account_id AS id FROM payment_accounts'),
    );
    await sandbox.setState(String(row.rows[0]?.id), 'ready');
    clock.advanceBy(1000);
    await syncOwnPaymentAccount(deps, owner);
  }
  return { tenantId, ownerId, clock, sandbox, deps };
}

const DEPOSIT: DepositTerms = { kind: 'deposit', amountCents: 1500, refundHours: 24 };

function request(tenantId: TenantId, terms: DepositTerms = DEPOSIT): VerifiedPaymentRequest {
  return {
    tenantId,
    requestId: newId(),
    startsAt: VISIT,
    terms,
    description: 'Fade Room: Fade',
  };
}

async function seedBooking(tx: TenantTx, startsAt = VISIT): Promise<string> {
  const service = await insertService(tx, {
    name: `Fade ${newId()}`,
    category: null,
    durationMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    priceFromCents: 4000,
    priceToCents: null,
    active: true,
  });
  const staff = await insertStaffMember(tx, {
    displayName: 'Jess',
    color: '#2a7230',
    active: true,
    membershipId: null,
  });
  const client = await insertClient(tx, {
    name: 'Ana',
    email: `ana-${newId()}@example.test`,
    phone: null,
    source: 'booking_page',
  });
  const booking = await insertBooking(tx, {
    clientId: ClientIdSchema.parse(client.id),
    serviceId: ServiceIdSchema.parse(service.id),
    staffMemberId: StaffMemberIdSchema.parse(staff.id),
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    priceFromCents: 4000,
    priceToCents: null,
    source: 'booking_page',
    overridden: false,
    idempotencyKey: null,
    createdBy: null,
  });
  return booking.id;
}

/** The payment steps queued for the business, opened. */
async function queued(tenantId: TenantId): Promise<OutboxPayment[]> {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx.execute<{ id: string; payload: Buffer }>(
      "SELECT id, payload FROM outbox_messages WHERE type = 'payment' ORDER BY created_at, id",
    ),
  );
  return rows.rows.map((row) =>
    OutboxPaymentSchema.parse(
      JSON.parse(
        openOutboxContent(outboxKey, OutboxMessageIdSchema.parse(row.id), row.payload).toString(
          'utf8',
        ),
      ),
    ),
  );
}

async function paymentOf(tenantId: TenantId, requestId: string): Promise<BookingPaymentRow> {
  const row = await withTenant(db, tenantId, (tx) => findBookingPaymentByRequest(tx, requestId));
  if (row === undefined) throw new Error('no payment');
  return row;
}

/** Start, pay with the sandbox's card, check, book: the booking page's whole path. */
async function paidAndBooked(business: Awaited<ReturnType<typeof newBusiness>>, startsAt = VISIT) {
  const asked = request(business.tenantId);
  const started = await startBookingPayment(business.deps, asked);
  await business.sandbox.settleIntent(started.clientSecret, 'succeeded');
  await requireAuthorizedPayment(business.deps, business.tenantId, asked.requestId);
  const bookingId = await withTenant(db, business.tenantId, async (tx) => {
    const id = await seedBooking(tx, startsAt);
    expect(
      await attachBookingPaymentIn(tx, {
        requestId: asked.requestId,
        bookingId: id,
        startsAt,
        now: business.clock.now(),
        outboxKey,
      }),
    ).toBe(true);
    return id;
  });
  return { asked, started, bookingId };
}

describe('starting a payment (AC-X-114)', () => {
  it('makes one customer and one authorize-only intent per request, with the stored terms', async () => {
    const business = await newBusiness();
    const asked = request(business.tenantId);
    const first = await startBookingPayment(business.deps, asked);
    const again = await startBookingPayment(business.deps, asked);
    expect(again.clientSecret).toBe(first.clientSecret);
    expect(first).toMatchObject({
      terms: DEPOSIT,
      refundEndsAt: '2099-03-09T17:00:00.000Z',
      provider: 'sandbox',
    });
    const row = await paymentOf(business.tenantId, asked.requestId);
    expect(row).toMatchObject({ status: 'started', kind: 'deposit', amountCents: 1500 });
    expect(row.intentId).toMatch(/^pi_sandbox/);
  });

  it('keeps a card with nothing paid for a card-only service', async () => {
    const business = await newBusiness();
    const asked = request(business.tenantId, { kind: 'card', refundHours: 24 });
    const started = await startBookingPayment(business.deps, asked);
    expect(started.clientSecret).toMatch(/^seti_sandbox/);
    expect(await paymentOf(business.tenantId, asked.requestId)).toMatchObject({
      kind: 'card',
      amountCents: 0,
    });
  });

  it('refuses while the business can’t take charges', async () => {
    const business = await newBusiness({ ready: false });
    await expect(startBookingPayment(business.deps, request(business.tenantId))).rejects.toThrow(
      DepositsUnavailableError,
    );
  });
});

describe('booking only when authorized (AC-X-115)', () => {
  it('refuses before the card is in, a declined card, or another amount', async () => {
    const business = await newBusiness();
    const asked = request(business.tenantId);
    const started = await startBookingPayment(business.deps, asked);
    await expect(
      requireAuthorizedPayment(business.deps, business.tenantId, asked.requestId),
    ).rejects.toThrow(PaymentNotAuthorizedError);
    await business.sandbox.settleIntent(started.clientSecret, 'declined');
    await expect(
      requireAuthorizedPayment(business.deps, business.tenantId, asked.requestId),
    ).rejects.toThrow(PaymentNotAuthorizedError);
    await expect(
      requireAuthorizedPayment(business.deps, business.tenantId, newId()),
    ).rejects.toThrow(PaymentNotAuthorizedError);
    // The stored amount is what counts: a row changed under Stripe's intent isn't authorized.
    await business.sandbox.settleIntent(started.clientSecret, 'succeeded');
    await withTenant(db, business.tenantId, (tx) =>
      tx.execute('UPDATE booking_payments SET amount_cents = 2000'),
    );
    await expect(
      requireAuthorizedPayment(business.deps, business.tenantId, asked.requestId),
    ).rejects.toThrow(PaymentNotAuthorizedError);
  });

  it('ties the payment to the booking once and queues one capture, which takes it once', async () => {
    const business = await newBusiness();
    const { asked, bookingId } = await paidAndBooked(business);
    const row = await paymentOf(business.tenantId, asked.requestId);
    expect(row).toMatchObject({ status: 'booked', bookingId });
    const again = await withTenant(db, business.tenantId, (tx) =>
      attachBookingPaymentIn(tx, {
        requestId: asked.requestId,
        bookingId,
        startsAt: VISIT,
        now: business.clock.now(),
        outboxKey,
      }),
    );
    expect(again).toBe(false);
    const steps = await queued(business.tenantId);
    expect(steps).toEqual([{ kind: 'capture', bookingPaymentId: row.id }]);
    const [step] = steps;
    if (step === undefined) throw new Error('no step');
    await runPaymentJob(business.deps, business.tenantId, step);
    await runPaymentJob(business.deps, business.tenantId, step);
    expect(business.sandbox.calls).toEqual(['capture']);
    const captured = await paymentOf(business.tenantId, asked.requestId);
    expect(captured.status).toBe('captured');
    expect(captured.capturedAt).not.toBeNull();
    const intent = await business.sandbox.retrievePaymentIntent(captured.intentId);
    expect(intent.status).toBe('succeeded');
    // The audit holds the statuses and the amount only.
    const audit = await withTenant(db, business.tenantId, (tx) =>
      listAuditEntries(tx, { limit: 50 }),
    );
    const moves = audit
      .filter((entry) => entry.action === 'payments.deposit_changed')
      .map((entry) => (entry.after as { status: string }).status);
    expect(moves.sort()).toEqual(['booked', 'captured', 'started']);
  });

  it('never books a card setup that didn’t succeed', async () => {
    const business = await newBusiness();
    const asked = request(business.tenantId, { kind: 'card', refundHours: 24 });
    const started = await startBookingPayment(business.deps, asked);
    await expect(
      requireAuthorizedPayment(business.deps, business.tenantId, asked.requestId),
    ).rejects.toThrow(PaymentNotAuthorizedError);
    await business.sandbox.settleIntent(started.clientSecret, 'succeeded');
    await requireAuthorizedPayment(business.deps, business.tenantId, asked.requestId);
    await withTenant(db, business.tenantId, async (tx) => {
      const bookingId = await seedBooking(tx);
      await attachBookingPaymentIn(tx, {
        requestId: asked.requestId,
        bookingId,
        startsAt: VISIT,
        now: business.clock.now(),
        outboxKey,
      });
    });
    expect((await paymentOf(business.tenantId, asked.requestId)).status).toBe('card_saved');
    expect(await queued(business.tenantId)).toEqual([]);
  });
});

describe('cancelling (AC-X-117, AC-X-118)', () => {
  async function cancel(
    business: Awaited<ReturnType<typeof newBusiness>>,
    bookingId: string,
    by: 'client' | 'business',
  ) {
    return withTenant(db, business.tenantId, (tx) =>
      settleDepositOnCancelIn(tx, {
        bookingId,
        startsAt: VISIT,
        by,
        now: business.clock.now(),
        outboxKey,
      }),
    );
  }

  async function runAll(business: Awaited<ReturnType<typeof newBusiness>>) {
    for (const step of await queued(business.tenantId)) {
      await runPaymentJob(business.deps, business.tenantId, step);
    }
  }

  it('refunds a captured deposit in full when the client cancels in time, once', async () => {
    const business = await newBusiness();
    const { asked, bookingId } = await paidAndBooked(business);
    await runAll(business);
    business.clock.set(new Date('2099-03-09T17:00:00Z'));
    expect(await cancel(business, bookingId, 'client')).toBe('refund_pending');
    expect(await cancel(business, bookingId, 'client')).toBeNull();
    await runAll(business);
    await runAll(business);
    expect(business.sandbox.calls).toEqual(['capture', 'refund']);
    const row = await paymentOf(business.tenantId, asked.requestId);
    expect(row.status).toBe('refunded');
    expect(row.refundId).toMatch(/^re_sandbox/);
  });

  it('keeps the deposit when the client cancels after the window', async () => {
    const business = await newBusiness();
    const { asked, bookingId } = await paidAndBooked(business);
    await runAll(business);
    business.clock.set(new Date('2099-03-09T17:00:01Z'));
    expect(await cancel(business, bookingId, 'client')).toBe('kept');
    await runAll(business);
    expect(business.sandbox.calls).toEqual(['capture']);
    expect((await paymentOf(business.tenantId, asked.requestId)).status).toBe('kept');
  });

  it('always refunds when the business cancels, even inside the window', async () => {
    const business = await newBusiness();
    const { asked, bookingId } = await paidAndBooked(business);
    await runAll(business);
    business.clock.set(new Date('2099-03-10T16:00:00Z'));
    expect(await cancel(business, bookingId, 'business')).toBe('refund_pending');
    await runAll(business);
    expect((await paymentOf(business.tenantId, asked.requestId)).status).toBe('refunded');
  });

  it('lets go of an authorization not captured yet instead of refunding it', async () => {
    const business = await newBusiness();
    const { asked, bookingId } = await paidAndBooked(business);
    // Cancelled before the worker captured it.
    expect(await cancel(business, bookingId, 'business')).toBe('refund_pending');
    await runAll(business);
    expect(business.sandbox.calls).toEqual(['cancel']);
    const row = await paymentOf(business.tenantId, asked.requestId);
    expect(row.status).toBe('refunded');
    expect((await business.sandbox.retrievePaymentIntent(row.intentId)).status).toBe('canceled');
  });

  it('still captures a deposit kept by a late cancel before the capture ran', async () => {
    const business = await newBusiness();
    const { asked, bookingId } = await paidAndBooked(business);
    business.clock.set(new Date('2099-03-10T16:00:00Z'));
    expect(await cancel(business, bookingId, 'client')).toBe('kept');
    await runAll(business);
    const row = await paymentOf(business.tenantId, asked.requestId);
    expect(row.status).toBe('kept');
    expect(row.capturedAt).not.toBeNull();
  });

  it('leaves a card on file alone', async () => {
    const business = await newBusiness();
    const asked = request(business.tenantId, { kind: 'card', refundHours: 24 });
    const started = await startBookingPayment(business.deps, asked);
    await business.sandbox.settleIntent(started.clientSecret, 'succeeded');
    const bookingId = await withTenant(db, business.tenantId, async (tx) => {
      const id = await seedBooking(tx);
      await attachBookingPaymentIn(tx, {
        requestId: asked.requestId,
        bookingId: id,
        startsAt: VISIT,
        now: business.clock.now(),
        outboxKey,
      });
      return id;
    });
    expect(await cancel(business, bookingId, 'business')).toBeNull();
  });

  it('retries a passing Stripe failure (the outbox retries; nothing moves)', async () => {
    const business = await newBusiness();
    const { asked, bookingId } = await paidAndBooked(business);
    await runAll(business);
    await cancel(business, bookingId, 'business');
    const [, refundStep] = await queued(business.tenantId);
    if (refundStep === undefined) throw new Error('no refund step');
    const original = business.sandbox.createRefund.bind(business.sandbox);
    business.sandbox.createRefund = () =>
      Promise.reject(new PaymentsProviderError(503, 'api_error', null, true));
    await expect(runPaymentJob(business.deps, business.tenantId, refundStep)).rejects.toThrow(
      PaymentsProviderError,
    );
    expect((await paymentOf(business.tenantId, asked.requestId)).status).toBe('refund_pending');
    business.sandbox.createRefund = original;
    await runPaymentJob(business.deps, business.tenantId, refundStep);
    expect((await paymentOf(business.tenantId, asked.requestId)).status).toBe('refunded');
  });
});

describe('a move and the refund window (AC-X-117, security review)', () => {
  const HOUR = 60 * 60 * 1000;
  const cancel = (
    business: Awaited<ReturnType<typeof newBusiness>>,
    bookingId: string,
    startsAt: Date,
    now: Date,
  ) =>
    withTenant(db, business.tenantId, (tx) =>
      settleDepositOnCancelIn(tx, { bookingId, startsAt, by: 'client', now, outboxKey }),
    );
  const moveTo = (
    business: Awaited<ReturnType<typeof newBusiness>>,
    bookingId: string,
    startsAt: Date,
    now: Date,
    by: 'client' | 'business' = 'client',
  ) =>
    withTenant(db, business.tenantId, (tx) =>
      moveDepositWindowIn(tx, { bookingId, startsAt, by, now }),
    );

  it('is set when booked: the agreed hours before the start', async () => {
    const business = await newBusiness();
    const { asked } = await paidAndBooked(business);
    expect((await paymentOf(business.tenantId, asked.requestId)).refundEndsAt).toEqual(
      new Date(VISIT.getTime() - 24 * HOUR),
    );
  });

  it('a client moving the booking inside the window can’t win the deposit back', async () => {
    const business = await newBusiness();
    const { asked, bookingId } = await paidAndBooked(business);
    const late = new Date(VISIT.getTime() - 2 * HOUR);
    const later = new Date(VISIT.getTime() + 7 * 24 * HOUR);
    await moveTo(business, bookingId, later, late);
    expect((await paymentOf(business.tenantId, asked.requestId)).refundEndsAt).toEqual(
      new Date(VISIT.getTime() - 24 * HOUR),
    );
    expect(await cancel(business, bookingId, later, late)).toBe('kept');
  });

  it('a client moving it in time takes the window along', async () => {
    const business = await newBusiness();
    const { bookingId } = await paidAndBooked(business);
    const early = new Date(VISIT.getTime() - 3 * 24 * HOUR);
    const later = new Date(VISIT.getTime() + 7 * 24 * HOUR);
    await moveTo(business, bookingId, later, early);
    // Past the first window, still before the new one: refunded.
    expect(await cancel(business, bookingId, later, new Date(VISIT.getTime() - 2 * HOUR))).toBe(
      'refund_pending',
    );
  });

  it('the business moving it always takes the window along', async () => {
    const business = await newBusiness();
    const { bookingId } = await paidAndBooked(business);
    const late = new Date(VISIT.getTime() - 2 * HOUR);
    const later = new Date(VISIT.getTime() + 7 * 24 * HOUR);
    await moveTo(business, bookingId, later, late, 'business');
    expect(await cancel(business, bookingId, later, late)).toBe('refund_pending');
  });
});

describe('the sweep (AC-X-116)', () => {
  it('lets go of a payment nobody booked with after an hour, and books nothing with it after', async () => {
    const business = await newBusiness();
    const asked = request(business.tenantId);
    const started = await startBookingPayment(business.deps, asked);
    await business.sandbox.settleIntent(started.clientSecret, 'succeeded');
    await sweepBookingPayments(business.deps);
    expect((await paymentOf(business.tenantId, asked.requestId)).status).toBe('started');
    // The age is the database's clock: move the row back in time instead.
    await withTenant(db, business.tenantId, (tx) =>
      tx.execute(
        `UPDATE booking_payments SET created_at = now() - interval '${String(UNUSED_PAYMENT_MS + 60_000)} milliseconds'`,
      ),
    );
    await sweepBookingPayments(business.deps, { limit: 500 });
    const row = await paymentOf(business.tenantId, asked.requestId);
    expect(row.status).toBe('voided');
    expect((await business.sandbox.retrievePaymentIntent(row.intentId)).status).toBe('canceled');
    await expect(
      requireAuthorizedPayment(business.deps, business.tenantId, asked.requestId),
    ).rejects.toThrow(PaymentNotAuthorizedError);
    await expect(startBookingPayment(business.deps, asked)).rejects.toThrow(
      DepositsUnavailableError,
    );
  });

  it('tries letting go again when Stripe failed, until it did (review)', async () => {
    const business = await newBusiness();
    const asked = request(business.tenantId);
    const started = await startBookingPayment(business.deps, asked);
    await business.sandbox.settleIntent(started.clientSecret, 'succeeded');
    await withTenant(db, business.tenantId, (tx) =>
      tx.execute(
        `UPDATE booking_payments SET created_at = now() - interval '${String(UNUSED_PAYMENT_MS + 60_000)} milliseconds'`,
      ),
    );
    const original = business.sandbox.cancelPaymentIntent.bind(business.sandbox);
    business.sandbox.cancelPaymentIntent = () =>
      Promise.reject(new PaymentsProviderError(503, 'api_error', null, true));
    await sweepBookingPayments(business.deps, { limit: 500 });
    const held = await paymentOf(business.tenantId, asked.requestId);
    expect(held).toMatchObject({ status: 'voided', settledAt: null });
    expect((await business.sandbox.retrievePaymentIntent(held.intentId)).status).toBe(
      'requires_capture',
    );
    business.sandbox.cancelPaymentIntent = original;
    await sweepBookingPayments(business.deps, { limit: 500, ageMs: 0 });
    const let_go = await paymentOf(business.tenantId, asked.requestId);
    expect(let_go.settledAt).not.toBeNull();
    expect((await business.sandbox.retrievePaymentIntent(let_go.intentId)).status).toBe('canceled');
  });
});

describe('a deposit Stripe won’t give back (review)', () => {
  it('is recorded refund_failed, not retried, and every owner is told', async () => {
    const business = await newBusiness();
    await withTenant(db, business.tenantId, (tx) =>
      savePushSubscription(tx, {
        userId: business.ownerId,
        endpoint: 'https://fcm.googleapis.com/fcm/send/' + newId(),
        p256dh: 'B'.repeat(87),
        auth: 'a'.repeat(22),
      }),
    );
    const { asked, bookingId } = await paidAndBooked(business);
    for (const step of await queued(business.tenantId)) {
      await runPaymentJob(business.deps, business.tenantId, step);
    }
    await withTenant(db, business.tenantId, (tx) =>
      settleDepositOnCancelIn(tx, {
        bookingId,
        startsAt: VISIT,
        by: 'business',
        now: business.clock.now(),
        outboxKey,
      }),
    );
    business.sandbox.createRefund = () =>
      Promise.reject(
        new PaymentsProviderError(400, 'invalid_request_error', 'charge_already_refunded', false),
      );
    const [, refundStep] = await queued(business.tenantId);
    if (refundStep === undefined) throw new Error('no refund step');
    await runPaymentJob(business.deps, business.tenantId, refundStep);
    expect((await paymentOf(business.tenantId, asked.requestId)).status).toBe('refund_failed');
    const pushes = await withTenant(db, business.tenantId, (tx) =>
      tx.execute<{ key: string }>(
        "SELECT dedupe_key AS key FROM outbox_messages WHERE dedupe_key LIKE 'payment.refund_failed:%'",
      ),
    );
    // One push to the owner's one device, once.
    expect(pushes.rows).toHaveLength(1);
    await runPaymentJob(business.deps, business.tenantId, refundStep);
    expect((await paymentOf(business.tenantId, asked.requestId)).status).toBe('refund_failed');
  });
});

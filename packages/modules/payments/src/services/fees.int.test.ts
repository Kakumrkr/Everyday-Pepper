// No-show fees by approval against real Postgres (S68, ADR-0068 amendment): the terms kept with a
// booking's payment (AC-X-136), the card's offer (AC-X-137), nothing charged without the owner's
// OK (AC-X-139), one off-session charge or a recorded decline (AC-X-140), Undo (AC-X-141) and the
// receipt (AC-X-142). The sandbox stands in for Stripe; every charge it is asked for is counted.
import {
  ClientIdSchema,
  OutboxMessageIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  type CancellationFees,
  type DepositTerms,
  type TenantId,
} from '@pepper/contracts';
import {
  createBusiness,
  ForbiddenError,
  ManualClock,
  openOutboxContent,
  outboxKeyFrom,
  type Actor,
} from '@pepper/core';
import {
  findBookingFeeByBooking,
  findBookingPaymentByBooking,
  insertBooking,
  insertClient,
  insertService,
  insertStaffMember,
  listAuditEntries,
  newId,
  withTenant,
  type Database,
  type TenantTx,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NoShowFeeBusyError, NoShowFeeNotChargeableError } from '../errors.js';
import { insertUser, startTestDatabase, type TestDatabase } from '../int-support.js';
import type { CreateOffSessionChargeInput } from '../provider.js';
import { MemorySandboxAccountStore, SandboxPaymentsProvider } from '../sandbox.js';
import { startPaymentOnboarding, syncOwnPaymentAccount, type PaymentsDeps } from './accounts.js';
import {
  attachBookingPaymentIn,
  requireAuthorizedPayment,
  runPaymentJob,
  startBookingPayment,
} from './deposits.js';
import { approveNoShowFeeIn, noShowFeeOfferIn, undoNoShowFeeIn } from './fees.js';

let database: TestDatabase;
let db: Database;
let slugs = 0;
const START = new Date('2099-03-01T15:00:00Z');
const VISIT = new Date('2099-03-10T17:00:00Z');
const outboxKey = outboxKeyFrom('an-integration-test-outbox-secret-32+');
const POLICY: CancellationFees = {
  lateCancel: { kind: 'none' },
  noShow: { kind: 'fixed', amountCents: 2000 },
};
const SENTENCE =
  'Please cancel or reschedule at least 24 hours before your visit. No-shows may be charged $20.';

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

class CountingSandbox extends SandboxPaymentsProvider {
  charges: CreateOffSessionChargeInput[] = [];
  refunds = 0;
  override createOffSessionCharge(input: CreateOffSessionChargeInput) {
    this.charges.push(input);
    return super.createOffSessionCharge(input);
  }
  /** Stripe answers the next refund `pending` (it settles when read again). */
  pendingOnce = false;
  override async createRefund(id: string, key: string) {
    this.refunds += 1;
    const refund = await super.createRefund(id, key);
    if (!this.pendingOnce) return refund;
    this.pendingOnce = false;
    return { ...refund, status: 'pending' as const };
  }
}

async function newBusiness(policy: CancellationFees | null = POLICY) {
  slugs += 1;
  const ownerId = await insertUser(db, 'owner');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Fade Room',
    slug: `fees-${String(slugs)}`,
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
  const owner: Actor = { context: { tenantId, userId: ownerId, role: 'owner' } };
  await startPaymentOnboarding(deps, owner);
  const account = await withTenant(db, tenantId, (tx) =>
    tx.execute<{ id: string }>('SELECT provider_account_id AS id FROM payment_accounts'),
  );
  await sandbox.setState(String(account.rows[0]?.id), 'ready');
  clock.advanceBy(1000);
  await syncOwnPaymentAccount(deps, owner);
  await setPolicy(tenantId, policy);
  return { tenantId, ownerId, owner, clock, sandbox, deps };
}

type Business = Awaited<ReturnType<typeof newBusiness>>;

async function setPolicy(tenantId: TenantId, policy: CancellationFees | null): Promise<void> {
  await withTenant(db, tenantId, (tx) =>
    tx.execute(
      policy === null
        ? `UPDATE tenants SET cancellation_fees = NULL WHERE id = '${tenantId}'`
        : `UPDATE tenants SET cancellation_fees = '${JSON.stringify(policy)}'::jsonb WHERE id = '${tenantId}'`,
    ),
  );
}

async function seedBooking(tx: TenantTx, priceFromCents: number | null): Promise<string> {
  const service = await insertService(tx, {
    name: `Fade ${newId()}`,
    category: null,
    durationMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    priceFromCents,
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
    name: 'Ana Ruiz',
    email: `ana-${newId()}@example.test`,
    phone: null,
    source: 'booking_page',
  });
  const booking = await insertBooking(tx, {
    clientId: ClientIdSchema.parse(client.id),
    serviceId: ServiceIdSchema.parse(service.id),
    staffMemberId: StaffMemberIdSchema.parse(staff.id),
    startsAt: VISIT,
    endsAt: new Date(VISIT.getTime() + 30 * 60_000),
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    priceFromCents,
    priceToCents: null,
    source: 'booking_page',
    overridden: false,
    idempotencyKey: null,
    createdBy: null,
  });
  return booking.id;
}

/** A booking-page booking that kept a card (or paid a deposit), its client's card given. */
async function bookedWithCard(
  business: Business,
  terms: DepositTerms = { kind: 'card', refundHours: 24 },
  priceFromCents: number | null = 4000,
): Promise<string> {
  const { tenantId, deps, sandbox } = business;
  const requestId = newId();
  const started = await startBookingPayment(deps, {
    tenantId,
    requestId,
    startsAt: VISIT,
    terms,
    description: 'Fade Room: Fade',
  });
  await sandbox.settleIntent(started.clientSecret, 'succeeded');
  await requireAuthorizedPayment(deps, tenantId, requestId);
  const bookingId = await withTenant(db, tenantId, async (tx) => {
    const id = await seedBooking(tx, priceFromCents);
    await attachBookingPaymentIn(tx, {
      requestId,
      bookingId: id,
      startsAt: VISIT,
      now: business.clock.now(),
      outboxKey,
    });
    return id;
  });
  return bookingId;
}

async function markNoShow(tenantId: TenantId, bookingId: string): Promise<void> {
  await withTenant(db, tenantId, (tx) =>
    tx.execute(`UPDATE bookings SET status = 'no_show' WHERE id = '${bookingId}'`),
  );
}

/** The outbox messages of `type` for the business, opened, with when each may run. */
async function outbox(
  tenantId: TenantId,
  type: 'payment' | 'email',
): Promise<{ content: Record<string, unknown>; availableAt: Date }[]> {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx.execute<{ id: string; payload: Buffer; available_at: Date }>(
      `SELECT id, payload, available_at FROM outbox_messages WHERE type = '${type}' ORDER BY created_at, id`,
    ),
  );
  return rows.rows.map((row) => ({
    content: JSON.parse(
      openOutboxContent(outboxKey, OutboxMessageIdSchema.parse(row.id), row.payload).toString(
        'utf8',
      ),
    ) as Record<string, unknown>,
    availableAt: new Date(row.available_at),
  }));
}

async function approve(business: Business, bookingId: string, chargeCents: number) {
  return withTenant(db, business.tenantId, (tx) =>
    approveNoShowFeeIn(
      tx,
      { ...business.owner, via: 'ai' },
      {
        bookingId,
        chargeCents,
        now: business.clock.now(),
        outboxKey,
      },
    ),
  );
}

async function runQueuedFeeJobs(business: Business): Promise<void> {
  for (const { content } of await outbox(business.tenantId, 'payment')) {
    if ('bookingFeeId' in content) {
      await runPaymentJob(business.deps, business.tenantId, {
        kind: content['kind'] as 'fee_charge' | 'fee_refund',
        bookingFeeId: String(content['bookingFeeId']),
      });
    }
  }
}

describe('no-show fees (S68)', () => {
  it('keeps the terms the client was shown with the payment, whatever the policy says later (AC-X-136)', async () => {
    const business = await newBusiness();
    const card = await bookedWithCard(business);
    await setPolicy(business.tenantId, {
      lateCancel: { kind: 'none' },
      noShow: { kind: 'percent', percent: 50 },
    });
    const percent = await bookedWithCard(business, { kind: 'card', refundHours: 24 }, 4500);
    await setPolicy(business.tenantId, null);
    const none = await bookedWithCard(business);
    const rows = await withTenant(db, business.tenantId, async (tx) =>
      Promise.all([card, percent, none].map((id) => findBookingPaymentByBooking(tx, id))),
    );
    expect(rows.map((row) => [row?.policySentence, row?.noShowFeeCents])).toEqual([
      [SENTENCE, 2000],
      [
        'Please cancel or reschedule at least 24 hours before your visit. No-shows may be charged 50% of the service price.',
        2250,
      ],
      [null, null],
    ]);
  });

  it('offers the stored fee for a no-show, less a kept deposit, or says why not (AC-X-137)', async () => {
    const business = await newBusiness();
    const card = await bookedWithCard(business);
    const deposit = await bookedWithCard(business, {
      kind: 'deposit',
      amountCents: 1500,
      refundHours: 24,
    });
    const offer = (id: string) =>
      withTenant(db, business.tenantId, (tx) => noShowFeeOfferIn(tx, id));
    expect(await offer(card)).toBe('not_no_show');
    await markNoShow(business.tenantId, card);
    await markNoShow(business.tenantId, deposit);
    expect(await offer(card)).toMatchObject({
      feeCents: 2000,
      keptDepositCents: 0,
      chargeCents: 2000,
      policySentence: SENTENCE,
      cardKind: 'card',
    });
    expect(await offer(deposit)).toMatchObject({
      feeCents: 2000,
      keptDepositCents: 1500,
      chargeCents: 500,
      cardKind: 'deposit',
    });

    await setPolicy(business.tenantId, null);
    const before = await bookedWithCard(business);
    await markNoShow(business.tenantId, before);
    expect(await offer(before)).toBe('no_terms');

    await withTenant(db, business.tenantId, (tx) =>
      tx.execute('UPDATE payment_accounts SET charges_enabled = false'),
    );
    expect(await offer(card)).toBe('payments_off');
    expect(business.sandbox.charges).toHaveLength(0);
  });

  it('charges nothing until the owner approves, and only owners may (AC-X-138/139)', async () => {
    const business = await newBusiness();
    const bookingId = await bookedWithCard(business);
    await markNoShow(business.tenantId, bookingId);
    for (const role of ['manager', 'staff'] as const) {
      const member: Actor = {
        context: { tenantId: business.tenantId, userId: await insertUser(db, role), role },
        via: 'ai',
      };
      await expect(
        withTenant(db, business.tenantId, (tx) =>
          approveNoShowFeeIn(tx, member, {
            bookingId,
            chargeCents: 2000,
            now: business.clock.now(),
            outboxKey,
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    // The amount must be the card's: a stale card charges nothing.
    await expect(approve(business, bookingId, 1500)).rejects.toBeInstanceOf(
      NoShowFeeNotChargeableError,
    );
    expect(await outbox(business.tenantId, 'payment')).toEqual([]);

    const fee = await approve(business, bookingId, 2000);
    expect(fee).toMatchObject({
      status: 'queued',
      amountCents: 2000,
      policySentence: SENTENCE,
      approvedBy: business.ownerId,
    });
    const [queued] = await outbox(business.tenantId, 'payment');
    expect(queued?.content).toEqual({ kind: 'fee_charge', bookingFeeId: fee.id });
    // The grace: an Undo right after the OK moves no money.
    expect(queued?.availableAt.getTime()).toBe(business.clock.now().getTime() + 60_000);
    expect(business.sandbox.charges).toHaveLength(0);
    await expect(approve(business, bookingId, 2000)).rejects.toMatchObject({
      reason: 'already_decided',
    });
  });

  it('charges the kept card once, off-session, and emails the receipt (AC-X-140/142)', async () => {
    const business = await newBusiness();
    const bookingId = await bookedWithCard(business);
    await markNoShow(business.tenantId, bookingId);
    const fee = await approve(business, bookingId, 2000);
    await runQueuedFeeJobs(business);
    await runQueuedFeeJobs(business);
    expect(business.sandbox.charges).toHaveLength(1);
    expect(business.sandbox.charges[0]).toMatchObject({
      amountCents: 2000,
      idempotencyKey: `pepper-fee-${fee.id}`,
      paymentMethodId: expect.stringMatching(/^pm_sandbox/) as unknown,
    });
    const stored = await withTenant(db, business.tenantId, (tx) =>
      findBookingFeeByBooking(tx, bookingId),
    );
    expect(stored).toMatchObject({
      status: 'charged',
      intentId: expect.stringMatching(/^pi_/) as unknown,
    });
    const emails = await outbox(business.tenantId, 'email');
    const receipt = emails.find((email) => String(email.content['subject']).startsWith('Receipt'));
    expect(receipt?.content['subject']).toBe('Receipt: $20 missed visit fee from Fade Room');
    expect(String(receipt?.content['text'])).toContain(SENTENCE);
    expect(String(receipt?.content['text'])).toContain('Amount: $20');
    expect(String(receipt?.content['text'])).not.toMatch(/pm_|cus_|pi_/);
    const audit = await withTenant(db, business.tenantId, (tx) =>
      listAuditEntries(tx, { limit: 50 }),
    );
    const steps = audit
      .filter((entry) => entry.action === 'payments.fee_changed')
      .map((entry) => [entry.before, entry.after.status, entry.actor.kind])
      .reverse();
    expect(steps).toEqual([
      [null, 'queued', 'ai_on_behalf_of'],
      [{ status: 'queued' }, 'charging', 'system'],
      [{ status: 'charging' }, 'charged', 'system'],
    ]);
  });

  it('records a decline with Stripe’s code, retries nothing and tells the owners (AC-X-140)', async () => {
    const business = await newBusiness();
    const bookingId = await bookedWithCard(business);
    await markNoShow(business.tenantId, bookingId);
    const payment = await withTenant(db, business.tenantId, (tx) =>
      findBookingPaymentByBooking(tx, bookingId),
    );
    const setup = await business.sandbox.retrieveSetupIntent(String(payment?.intentId));
    await business.sandbox.setCardOutcome(String(setup.payment_method), 'card_declined');
    await approve(business, bookingId, 2000);
    await runQueuedFeeJobs(business);
    await runQueuedFeeJobs(business);
    expect(business.sandbox.charges).toHaveLength(1);
    expect(
      await withTenant(db, business.tenantId, (tx) => findBookingFeeByBooking(tx, bookingId)),
    ).toMatchObject({ status: 'failed', failureCode: 'card_declined', intentId: null });
    const emails = await outbox(business.tenantId, 'email');
    expect(emails.some((email) => String(email.content['subject']).startsWith('Receipt'))).toBe(
      false,
    );
  });

  it('Undo cancels a fee that waits and refunds one taken, once (AC-X-141)', async () => {
    const business = await newBusiness();
    const waiting = await bookedWithCard(business);
    const taken = await bookedWithCard(business);
    await markNoShow(business.tenantId, waiting);
    await markNoShow(business.tenantId, taken);
    const undo = (feeId: string) =>
      withTenant(db, business.tenantId, (tx) =>
        undoNoShowFeeIn(tx, business.owner, {
          bookingFeeId: feeId,
          now: business.clock.now(),
          outboxKey,
        }),
      );

    const first = await approve(business, waiting, 2000);
    expect(await undo(first.id)).toBe('cancelled');
    await runQueuedFeeJobs(business);
    expect(business.sandbox.charges).toHaveLength(0);

    const second = await approve(business, taken, 2000);
    await runQueuedFeeJobs(business);
    expect(business.sandbox.charges).toHaveLength(1);
    expect(await undo(second.id)).toBe('refund_pending');
    expect(await undo(second.id)).toBe('refund_pending');
    await runQueuedFeeJobs(business);
    await runQueuedFeeJobs(business);
    expect(business.sandbox.refunds).toBe(1);
    expect(
      await withTenant(db, business.tenantId, (tx) => findBookingFeeByBooking(tx, taken)),
    ).toMatchObject({ status: 'refunded', refundId: expect.stringMatching(/^re_/) as unknown });
    expect(await undo(second.id)).toBe('refunded');
  });

  it('can’t be undone while Stripe is being asked', async () => {
    const business = await newBusiness();
    const bookingId = await bookedWithCard(business);
    await markNoShow(business.tenantId, bookingId);
    const fee = await approve(business, bookingId, 2000);
    await withTenant(db, business.tenantId, (tx) =>
      tx.execute(`UPDATE booking_fees SET status = 'charging' WHERE id = '${fee.id}'`),
    );
    await expect(
      withTenant(db, business.tenantId, (tx) =>
        undoNoShowFeeIn(tx, business.owner, {
          bookingFeeId: fee.id,
          now: business.clock.now(),
          outboxKey,
        }),
      ),
    ).rejects.toBeInstanceOf(NoShowFeeBusyError);
  });

  it('charges nothing when the no-show was taken back after the OK (review)', async () => {
    const business = await newBusiness();
    const bookingId = await bookedWithCard(business);
    await markNoShow(business.tenantId, bookingId);
    await approve(business, bookingId, 2000);
    await withTenant(db, business.tenantId, (tx) =>
      tx.execute(`UPDATE bookings SET status = 'confirmed' WHERE id = '${bookingId}'`),
    );
    await runQueuedFeeJobs(business);
    expect(business.sandbox.charges).toHaveLength(0);
    expect(
      await withTenant(db, business.tenantId, (tx) => findBookingFeeByBooking(tx, bookingId)),
    ).toMatchObject({ status: 'cancelled' });
  });

  it('reads a refund Stripe left pending again until it settles (review)', async () => {
    const business = await newBusiness();
    const bookingId = await bookedWithCard(business);
    await markNoShow(business.tenantId, bookingId);
    const fee = await approve(business, bookingId, 2000);
    await runQueuedFeeJobs(business);
    await withTenant(db, business.tenantId, (tx) =>
      undoNoShowFeeIn(tx, business.owner, {
        bookingFeeId: fee.id,
        now: business.clock.now(),
        outboxKey,
      }),
    );
    business.sandbox.pendingOnce = true;
    const job = { kind: 'fee_refund' as const, bookingFeeId: fee.id };
    // Pending: kept with its id, and the outbox asks again.
    await expect(runPaymentJob(business.deps, business.tenantId, job)).rejects.toMatchObject({
      retryable: true,
    });
    const pending = await withTenant(db, business.tenantId, (tx) =>
      findBookingFeeByBooking(tx, bookingId),
    );
    expect(pending).toMatchObject({ status: 'refund_pending' });
    expect(pending?.refundId).toMatch(/^re_/);
    await runPaymentJob(business.deps, business.tenantId, job);
    expect(business.sandbox.refunds).toBe(1);
    expect(
      await withTenant(db, business.tenantId, (tx) => findBookingFeeByBooking(tx, bookingId)),
    ).toMatchObject({ status: 'refunded' });
  });
});

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  changeBooking,
  confirmManagedBooking,
  createBooking,
  sendDueReminders,
  updateReminderSettings,
} from '@pepper/appointments';
import {
  BookingIdSchema,
  ManageTokenSchema,
  TenantSlugSchema,
  type ActionProposal,
  type Booking,
} from '@pepper/contracts';
import { listPendingProposals } from '@pepper/core';
import {
  findBooking,
  findBookingPaymentByBooking,
  findCurrentTenant,
  insertBookingPayment,
  insertPaymentAccount,
  markBookingConfirmAsked,
  moveBookingPayment,
  setBookingManageTokenHash,
  withTenant,
  type Database,
} from '@pepper/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveToolProposal } from '../tools/registry.js';
import {
  depsFor,
  newWorld,
  NOW,
  OUTBOX_KEY,
  startTestDatabase,
  type TestDatabase,
  type World,
} from '../tools/test-support.js';
import { proposeReleaseIn } from './release.js';

// The release card (S78.2, ADR-0071 §S78.2; AC-X-207…210) against real Postgres: proposed by the
// reminder job at the confirm cut-off for an asked, unconfirmed visit; approved by an owner or
// manager only; a release cancels as the business, emails the client, refunds a deposit in full
// and frees the time; a confirm or a move takes the card away; a confirm and an approval at once
// leave one outcome.

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

const HOUR = 3_600_000;
const EMAILS = { baseUrl: 'http://localhost:3000', outboxKey: OUTBOX_KEY };
/** Thursday 5 November at `HH:MM` in New York (UTC-5). */
const thursdayAt = (time: string) => {
  const [h = 0, m = 0] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, 5, h + 5, m)).toISOString();
};

/**
 * A business that asks clients to confirm, and Maria's Thursday 2 pm asked on Monday (or at
 * `askedAt`).
 */
async function askedVisit(
  w: World,
  time = '14:00',
  askedAt: (booking: Booking) => Date = () => new Date(NOW),
): Promise<Booking> {
  await updateReminderSettings(db, w.owner, { askToConfirm: true }, { clock: w.clock });
  const booking = await createBooking(
    db,
    w.owner,
    {
      clientId: w.maria.id,
      serviceId: w.haircut.id,
      staffMemberId: w.jessStaff.id,
      startsAt: thursdayAt(time),
      notifyClient: false,
    },
    { clock: w.clock },
  );
  await withTenant(db, w.tenantId, (tx) =>
    markBookingConfirmAsked(tx, BookingIdSchema.parse(booking.id), askedAt(booking)),
  );
  return booking;
}

const cutoffOf = (booking: Booking) => new Date(Date.parse(booking.startsAt) - 24 * HOUR);

async function releaseJob(w: World) {
  return sendDueReminders(db, {
    key: OUTBOX_KEY,
    clock: w.clock,
    onReleaseDue: (tx, visit) =>
      proposeReleaseIn(tx, visit.tenantId, visit.bookingId, { db, clock: w.clock, emails: EMAILS }),
  });
}

async function releaseCards(w: World): Promise<ActionProposal[]> {
  const pending = await listPendingProposals(db, w.owner, { clock: w.clock });
  return pending.filter((proposal) => proposal.action === 'booking.release');
}

async function oneCard(w: World): Promise<ActionProposal> {
  const cards = await releaseCards(w);
  expect(cards).toHaveLength(1);
  const [card] = cards;
  if (card === undefined) throw new Error('no card');
  return card;
}

async function rowOf(w: World, booking: Booking) {
  return withTenant(db, w.tenantId, (tx) => findBooking(tx, BookingIdSchema.parse(booking.id)));
}

/** A manage link for the visit (the client's), so the test can confirm by link. */
async function manageLink(w: World, booking: Booking) {
  const token = ManageTokenSchema.parse(randomBytes(32).toString('base64url'));
  const hash = createHash('sha256').update(token).digest('hex');
  const slug = await withTenant(db, w.tenantId, async (tx) => {
    await setBookingManageTokenHash(tx, BookingIdSchema.parse(booking.id), hash);
    return (await findCurrentTenant(tx))?.slug ?? '';
  });
  return { slug: TenantSlugSchema.parse(slug), token };
}

describe('the release card at the cut-off (AC-X-207)', () => {
  it('comes once, at the cut-off, for an asked and unconfirmed visit', async () => {
    const w = await newWorld(db);
    const booking = await askedVisit(w);
    w.clock.set(new Date(cutoffOf(booking).getTime() - 60_000).toISOString());
    await releaseJob(w);
    expect(await releaseCards(w)).toHaveLength(0);

    w.clock.set(cutoffOf(booking).toISOString());
    await releaseJob(w);
    const card = await oneCard(w);
    const preview = card.preview as { summary?: string };
    expect(preview.summary).toMatch(
      /^Maria L\.? hasn’t confirmed Thu, Nov 5, 2:00 pm\. Release it and offer it\?$/,
    );
    expect(card.requestedByUserId).toBeNull();

    // A second pass, or the proposer again, makes no second card.
    await releaseJob(w);
    await withTenant(db, w.tenantId, (tx) =>
      proposeReleaseIn(tx, w.tenantId, BookingIdSchema.parse(booking.id), {
        db,
        clock: w.clock,
        emails: EMAILS,
      }),
    );
    expect(await releaseCards(w)).toHaveLength(1);
    // Nothing changed without a tap.
    expect((await rowOf(w, booking))?.status).toBe('confirmed');
  });

  it('never comes for a visit nobody asked, or asked at the cut-off itself', async () => {
    const w = await newWorld(db);
    await updateReminderSettings(db, w.owner, { askToConfirm: true }, { clock: w.clock });
    const unasked = await createBooking(
      db,
      w.owner,
      {
        clientId: w.sara.id,
        serviceId: w.haircut.id,
        staffMemberId: w.marcoStaff.id,
        startsAt: thursdayAt('11:00'),
        notifyClient: false,
      },
      { clock: w.clock },
    );
    const late = await askedVisit(w, '15:00', cutoffOf);
    w.clock.set(cutoffOf(late).toISOString());
    await releaseJob(w);
    expect(cutoffOf(unasked).getTime()).toBeLessThan(w.clock.now().getTime());
    expect(await releaseCards(w)).toHaveLength(0);
  });
});

describe('approving a release (AC-X-208, AC-X-209)', () => {
  it('waits for an owner or manager, then releases, emails, refunds and frees the time', async () => {
    const w = await newWorld(db);
    const booking = await askedVisit(w);
    const id = BookingIdSchema.parse(booking.id);
    // A paid deposit on the visit.
    await withTenant(db, w.tenantId, async (tx) => {
      const account = `acct_sandbox${randomBytes(6).toString('hex')}`;
      await insertPaymentAccount(tx, {
        provider: 'sandbox',
        providerAccountId: account,
        generation: 1,
        livemode: false,
        status: 'ready',
        snapshot: {
          chargesEnabled: true,
          payoutsEnabled: true,
          detailsSubmitted: true,
          currentlyDue: [],
          pastDue: [],
          eventuallyDue: [],
          pendingVerification: [],
          currentDeadline: null,
          disabledReason: null,
        },
        syncedAt: new Date(),
        createdBy: w.owner.context.userId,
      });
      const payment = await insertBookingPayment(tx, {
        requestId: randomUUID(),
        provider: 'sandbox',
        livemode: false,
        kind: 'deposit',
        intentId: `pi_sandbox${randomBytes(8).toString('hex')}`,
        customerId: `cus_sandbox${randomBytes(8).toString('hex')}`,
        accountId: account,
        amountCents: 2000,
        refundHours: 24,
      });
      if (payment === undefined) throw new Error('payment not stored');
      await moveBookingPayment(tx, payment.id, ['started'], {
        status: 'booked',
        bookingId: id,
        bookedAt: new Date(),
      });
    });
    w.clock.set(cutoffOf(booking).toISOString());
    await releaseJob(w);
    const card = await oneCard(w);
    const after = (card.preview as { after?: Record<string, unknown> }).after;
    expect(after).toMatchObject({ release: true, refund: true, emailed: true });

    // Staff can't approve it.
    await expect(
      approveToolProposal(depsFor(w, w.jess), card.id, card.fingerprint),
    ).rejects.toThrow();

    const result = await approveToolProposal(depsFor(w, w.manager), card.id, card.fingerprint);
    expect(result.kind).toBe('executed');
    if (result.kind !== 'executed') return;
    // No Undo: the email and the refund leave Pepper (D-5).
    expect(result.execution.undoUntil).toBeNull();
    const row = await rowOf(w, booking);
    expect(row).toMatchObject({ status: 'cancelled', cancelledBy: 'business' });
    await withTenant(db, w.tenantId, async (tx) => {
      expect((await findBookingPaymentByBooking(tx, id))?.status).toBe('refund_pending');
      const matches = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM waitlist_matches WHERE booking_id = ${id}`,
      );
      expect(matches.rows[0]?.n).toBe(1);
      const emails = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM outbox_messages WHERE dedupe_key LIKE ${`booking.cancelled:${id}:%`}`,
      );
      expect(emails.rows[0]?.n).toBe(1);
    });
    expect(await releaseCards(w)).toHaveLength(0);
  });
});

describe('what takes the card away (AC-X-210)', () => {
  it('a confirm by link', async () => {
    const w = await newWorld(db);
    const booking = await askedVisit(w);
    w.clock.set(cutoffOf(booking).toISOString());
    await releaseJob(w);
    await oneCard(w);
    const link = await manageLink(w, booking);
    await confirmManagedBooking(db, link.slug, link.token, booking.startsAt, { clock: w.clock });
    expect(await releaseCards(w)).toHaveLength(0);
  });

  it('the business no longer asking clients to confirm', async () => {
    const w = await newWorld(db);
    const booking = await askedVisit(w);
    w.clock.set(cutoffOf(booking).toISOString());
    await releaseJob(w);
    await oneCard(w);
    await updateReminderSettings(db, w.owner, { askToConfirm: false }, { clock: w.clock });
    expect(await releaseCards(w)).toHaveLength(0);
  });

  it('a new cut-off it no longer fits; the job brings it back at the new one (S78.3, AC-X-218)', async () => {
    const w = await newWorld(db);
    const booking = await askedVisit(w);
    w.clock.set(cutoffOf(booking).toISOString());
    await releaseJob(w);
    await oneCard(w);
    // 48 h: the visit is past that cut-off too and was asked early enough, so the card stays.
    await updateReminderSettings(db, w.owner, { confirmCutoffHours: 48 }, { clock: w.clock });
    await oneCard(w);
    // 12 h: not there yet, so it goes, and comes back at 12 h before the visit.
    await updateReminderSettings(db, w.owner, { confirmCutoffHours: 12 }, { clock: w.clock });
    expect(await releaseCards(w)).toHaveLength(0);
    w.clock.set(new Date(Date.parse(booking.startsAt) - 12 * HOUR - 60_000).toISOString());
    await releaseJob(w);
    expect(await releaseCards(w)).toHaveLength(0);
    w.clock.set(new Date(Date.parse(booking.startsAt) - 12 * HOUR).toISOString());
    await releaseJob(w);
    await oneCard(w);
  });

  it('a move', async () => {
    const w = await newWorld(db);
    const booking = await askedVisit(w);
    w.clock.set(cutoffOf(booking).toISOString());
    await releaseJob(w);
    await oneCard(w);
    await changeBooking(
      db,
      w.owner,
      BookingIdSchema.parse(booking.id),
      { startsAt: thursdayAt('16:00'), notifyClient: false },
      { clock: w.clock },
    );
    expect(await releaseCards(w)).toHaveLength(0);
  });

  it('a confirm and an approval at the same moment leave one outcome', async () => {
    for (let round = 0; round < 4; round += 1) {
      const w = await newWorld(db);
      const booking = await askedVisit(w);
      w.clock.set(cutoffOf(booking).toISOString());
      await releaseJob(w);
      const card = await oneCard(w);
      const link = await manageLink(w, booking);
      const [approval, confirm] = await Promise.allSettled([
        approveToolProposal(depsFor(w, w.owner), card.id, card.fingerprint),
        confirmManagedBooking(db, link.slug, link.token, booking.startsAt, { clock: w.clock }),
      ]);
      const row = await rowOf(w, booking);
      const released = approval.status === 'fulfilled' && approval.value.kind === 'executed';
      if (released) {
        // Released first: the confirm was refused and the visit stays released.
        expect(confirm.status).toBe('rejected');
        expect(row).toMatchObject({ status: 'cancelled', clientConfirmedAt: null });
      } else {
        // Confirmed first: nothing was released.
        expect(confirm.status).toBe('fulfilled');
        expect(row?.status).toBe('confirmed');
        expect(row?.clientConfirmedAt).not.toBeNull();
      }
      expect(await releaseCards(w)).toHaveLength(0);
    }
  });
});

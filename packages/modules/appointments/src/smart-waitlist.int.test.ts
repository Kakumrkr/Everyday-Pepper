import {
  TenantIdSchema,
  WaitlistMatchIdSchema,
  type Client,
  type ManageToken,
  type Service,
  type StaffMember,
  type TenantId,
  type TenantSlug,
  type WaitlistEntry,
} from '@pepper/contracts';
import { createBusiness, createClient, ManualClock, type Actor } from '@pepper/core';
import {
  expireWaitlistOffers,
  listWaitlistMatches,
  withTenant,
  type Database,
  type WaitlistMatchRow,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  WaitlistOfferExpiredError,
  WaitlistOfferNotFoundError,
  WaitlistOfferTakenError,
  WaitlistOfferUsedError,
} from './errors.js';
import type { WaitlistTakenNotice } from './services/booking-emails.js';
import {
  changeBooking,
  createBooking,
  listBookings,
  reinstateBookingIn,
} from './services/bookings.js';
import { replaceWorkingHours } from './services/hours.js';
import {
  cancelManagedBooking,
  claimWaitlistOffer,
  getWaitlistOffer,
} from './services/public-booking.js';
import { createService } from './services/services.js';
import {
  makeWaitlistOffersIn,
  takeBackWaitlistOffersIn,
  waitlistCandidatesIn,
  type MadeOffer,
} from './services/smart-waitlist.js';
import { createStaffMember, updateStaffMember } from './services/staff.js';
import { addTimeOff, removeTimeOff } from './services/time-off.js';
import { addToWaitlist, changeWaitlistEntry, listWaitlist } from './services/waitlist.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The smart waitlist through the domain services, against real Postgres (S37, ADR-0041,
// AC-W5-1): a cancelled or moved booking asks for its time to be matched; the ranking picks who
// fits; offers carry single-use claim links; the first claim books, every other claimant is
// told it's taken, and N concurrent claims make exactly one booking.

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
const NOW = '2026-11-02T12:00:00.000Z';
/** Tuesday 3 November, `HH:MM` in New York (UTC-5). */
const tue = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, 3, (h ?? 0) + 5, m ?? 0)).toISOString();
};

interface World {
  slug: TenantSlug;
  tenantId: TenantId;
  owner: Actor;
  haircut: Service;
  jess: StaffMember;
  marco: StaffMember;
  clock: ManualClock;
  clients: Client[];
}

/** Juniper: a 60-minute haircut by Jess and Marco, weekdays 09:00–17:00, and five clients. */
async function newWorld(): Promise<World> {
  slugs += 1;
  const slug = `juniper-wait-${String(slugs)}`;
  const ownerId = await insertUser(db, 'Lena');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Juniper Hair Studio',
    slug,
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const owner: Actor = { context: { tenantId, userId: ownerId, role: 'owner' } };
  const haircut = await createService(db, owner, { name: 'Haircut', durationMinutes: 60 });
  const jess = await createStaffMember(db, owner, {
    displayName: 'Jess',
    serviceIds: [haircut.id],
  });
  const marco = await createStaffMember(db, owner, {
    displayName: 'Marco',
    serviceIds: [haircut.id],
  });
  const week = {
    intervals: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
  };
  await replaceWorkingHours(db, owner, jess.id, week);
  await replaceWorkingHours(db, owner, marco.id, week);
  const clients: Client[] = [];
  for (const name of ['Maria Lopez', 'Sara Kim', 'Ana Ruiz', 'Bea Cole', 'Cleo Diaz', 'Dee Fox']) {
    const email = `${name.split(' ')[0]?.toLowerCase() ?? 'x'}-${String(slugs)}@example.test`;
    clients.push(await createClient(db, owner, { name, email }));
  }
  return { slug, tenantId, owner, haircut, jess, marco, clock: new ManualClock(NOW), clients };
}

function client(w: World, i: number): Client {
  const c = w.clients[i];
  if (c === undefined) throw new Error(`no client ${String(i)}`);
  return c;
}

/** Books client 0 with Jess on Tuesday at `time`. */
function bookJess(w: World, time = '10:00', clientIndex = 0) {
  return createBooking(
    db,
    w.owner,
    {
      clientId: client(w, clientIndex).id,
      serviceId: w.haircut.id,
      staffMemberId: w.jess.id,
      startsAt: tue(time),
      notifyClient: false,
    },
    { clock: w.clock },
  );
}

/**
 * Runs `join` while Tuesday is full (both off all day), as the waitlist takes only full times
 * (AC-W5-2); afterwards the day is open again, so a cancellation frees a time to offer.
 */
async function whileFull<T>(w: World, join: () => Promise<T>): Promise<T> {
  const day = { startsAt: '2026-11-03T05:00:00.000Z', endsAt: '2026-11-04T05:00:00.000Z' };
  const off = [
    [w.jess.id, await addTimeOff(db, w.owner, w.jess.id, day)],
    [w.marco.id, await addTimeOff(db, w.owner, w.marco.id, day)],
  ] as const;
  try {
    return await join();
  } finally {
    for (const [staffId, timeOff] of off) await removeTimeOff(db, w.owner, staffId, timeOff.id);
  }
}

function wait(
  w: World,
  clientIndex: number,
  staffMemberId: string | null,
  window = { start: '09:00', end: '12:00' },
): Promise<WaitlistEntry> {
  return whileFull(w, () =>
    addToWaitlist(
      db,
      w.owner,
      {
        clientId: client(w, clientIndex).id,
        serviceId: w.haircut.id,
        staffMemberId: staffMemberId,
        windows: [{ date: '2026-11-03', ...window }],
      },
      { clock: w.clock },
    ),
  );
}

async function matches(w: World): Promise<WaitlistMatchRow[]> {
  return withTenant(db, w.tenantId, (tx) => listWaitlistMatches(tx, 100));
}

/** Cancels the 10:00 booking and offers its time to the ranking's best (as the worker does). */
async function cancelAndOffer(w: World, fanOut = 3): Promise<MadeOffer[]> {
  const booking = await bookJess(w);
  await changeBooking(db, w.owner, booking.id, { status: 'cancelled', notifyClient: false });
  const [match] = await matches(w);
  if (match === undefined) throw new Error('no match row');
  return withTenant(db, w.tenantId, async (tx) => {
    const ranked = await waitlistCandidatesIn(tx, match, { now: w.clock.now(), fanOut });
    return makeWaitlistOffersIn(
      tx,
      w.owner,
      {
        matchId: WaitlistMatchIdSchema.parse(match.id),
        staffMemberId: w.jess.id,
        startsAt: match.startsAt,
        entries: ranked,
      },
      { now: w.clock.now() },
    );
  });
}

function claim(w: World, made: MadeOffer, told: WaitlistTakenNotice[] = []) {
  return claimWaitlistOffer(db, w.slug, made.token, {
    clock: w.clock,
    tellTaken: (_tx, notice) => {
      told.push(notice);
      return Promise.resolve();
    },
  });
}

async function activeBookingsAt(w: World, time: string) {
  const bookings = await listBookings(db, w.owner, {
    from: tue('00:00'),
    to: '2026-11-04T05:00:00.000Z',
  });
  return bookings.filter((b) => b.startsAt === tue(time) && b.status === 'confirmed');
}

describe('freed times ask for a match (in the freeing transaction)', () => {
  it('a cancellation, a move (its old time) and a client cancelling by link each write one', async () => {
    const w = await newWorld();
    const cancelled = await bookJess(w, '10:00');
    await changeBooking(db, w.owner, cancelled.id, { status: 'cancelled', notifyClient: false });
    const moved = await bookJess(w, '13:00', 1);
    await changeBooking(db, w.owner, moved.id, { startsAt: tue('15:00'), notifyClient: false });
    const found = await matches(w);
    expect(found.map((m) => [m.startsAt.toISOString(), m.staffMemberId, m.status])).toEqual([
      [tue('10:00'), w.jess.id, 'pending'],
      [tue('13:00'), w.jess.id, 'pending'],
    ]);
  });

  it('a booking cancelled through its link asks too; a time already started does not', async () => {
    const w = await newWorld();
    // A booking made with a confirmation email carries the client's reschedule/cancel link.
    let token: ManageToken | undefined;
    await createBooking(
      db,
      w.owner,
      {
        clientId: client(w, 0).id,
        serviceId: w.haircut.id,
        staffMemberId: w.jess.id,
        startsAt: tue('11:00'),
      },
      {
        clock: w.clock,
        notify: (_tx, notice) => {
          if (notice.kind === 'confirmed') token = notice.manageToken;
          return Promise.resolve();
        },
      },
    );
    if (token === undefined) throw new Error('no link');
    await cancelManagedBooking(db, w.slug, token, { clock: w.clock });
    expect((await matches(w)).map((m) => m.startsAt.toISOString())).toEqual([tue('11:00')]);

    const late = await newWorld();
    const past = await bookJess(late, '10:00');
    late.clock.set(tue('10:30'));
    await changeBooking(db, late.owner, past.id, { status: 'no_show' }, { clock: late.clock });
    expect(await matches(late)).toEqual([]);
  });
});

describe("one client's entries", () => {
  it('are read by client, however many joined before them', async () => {
    const w = await newWorld();
    for (const i of [1, 2, 3]) await wait(w, i, null);
    const theirs = await listWaitlist(
      db,
      w.owner,
      { clientId: client(w, 3).id, limit: 1 },
      { clock: w.clock },
    );
    expect(theirs.map((e) => e.clientId)).toEqual([client(w, 3).id]);
  });
});

describe('ranking who is waiting (published formula)', () => {
  it('asked-for-Jess first, then the longest waiting; Marco-only and misfits left out', async () => {
    const w = await newWorld();
    const anyoneOld = await wait(w, 1, null);
    const jessOnly = await wait(w, 2, w.jess.id);
    await wait(w, 3, w.marco.id);
    await wait(w, 4, null, { start: '13:00', end: '17:00' }); // window misses 10:00
    const anyoneNew = await wait(w, 5, null);
    const booking = await bookJess(w);
    await changeBooking(db, w.owner, booking.id, { status: 'cancelled', notifyClient: false });
    const [match] = await matches(w);
    if (match === undefined) throw new Error('no match');
    const ranked = await withTenant(db, w.tenantId, (tx) =>
      waitlistCandidatesIn(tx, match, { now: w.clock.now(), fanOut: 5 }),
    );
    expect(ranked.map((r) => [r.entryId, r.rank, r.fit])).toEqual([
      [jessOnly.id, 1, 'asked_for_staff'],
      [anyoneOld.id, 2, 'anyone'],
      [anyoneNew.id, 3, 'anyone'],
    ]);
  });

  it('a freed time no longer whole (part re-booked) fits no one', async () => {
    const w = await newWorld();
    await wait(w, 1, null);
    const booking = await bookJess(w, '10:00');
    await changeBooking(db, w.owner, booking.id, { status: 'cancelled', notifyClient: false });
    await bookJess(w, '10:30', 2); // overlaps the freed 10:00-11:00
    const [match] = await matches(w);
    if (match === undefined) throw new Error('no match');
    const ranked = await withTenant(db, w.tenantId, (tx) =>
      waitlistCandidatesIn(tx, match, { now: w.clock.now(), fanOut: 3 }),
    );
    expect(ranked).toEqual([]);
  });
});

describe('offers and claims (AC-W5-1)', () => {
  it('offers the top N, each entry marked offered, each link a different secret', async () => {
    const w = await newWorld();
    for (const i of [1, 2, 3, 4]) await wait(w, i, null);
    const made = await cancelAndOffer(w, 3);
    expect(made.map((m) => m.offer.rank)).toEqual([1, 2, 3]);
    expect(new Set(made.map((m) => m.token)).size).toBe(3);
    // Two hours from Monday 07:00 (the slot is a day away, so its hour-before is later).
    expect(made.map((m) => m.offer.expiresAt.toISOString())).toEqual(
      made.map(() => '2026-11-02T14:00:00.000Z'),
    );
    const entries = await listWaitlist(db, w.owner, {}, { clock: w.clock });
    expect(entries.map((e) => e.status).sort()).toEqual([
      'offered',
      'offered',
      'offered',
      'waiting',
    ]);
  });

  it('the first claim books; the others are told it is taken and wait again', async () => {
    const w = await newWorld();
    for (const i of [1, 2, 3]) await wait(w, i, null);
    const made = await cancelAndOffer(w);
    const [first, second, third] = made;
    if (first === undefined || second === undefined || third === undefined) throw new Error('3');
    const told: WaitlistTakenNotice[] = [];
    const won = await claim(w, second, told);
    expect(won.booking).toMatchObject({ status: 'confirmed', startsAt: tue('10:00') });
    expect(won.email.email).toBe(client(w, 2).email);
    expect(told.map((t) => t.email.email).sort()).toEqual(
      [client(w, 1).email, client(w, 3).email].sort(),
    );
    await expect(claim(w, first)).rejects.toBeInstanceOf(WaitlistOfferTakenError);
    await expect(claim(w, second)).rejects.toBeInstanceOf(WaitlistOfferUsedError);
    expect(await activeBookingsAt(w, '10:00')).toHaveLength(1);
    const entries = await listWaitlist(db, w.owner, { all: true }, { clock: w.clock });
    expect(entries.map((e) => [e.clientId, e.status]).sort()).toEqual(
      [
        [client(w, 1).id, 'waiting'],
        [client(w, 2).id, 'booked'],
        [client(w, 3).id, 'waiting'],
      ].sort(),
    );
    // The claimant's link now reads as claimed; the others' as taken, without the holder.
    expect((await getWaitlistOffer(db, w.slug, second.token, { clock: w.clock })).status).toBe(
      'claimed',
    );
    const seen = await getWaitlistOffer(db, w.slug, first.token, { clock: w.clock });
    expect(seen.status).toBe('taken');
    expect(JSON.stringify(seen)).not.toContain(client(w, 2).id);
  });

  it('N concurrent claims of one time make exactly one booking; one "taken" each', async () => {
    const w = await newWorld();
    for (const i of [1, 2, 3, 4, 5]) await wait(w, i, null);
    const made = await cancelAndOffer(w, 5);
    expect(made).toHaveLength(5);
    const told: WaitlistTakenNotice[] = [];
    const results = await Promise.allSettled(made.map((m) => claim(w, m, told)));
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(4);
    for (const r of lost) expect(r.reason).toBeInstanceOf(WaitlistOfferTakenError);
    expect(await activeBookingsAt(w, '10:00')).toHaveLength(1);
    // Every other client is told once, and only once.
    expect(told).toHaveLength(4);
    expect(new Set(told.map((t) => t.offerId)).size).toBe(4);
  });

  it('a time booked by the team meanwhile is "taken" for the claimant and the others', async () => {
    const w = await newWorld();
    for (const i of [1, 2]) await wait(w, i, null);
    const made = await cancelAndOffer(w);
    await bookJess(w, '10:00', 0);
    const told: WaitlistTakenNotice[] = [];
    const [first] = made;
    if (first === undefined) throw new Error('offer');
    await expect(claim(w, first, told)).rejects.toBeInstanceOf(WaitlistOfferTakenError);
    expect(told).toHaveLength(1);
    expect(await activeBookingsAt(w, '10:00')).toHaveLength(1);
  });

  it('an offer past its time cannot be claimed; the expiry pass puts the entry back', async () => {
    const w = await newWorld();
    await wait(w, 1, null);
    const [made] = await cancelAndOffer(w);
    if (made === undefined) throw new Error('offer');
    w.clock.set('2026-11-02T14:00:00.000Z');
    await expect(claim(w, made)).rejects.toBeInstanceOf(WaitlistOfferExpiredError);
    expect((await getWaitlistOffer(db, w.slug, made.token, { clock: w.clock })).status).toBe(
      'expired',
    );
    const closed = await withTenant(db, w.tenantId, (tx) =>
      expireWaitlistOffers(tx, w.clock.now(), 100),
    );
    expect(closed).toBe(1);
    const [entry] = await listWaitlist(db, w.owner, {}, { clock: w.clock });
    expect(entry?.status).toBe('waiting');
  });

  it('taking offers back (Undo) closes them and the entries wait again', async () => {
    const w = await newWorld();
    for (const i of [1, 2]) await wait(w, i, null);
    const made = await cancelAndOffer(w);
    await withTenant(db, w.tenantId, (tx) =>
      takeBackWaitlistOffersIn(
        tx,
        made.map((m) => m.offer.id as never),
      ),
    );
    const [first] = made;
    if (first === undefined) throw new Error('offer');
    await expect(claim(w, first)).rejects.toBeInstanceOf(WaitlistOfferExpiredError);
    const entries = await listWaitlist(db, w.owner, {}, { clock: w.clock });
    expect(entries.every((e) => e.status === 'waiting')).toBe(true);
  });

  it('a claim inside the offer window books, though the time is now within minimum notice', async () => {
    const w = await newWorld();
    await wait(w, 1, null);
    // Tuesday 07:30: 10:00 is outside the default 2-hour notice, so it is offered until 09:00.
    w.clock.set(tue('07:30'));
    const [made] = await cancelAndOffer(w);
    if (made === undefined) throw new Error('offer');
    expect(made.offer.expiresAt.toISOString()).toBe(tue('09:00'));
    // 08:15: inside the offer's window, though 10:00 is less than 2 hours away now.
    w.clock.set(tue('08:15'));
    const won = await claim(w, made);
    expect(won.booking).toMatchObject({ status: 'confirmed', startsAt: tue('10:00') });
  });

  it('a client taken off the list cannot claim; their offer closes and the others stay open', async () => {
    const w = await newWorld();
    for (const i of [1, 2]) await wait(w, i, null);
    const [first, second] = await cancelAndOffer(w);
    if (first === undefined || second === undefined) throw new Error('2 offers');
    await changeWaitlistEntry(db, w.owner, first.offer.entryId as never, { status: 'cancelled' });
    const told: WaitlistTakenNotice[] = [];
    await expect(claim(w, first, told)).rejects.toBeInstanceOf(WaitlistOfferExpiredError);
    expect(told).toEqual([]);
    expect(await activeBookingsAt(w, '10:00')).toHaveLength(0);
    const entries = await listWaitlist(db, w.owner, { all: true }, { clock: w.clock });
    expect(entries.find((e) => e.id === first.offer.entryId)?.status).toBe('cancelled');
    expect((await claim(w, second)).booking.startsAt).toBe(tue('10:00'));
  });

  it("a claimant whose own service no longer fits loses only their offer; another's still books", async () => {
    const w = await newWorld();
    const colour = await createService(db, w.owner, { name: 'Colour', durationMinutes: 90 });
    await updateStaffMember(db, w.owner, w.jess.id, {
      displayName: 'Jess',
      serviceIds: [w.haircut.id, colour.id],
    });
    // Sara waits for a colour (90 minutes fit while 11:00–11:30 is free), Ana for a haircut.
    await whileFull(w, () =>
      addToWaitlist(
        db,
        w.owner,
        {
          clientId: client(w, 1).id,
          serviceId: colour.id,
          staffMemberId: null,
          windows: [{ date: '2026-11-03', start: '09:00', end: '12:00' }],
        },
        { clock: w.clock },
      ),
    );
    await wait(w, 2, null);
    const made = await cancelAndOffer(w);
    const sara = made.find((m) => m.offer.clientId === client(w, 1).id);
    const ana = made.find((m) => m.offer.clientId === client(w, 2).id);
    if (sara === undefined || ana === undefined) throw new Error('2 offers');
    // 11:00 is booked meanwhile: a colour at 10:00 no longer fits, a haircut still does.
    await bookJess(w, '11:00', 0);
    const told: WaitlistTakenNotice[] = [];
    await expect(claim(w, sara, told)).rejects.toBeInstanceOf(WaitlistOfferTakenError);
    expect(told).toEqual([]);
    expect((await claim(w, ana)).booking.startsAt).toBe(tue('10:00'));
  });

  it('undoing the cancellation closes the offers made for its time', async () => {
    const w = await newWorld();
    for (const i of [1, 2]) await wait(w, i, null);
    const booking = await bookJess(w);
    await changeBooking(db, w.owner, booking.id, { status: 'cancelled', notifyClient: false });
    const [match] = await matches(w);
    if (match === undefined) throw new Error('no match row');
    const made = await withTenant(db, w.tenantId, async (tx) =>
      makeWaitlistOffersIn(
        tx,
        w.owner,
        {
          matchId: WaitlistMatchIdSchema.parse(match.id),
          staffMemberId: w.jess.id,
          startsAt: match.startsAt,
          entries: await waitlistCandidatesIn(tx, match, { now: w.clock.now(), fanOut: 3 }),
        },
        { now: w.clock.now() },
      ),
    );
    expect(made).toHaveLength(2);
    await withTenant(db, w.tenantId, (tx) =>
      reinstateBookingIn(tx, w.owner, booking.id, { clock: w.clock }),
    );
    const told: WaitlistTakenNotice[] = [];
    for (const m of made) {
      await expect(claim(w, m, told)).rejects.toBeInstanceOf(WaitlistOfferExpiredError);
    }
    expect(told).toEqual([]);
    const entries = await listWaitlist(db, w.owner, {}, { clock: w.clock });
    expect(entries.map((e) => e.status)).toEqual(['waiting', 'waiting']);
  });

  it("an unknown link, or another business's slug, finds nothing", async () => {
    const w = await newWorld();
    await wait(w, 1, null);
    const [made] = await cancelAndOffer(w);
    if (made === undefined) throw new Error('offer');
    const other = await newWorld();
    await expect(
      claimWaitlistOffer(db, other.slug, made.token, { clock: w.clock }),
    ).rejects.toBeInstanceOf(WaitlistOfferNotFoundError);
    await expect(
      getWaitlistOffer(db, w.slug, 'b'.repeat(43) as never, { clock: w.clock }),
    ).rejects.toBeInstanceOf(WaitlistOfferNotFoundError);
  });
});

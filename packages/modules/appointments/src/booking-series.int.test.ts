import {
  TenantIdSchema,
  OutboxMessageIdSchema,
  type BookingSeriesInput,
  type Client,
  type MembershipRole,
  type Service,
  type StaffMember,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import {
  createBusiness,
  createClient,
  ForbiddenError,
  ManualClock,
  openOutboxContent,
  outboxKeyFrom,
  type Actor,
} from '@pepper/core';
import {
  addMembership,
  listAuditEntries,
  listOccupancy,
  withTenant,
  type Database,
} from '@pepper/db';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BookingNotChangeableError,
  BookingNotFoundError,
  IdempotencyKeyReusedError,
  SlotUnavailableError,
} from './errors.js';
import {
  cancelFollowing,
  createSeries,
  getSeries,
  previewSeries,
  type SeriesNotice,
} from './services/booking-series.js';
import { queueSeriesEmail } from './services/booking-emails.js';
import { changeBooking, createBooking, getBooking, listBookings } from './services/bookings.js';
import { replaceWorkingHours } from './services/hours.js';
import { replaceBookingRules } from './services/rules.js';
import { createService } from './services/services.js';
import { createStaffMember } from './services/staff.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// Recurring appointments through the domain services, against real Postgres (S72, ADR-0070):
// the preview checks every date and books nothing (AC-X-182); a series books the free dates in
// one transaction, idempotently, never overlapping another booking (AC-X-183, property test);
// staff book only their own (AC-X-184); one email a series (AC-X-185); "this and following"
// (AC-X-186).

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
const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
/** Tuesday 3 November 2026 at `hour`:00 in New York (UTC-5), plus `weeks` weeks. */
const tue = (hour: number, weeks = 0) =>
  new Date(Date.UTC(2026, 10, 3, hour + 5) + weeks * WEEK).toISOString();

interface Business {
  tenantId: TenantId;
  owner: Actor;
  staff: Actor;
  colleague: Actor;
  service: Service;
  jess: StaffMember;
  marco: StaffMember;
  client: Client;
  clock: ManualClock;
}

/** Juniper: a 60-minute haircut, Jess (staff login) and Marco (colleague) Mon–Fri 09–17. */
async function newBusiness(): Promise<Business> {
  slugs += 1;
  const ownerId = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Juniper Hair Studio',
    slug: `juniper-series-${String(slugs)}`,
    timeZone: 'America/New_York',
    templateId: null,
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const actor = (userId: UserId, role: MembershipRole): Actor => ({
    context: { tenantId, userId, role },
    requestId: `req-${role}`,
  });
  const staffId = await insertUser(db, 'Jess');
  const colleagueId = await insertUser(db, 'Priya');
  await withTenant(db, tenantId, async (tx) => {
    await addMembership(tx, { userId: staffId, role: 'staff' });
    await addMembership(tx, { userId: colleagueId, role: 'staff' });
  });
  const owner = actor(ownerId, 'owner');
  const service = await createService(db, owner, { name: 'Haircut', durationMinutes: 60 });
  const jess = await createStaffMember(db, owner, {
    displayName: 'Jess',
    userId: staffId,
    serviceIds: [service.id],
  });
  const marco = await createStaffMember(db, owner, {
    displayName: 'Marco',
    userId: colleagueId,
    serviceIds: [service.id],
  });
  const week = {
    intervals: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
  };
  await replaceWorkingHours(db, owner, jess.id, week);
  await replaceWorkingHours(db, owner, marco.id, week);
  const client = await createClient(db, owner, {
    name: 'Maria Lopez',
    email: 'maria@example.test',
  });
  return {
    tenantId,
    owner,
    staff: actor(staffId, 'staff'),
    colleague: actor(colleagueId, 'staff'),
    service,
    jess,
    marco,
    client,
    clock: new ManualClock(NOW),
  };
}

function seriesOf(b: Business, startsAts: string[], extra: Partial<BookingSeriesInput> = {}) {
  return {
    clientId: b.client.id,
    serviceId: b.service.id,
    staffMemberId: b.jess.id,
    everyWeeks: 1,
    startsAts,
    ...extra,
  } satisfies BookingSeriesInput;
}

function bookOne(b: Business, startsAt: string, staffMemberId = b.jess.id) {
  return createBooking(
    db,
    b.owner,
    {
      clientId: b.client.id,
      serviceId: b.service.id,
      staffMemberId,
      startsAt,
      notifyClient: false,
    },
    { clock: b.clock },
  );
}

async function seriesRows(b: Business): Promise<number> {
  return withTenant(db, b.tenantId, async (tx) => {
    const { rows } = await tx.execute<{ n: number }>(
      'SELECT count(*)::int AS n FROM booking_series',
    );
    return rows[0]?.n ?? -1;
  });
}

describe('previewSeries (AC-X-182)', () => {
  it('checks every date as one booking would, and books nothing', async () => {
    const b = await newBusiness();
    await bookOne(b, tue(10, 2));
    const before = await listBookings(db, b.owner, { from: tue(0), to: tue(23, 5) });
    const preview = await previewSeries(
      db,
      b.owner,
      {
        serviceId: b.service.id,
        staffMemberId: b.jess.id,
        startsAt: tue(10),
        repeat: { everyWeeks: 1, count: 4 },
      },
      { clock: b.clock },
    );
    expect(preview.visits.map((v) => [v.startsAt, v.free])).toEqual([
      [tue(10), true],
      [tue(10, 1), true],
      [tue(10, 2), false],
      [tue(10, 3), true],
    ]);
    const taken = preview.visits[2];
    expect(taken?.tooFarAhead).toBe(false);
    expect(taken?.alternatives.length).toBeGreaterThan(0);
    expect(taken?.alternatives.every((slot) => slot.startsAt !== tue(10, 2))).toBe(true);
    expect(preview.visits[0]?.endsAt).toBe(tue(11));
    expect(await listBookings(db, b.owner, { from: tue(0), to: tue(23, 5) })).toEqual(before);
    expect(await seriesRows(b)).toBe(0);
  });

  it('says which dates are further ahead than the business takes bookings', async () => {
    const b = await newBusiness();
    const preview = await previewSeries(
      db,
      b.owner,
      {
        serviceId: b.service.id,
        staffMemberId: b.jess.id,
        startsAt: tue(10),
        repeat: { everyWeeks: 2, count: 8 },
      },
      { clock: b.clock },
    );
    expect(preview.maximumAdvanceDays).toBe(90);
    // Every 2 weeks: day 1 … day 99; the last one is past 90 days.
    expect(preview.visits.map((v) => v.free)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(preview.visits.at(-1)?.tooFarAhead).toBe(true);
  });

  it('refuses staff previewing a colleague', async () => {
    const b = await newBusiness();
    await expect(
      previewSeries(db, b.staff, {
        serviceId: b.service.id,
        staffMemberId: b.marco.id,
        startsAt: tue(10),
        repeat: { everyWeeks: 1, count: 2 },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('createSeries (AC-X-183)', () => {
  it('books the free dates in one go and returns the taken one with alternatives', async () => {
    const b = await newBusiness();
    const blocker = await bookOne(b, tue(10, 1), b.jess.id);
    const result = await createSeries(
      db,
      b.owner,
      seriesOf(b, [tue(10), tue(10, 1), tue(10, 2), tue(10, 3)], { notifyClient: false }),
      { clock: b.clock },
    );
    expect(result.bookings.map((x) => x.startsAt)).toEqual([tue(10), tue(10, 2), tue(10, 3)]);
    expect(result.bookings.every((x) => x.seriesId === result.seriesId)).toBe(true);
    expect(result.bookings.every((x) => x.source === 'team' && !x.overridden)).toBe(true);
    expect(result.skipped.map((s) => s.startsAt)).toEqual([tue(10, 1)]);
    expect(result.skipped[0]?.alternatives.length).toBeGreaterThan(0);
    expect(result.everyWeeks).toBe(1);
    expect((await getBooking(db, b.owner, blocker.id)).seriesId).toBeNull();
    const series = await getSeries(db, b.owner, result.seriesId);
    expect(series.bookings.map((x) => x.id)).toEqual(result.bookings.map((x) => x.id));
    // Each visit is audited as a booking of its own.
    const audit = await withTenant(db, b.tenantId, (tx) => listAuditEntries(tx, { limit: 50 }));
    const created = audit.filter((entry) => entry.action === 'booking.created');
    for (const visit of result.bookings) {
      expect(created.some((entry) => entry.entity.id === visit.id)).toBe(true);
    }
  });

  it('applies the rules the database alone does not (a daily cap of one)', async () => {
    const b = await newBusiness();
    // A cap of one a day: the series fills its two Tuesdays, so a second one finds them full.
    await replaceBookingRules(db, b.owner, {
      rules: [{ type: 'max_bookings_per_day', params: { count: 1 } }],
    });
    const result = await createSeries(
      db,
      b.owner,
      seriesOf(b, [tue(10), tue(10, 1)], { notifyClient: false }),
      { clock: b.clock },
    );
    expect(result.bookings).toHaveLength(2);
    // A second series on the same days: each date is full now.
    await expect(
      createSeries(db, b.owner, seriesOf(b, [tue(14), tue(14, 1)]), { clock: b.clock }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);
  });

  it('keeps nothing when no date is free', async () => {
    const b = await newBusiness();
    await bookOne(b, tue(10));
    await bookOne(b, tue(10, 1));
    const error = await createSeries(db, b.owner, seriesOf(b, [tue(10), tue(10, 1)]), {
      clock: b.clock,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SlotUnavailableError);
    expect((error as SlotUnavailableError).alternatives.length).toBeGreaterThan(0);
    expect(await seriesRows(b)).toBe(0);
  });

  it('answers a retry with the key with the first series, and refuses the key reused', async () => {
    const b = await newBusiness();
    const input = seriesOf(b, [tue(10), tue(10, 1)], {
      idempotencyKey: 'series-retry-1',
      notifyClient: false,
    });
    const [first, second] = await Promise.all([
      createSeries(db, b.owner, input, { clock: b.clock }),
      createSeries(db, b.owner, input, { clock: b.clock }),
    ]);
    expect(second.seriesId).toBe(first.seriesId);
    expect(second.bookings.map((x) => x.id)).toEqual(first.bookings.map((x) => x.id));
    const all = await listBookings(db, b.owner, { from: tue(0), to: tue(23, 2) });
    expect(all).toHaveLength(2);
    await expect(
      createSeries(db, b.owner, { ...input, startsAts: [tue(11), tue(11, 1)] }, { clock: b.clock }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it('lets staff book a series for themselves only (AC-X-184)', async () => {
    const b = await newBusiness();
    // Staff reach a client they have a booking with.
    await bookOne(b, tue(16));
    await expect(
      createSeries(db, b.staff, seriesOf(b, [tue(10), tue(10, 1)], { staffMemberId: b.marco.id })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const own = await createSeries(
      db,
      b.staff,
      seriesOf(b, [tue(10), tue(10, 1)], { notifyClient: false }),
      {
        clock: b.clock,
      },
    );
    expect(own.bookings).toHaveLength(2);
    // The colleague (Marco's login) doesn't see Jess's series.
    await expect(getSeries(db, b.colleague, own.seriesId)).rejects.toBeInstanceOf(
      BookingNotFoundError,
    );
    expect((await getSeries(db, b.staff, own.seriesId)).bookings).toHaveLength(2);
  });

  it('tells the client once, with a link for every visit (AC-X-185)', async () => {
    const b = await newBusiness();
    const notices: SeriesNotice[] = [];
    const result = await createSeries(db, b.owner, seriesOf(b, [tue(10), tue(10, 1), tue(10, 2)]), {
      clock: b.clock,
      notify: (_tx, notice) => {
        notices.push(notice);
        return Promise.resolve();
      },
    });
    expect(notices).toHaveLength(1);
    const notice = notices[0];
    expect(notice?.kind).toBe('series_confirmed');
    if (notice?.kind !== 'series_confirmed') return;
    expect(notice.seriesId).toBe(result.seriesId);
    expect(notice.email.email).toBe('maria@example.test');
    expect(notice.visits.map((v) => v.startsAt)).toEqual([tue(10), tue(10, 1), tue(10, 2)]);
    expect(new Set(notice.visits.map((v) => v.manageToken)).size).toBe(3);
    const hashes = await withTenant(db, b.tenantId, async (tx) => {
      const { rows } = await tx.execute<{ n: number }>(
        `SELECT count(*)::int AS n FROM bookings WHERE series_id = '${result.seriesId}' AND manage_token_hash IS NOT NULL`,
      );
      return rows[0]?.n;
    });
    expect(hashes).toBe(3);
  });
});

describe('the series email in the outbox (AC-X-185)', () => {
  const outboxKey = outboxKeyFrom('an-integration-test-outbox-secret-32+');
  const emailOptions = { baseUrl: 'https://app.test', outboxKey };

  async function emails(
    tenantId: TenantId,
  ): Promise<{ to: string; subject: string; text: string }[]> {
    const rows = await withTenant(db, tenantId, (tx) =>
      tx.execute<{ id: string; payload: Buffer }>(
        `SELECT id, payload FROM outbox_messages WHERE type = 'email' ORDER BY created_at, id`,
      ),
    );
    return rows.rows.map(
      (row) =>
        JSON.parse(
          openOutboxContent(outboxKey, OutboxMessageIdSchema.parse(row.id), row.payload).toString(
            'utf8',
          ),
        ) as { to: string; subject: string; text: string },
    );
  }

  it('queues one sealed email with every visit, and one for "this and following"', async () => {
    const b = await newBusiness();
    const notify = (tx: Parameters<typeof queueSeriesEmail>[0], notice: SeriesNotice) =>
      queueSeriesEmail(tx, notice, emailOptions).then(() => undefined);
    const input = seriesOf(b, [tue(10), tue(10, 1), tue(10, 2)], {
      idempotencyKey: 'series-mail-1',
    });
    const result = await createSeries(db, b.owner, input, { clock: b.clock, notify });
    // A retry queues nothing more.
    await createSeries(db, b.owner, input, { clock: b.clock, notify });
    const [confirmation] = await emails(b.tenantId);
    expect(await emails(b.tenantId)).toHaveLength(1);
    expect(confirmation?.to).toBe('maria@example.test');
    expect(confirmation?.subject).toBe("You're booked at Juniper Hair Studio: 3 visits");
    expect(confirmation?.text.match(/https:\/\/app\.test\/\S+/g)).toHaveLength(3);
    const second = result.bookings[1];
    if (second === undefined) throw new Error('three visits');
    await cancelFollowing(db, b.owner, second.id, {}, { clock: b.clock, notify });
    const all = await emails(b.tenantId);
    expect(all).toHaveLength(2);
    expect(all[1]?.subject).toBe('2 visits at Juniper Hair Studio are cancelled');
  });
});

describe('cancelFollowing (AC-X-186)', () => {
  it('cancels this visit and the later confirmed ones, and tells the client once', async () => {
    const b = await newBusiness();
    const result = await createSeries(
      db,
      b.owner,
      seriesOf(b, [tue(10), tue(10, 1), tue(10, 2), tue(10, 3)], { notifyClient: false }),
      { clock: b.clock },
    );
    const [first, second, third, fourth] = result.bookings;
    if (!first || !second || !third || !fourth) throw new Error('four visits');
    // The fourth was already cancelled on its own.
    await changeBooking(
      db,
      b.owner,
      fourth.id,
      { status: 'cancelled', notifyClient: false },
      { clock: b.clock },
    );
    const notices: SeriesNotice[] = [];
    const cancelled = await cancelFollowing(
      db,
      b.owner,
      second.id,
      { notifyClient: true },
      {
        clock: b.clock,
        notify: (_tx, notice) => {
          notices.push(notice);
          return Promise.resolve();
        },
      },
    );
    expect(cancelled.bookings.map((x) => [x.id, x.status])).toEqual([
      [second.id, 'cancelled'],
      [third.id, 'cancelled'],
    ]);
    expect((await getBooking(db, b.owner, first.id)).status).toBe('confirmed');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind).toBe('series_cancelled');
    expect(notices[0]?.visits.map((v) => v.startsAt)).toEqual([tue(10, 1), tue(10, 2)]);
    // Already cancelled: refused as for one booking.
    await expect(
      cancelFollowing(db, b.owner, second.id, {}, { clock: b.clock }),
    ).rejects.toBeInstanceOf(BookingNotChangeableError);
  });

  it('cancels a booking outside a series alone; staff can’t reach a colleague’s', async () => {
    const b = await newBusiness();
    const single = await bookOne(b, tue(10));
    const marcos = await bookOne(b, tue(12), b.marco.id);
    const result = await cancelFollowing(
      db,
      b.owner,
      single.id,
      { notifyClient: false },
      { clock: b.clock },
    );
    expect(result.bookings.map((x) => x.id)).toEqual([single.id]);
    await expect(
      cancelFollowing(db, b.staff, marcos.id, { notifyClient: false }, { clock: b.clock }),
    ).rejects.toBeInstanceOf(BookingNotFoundError);
  });

  it('moves one visit on its own (D-3)', async () => {
    const b = await newBusiness();
    const result = await createSeries(
      db,
      b.owner,
      seriesOf(b, [tue(10), tue(10, 1)], { notifyClient: false }),
      {
        clock: b.clock,
      },
    );
    const [first, second] = result.bookings;
    if (!first || !second) throw new Error('two visits');
    const moved = await changeBooking(
      db,
      b.owner,
      first.id,
      { startsAt: tue(13), notifyClient: false },
      { clock: b.clock },
    );
    expect(moved.seriesId).toBe(result.seriesId);
    expect((await getBooking(db, b.owner, second.id)).startsAt).toBe(tue(10, 1));
  });
});

describe('never a double booking (AC-X-183, property)', () => {
  it('a series racing single bookings books every requested date once or skips it', async () => {
    const b = await newBusiness();
    // Far enough ahead for every run's own weeks.
    await replaceBookingRules(db, b.owner, {
      rules: [{ type: 'maximum_advance', params: { days: 730 } }],
    });
    let week = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          count: fc.integer({ min: 2, max: 5 }),
          hour: fc.integer({ min: 9, max: 15 }),
          singles: fc.array(
            fc.record({
              visit: fc.integer({ min: 0, max: 4 }),
              minutes: fc.integer({ min: -60, max: 60 }),
            }),
            { maxLength: 6 },
          ),
        }),
        async ({ count, hour, singles }) => {
          // Each run its own weeks, so runs don't meet.
          const base = week;
          week += 6;
          const starts = Array.from({ length: count }, (_, visit) => tue(hour, base + visit));
          const results = await Promise.allSettled([
            createSeries(db, b.owner, seriesOf(b, starts, { notifyClient: false }), {
              clock: b.clock,
            }),
            ...singles.map((single) =>
              bookOne(
                b,
                new Date(
                  Date.parse(tue(hour, base + single.visit)) + single.minutes * 60_000,
                ).toISOString(),
              ),
            ),
          ]);
          const [series] = results;
          if (series.status === 'fulfilled') {
            const booked = series.value.bookings.map((x) => x.startsAt);
            const skipped = series.value.skipped.map((s) => s.startsAt);
            expect([...booked, ...skipped].sort()).toEqual([...starts].sort());
          } else {
            expect(series.reason).toBeInstanceOf(SlotUnavailableError);
          }
          for (const result of results.slice(1)) {
            if (result.status === 'rejected')
              expect(result.reason).toBeInstanceOf(SlotUnavailableError);
          }
          // No two active bookings of Jess overlap (the occupancy the engine and constraint use).
          const occupied = await withTenant(db, b.tenantId, (tx) =>
            listOccupancy(tx, {
              from: new Date(Date.parse(tue(0, base))),
              to: new Date(Date.parse(tue(23, base + 5))),
              staffMemberIds: [b.jess.id],
            }),
          );
          const sorted = [...occupied].sort(
            (x, y) => x.occupiedFrom.getTime() - y.occupiedFrom.getTime(),
          );
          sorted.slice(1).forEach((current, index) => {
            const before = sorted[index]?.occupiedTo.getTime() ?? 0;
            expect(current.occupiedFrom.getTime()).toBeGreaterThanOrEqual(before);
          });
        },
      ),
      { numRuns: 12, seed: 20261126 },
    );
  }, 120_000);
});

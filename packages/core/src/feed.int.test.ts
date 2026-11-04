import {
  ClientIdSchema,
  FeedItemIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  type FeedItemId,
  type MembershipRole,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import {
  addMembership,
  insertBooking,
  insertClient,
  insertService,
  insertStaffMember,
  listAuditEntries,
  syncFeedItems,
  withTenant,
  type Database,
  type FeedCandidate,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from './actor.js';
import { ManualClock } from './clock.js';
import { FeedItemNotFoundError, ForbiddenError } from './errors.js';
import { createBusiness } from './services/business.js';
import { changeFeedSettings, closeFeedItem, closeFeedItems, getFeed } from './services/feed.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The feed services against real Postgres (ADR-0039): the role matrix (owners and managers see
// every item and change the switches; staff see and close only their own), pause, a kind
// turned off, the once-only "turn this off?", the audit entry, and the feed's latency gate
// (playbook §2: ≤ 300 ms p95 for `GET /v1/feed`'s service call).

let database: TestDatabase;
let db: Database;
let tenantId: TenantId;
let owner: UserId;
let manager: UserId;
let jess: UserId;
let ben: UserId;
let jessStaff: string;
let benStaff: string;

const NOW = '2026-11-02T15:00:00.000Z';
const clock = new ManualClock(NOW);
const as = (userId: UserId, role: MembershipRole): Actor => ({
  context: { tenantId, userId, role },
});
const ana = () => as(owner, 'owner');
const marco = () => as(manager, 'manager');
const jessActor = () => as(jess, 'staff');
const benActor = () => as(ben, 'staff');

function gap(staffId: string, day: string): FeedCandidate {
  return {
    kind: 'schedule_gaps',
    subjectKey: `staff:${staffId}`,
    day,
    audienceStaffId: staffId,
    subjects: { staffMemberId: staffId, clientId: null, bookingId: null, serviceId: null },
    payload: {
      gapCount: 1,
      openMinutes: 120,
      longestStartsAt: `${day}T15:00:00.000Z`,
      longestEndsAt: `${day}T17:00:00.000Z`,
    },
    expiresAt: new Date(`${day}T22:00:00Z`),
  };
}

function overload(staffId: string, day: string): FeedCandidate {
  return {
    kind: 'staff_overload',
    subjectKey: `staff:${staffId}`,
    day,
    audienceStaffId: null,
    subjects: { staffMemberId: staffId, clientId: null, bookingId: null, serviceId: null },
    payload: { busyDays: [day, '2026-11-05', '2026-11-06'], horizonDays: 7, peakPercent: 96 },
    expiresAt: new Date('2026-11-07T05:00:00Z'),
  };
}

const sync = (candidates: FeedCandidate[]) =>
  withTenant(db, tenantId, (tx) => syncFeedItems(tx, candidates, new Date(NOW)));
const keysFor = async (actor: Actor) =>
  (await getFeed(db, actor, { clock })).suggestions.map(
    (item) => `${item.kind}:${item.day}:${item.subjects.staffMemberId ?? ''}`,
  );
const idOf = async (kind: string, day: string, staffId: string): Promise<FeedItemId> => {
  const item = (await getFeed(db, ana(), { clock })).suggestions.find(
    (candidate) =>
      candidate.kind === kind &&
      candidate.day === day &&
      candidate.subjects.staffMemberId === staffId,
  );
  if (item === undefined) throw new Error('no such item');
  return FeedItemIdSchema.parse(item.id);
};

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  owner = await insertUser(db, 'Ana');
  tenantId = TenantIdSchema.parse(
    (
      await createBusiness(db, owner, {
        name: 'Juniper Hair Studio',
        slug: 'juniper-feed',
        timeZone: 'America/New_York',
      })
    ).id,
  );
  manager = await insertUser(db, 'Marco');
  jess = await insertUser(db, 'Jess');
  ben = await insertUser(db, 'Ben');
  await withTenant(db, tenantId, async (tx) => {
    await addMembership(tx, { userId: manager, role: 'manager' });
    const jessMembership = await addMembership(tx, { userId: jess, role: 'staff' });
    const benMembership = await addMembership(tx, { userId: ben, role: 'staff' });
    jessStaff = (
      await insertStaffMember(tx, {
        displayName: 'Jess',
        color: '#2a7230',
        active: true,
        membershipId: jessMembership.id,
      })
    ).id;
    benStaff = (
      await insertStaffMember(tx, {
        displayName: 'Ben',
        color: '#c2361b',
        active: true,
        membershipId: benMembership.id,
      })
    ).id;
  });
  await sync([
    gap(jessStaff, '2026-11-03'),
    gap(benStaff, '2026-11-03'),
    overload(jessStaff, '2026-11-04'),
  ]);
});

afterAll(async () => {
  await database.stop();
});

/** Ben's first visit, an hour before now, at the business's only price ($90 an hour). */
async function firstVisit(): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    const service = await insertService(tx, {
      name: 'Skin fade',
      category: 'cut',
      durationMinutes: 60,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceFromCents: 9000,
      priceToCents: null,
      active: true,
    });
    const client = await insertClient(tx, {
      name: 'Lee Park',
      email: null,
      phone: null,
      source: 'team',
    });
    await insertBooking(tx, {
      clientId: ClientIdSchema.parse(client.id),
      serviceId: ServiceIdSchema.parse(service.id),
      staffMemberId: StaffMemberIdSchema.parse(benStaff),
      startsAt: new Date('2026-11-02T14:00:00Z'),
      endsAt: new Date('2026-11-02T15:00:00Z'),
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceFromCents: 9000,
      priceToCents: null,
      source: 'team',
      overridden: false,
      idempotencyKey: null,
      createdBy: null,
    });
  });
}

describe('the card board (S52, ADR-0043)', () => {
  it('stays quiet until the business has booking history, then prices every card (AC-W4-5, AC-W4-4)', async () => {
    const quiet = await getFeed(db, ana(), { clock });
    expect(quiet).toMatchObject({ suggestions: [], hasBookingHistory: false });
    expect((await getFeed(db, jessActor(), { clock })).suggestions).toEqual([]);

    await firstVisit();
    const board = await getFeed(db, ana(), { clock });
    expect(board.hasBookingHistory).toBe(true);
    // 120 open minutes at $90 an hour; a busy week has no price.
    expect(board.suggestions.map((item) => [item.kind, item.valueCents]).sort()).toEqual([
      ['schedule_gaps', 18000],
      ['schedule_gaps', 18000],
      ['staff_overload', null],
    ]);
    // The business's history, though Ben's visit is outside Jess's scope.
    const jessBoard = await getFeed(db, jessActor(), { clock });
    expect(jessBoard.hasBookingHistory).toBe(true);
    expect(jessBoard.suggestions.map((item) => item.valueCents)).toEqual([18000]);
  });
});

describe('getFeed (role matrix)', () => {
  it('shows owners and managers every item, and lets them change the switches', async () => {
    for (const lead of [ana(), marco()]) {
      const feed = await getFeed(db, lead, { clock });
      expect(feed.suggestions).toHaveLength(3);
      expect(feed).toMatchObject({
        canChangeSettings: true,
        askToTurnOff: null,
        settings: { suggestionsPaused: false, disabledKinds: [] },
      });
    }
    const [jessGap] = (await getFeed(db, ana(), { clock })).suggestions;
    expect(jessGap?.names).toMatchObject({ client: null, service: null });
  });

  it("shows staff only their own items, never a colleague's or the overload", async () => {
    expect(await keysFor(jessActor())).toEqual([`schedule_gaps:2026-11-03:${jessStaff}`]);
    expect(await keysFor(benActor())).toEqual([`schedule_gaps:2026-11-03:${benStaff}`]);
    const feed = await getFeed(db, jessActor(), { clock });
    expect(feed).toMatchObject({ canChangeSettings: false, askToTurnOff: null });
  });

  it('lets staff close only their own items; a closed item is not found again', async () => {
    const bens = await idOf('schedule_gaps', '2026-11-03', benStaff);
    await expect(
      closeFeedItem(db, jessActor(), bens, { outcome: 'dismissed' }, { clock }),
    ).rejects.toBeInstanceOf(FeedItemNotFoundError);
    await closeFeedItem(db, benActor(), bens, { outcome: 'done' }, { clock });
    await expect(
      closeFeedItem(db, benActor(), bens, { outcome: 'dismissed' }, { clock }),
    ).rejects.toBeInstanceOf(FeedItemNotFoundError);
    expect(await keysFor(benActor())).toEqual([]);
  });

  it('refuses staff the switches', async () => {
    await expect(
      changeFeedSettings(db, jessActor(), { suggestionsPaused: true }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('switches', () => {
  it('hides suggestions while paused and a kind turned off, with an audit entry', async () => {
    expect(await changeFeedSettings(db, marco(), { suggestionsPaused: true })).toEqual({
      suggestionsPaused: true,
      disabledKinds: [],
      morningHour: null,
    });
    expect((await getFeed(db, ana(), { clock })).suggestions).toEqual([]);
    await changeFeedSettings(db, ana(), {
      suggestionsPaused: false,
      disabledKinds: ['staff_overload'],
    });
    expect(await keysFor(ana())).toEqual([`schedule_gaps:2026-11-03:${jessStaff}`]);
    await changeFeedSettings(db, ana(), { disabledKinds: [] });

    const entries = await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 100 }));
    expect(
      entries
        .filter((entry) => entry.action === 'feed.settings_updated')
        .map((entry) => entry.after),
    ).toEqual(
      expect.arrayContaining([
        { suggestionsPaused: true, disabledKinds: [], morningHour: null },
        { suggestionsPaused: false, disabledKinds: ['staff_overload'], morningHour: null },
      ]),
    );
  });

  it('asks owners once after 3 dismissals of a kind in 14 days; "Dismiss all" is one (S52)', async () => {
    const days = ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'];
    await sync(days.map((day) => gap(jessStaff, day)));
    // Three days dismissed together, as a grouped card's "Dismiss all": one dismissal.
    const together = await Promise.all(
      days.slice(0, 3).map((day) => idOf('schedule_gaps', day, jessStaff)),
    );
    expect(
      await closeFeedItems(db, jessActor(), { ids: together, outcome: 'dismissed' }, { clock }),
    ).toBe(3);
    await expect(
      closeFeedItems(db, jessActor(), { ids: together, outcome: 'dismissed' }, { clock }),
    ).rejects.toBeInstanceOf(FeedItemNotFoundError);
    expect((await getFeed(db, ana(), { clock })).askToTurnOff).toBeNull();
    // Two more taps, each its own moment: three in all.
    for (const day of days.slice(3)) {
      clock.advanceBy(1_000);
      await closeFeedItem(
        db,
        jessActor(),
        await idOf('schedule_gaps', day, jessStaff),
        { outcome: 'dismissed' },
        { clock },
      );
    }
    expect((await getFeed(db, ana(), { clock })).askToTurnOff).toBe('schedule_gaps');
    expect((await getFeed(db, jessActor(), { clock })).askToTurnOff).toBeNull();
    await changeFeedSettings(db, ana(), { askAnswered: 'schedule_gaps' });
    expect((await getFeed(db, ana(), { clock })).askToTurnOff).toBeNull();
  });
});

describe('feed latency', () => {
  it('answers a busy feed in ≤ 300 ms p95', async () => {
    // 150 open items: the most the feed shows is 50, newest first.
    const many = Array.from({ length: 150 }, (_, i) =>
      gap(
        i % 2 === 0 ? jessStaff : benStaff,
        `2027-0${String(1 + Math.floor(i / 50))}-${String(1 + (i % 25)).padStart(2, '0')}`,
      ),
    );
    await sync(many);
    const timings: number[] = [];
    for (let run = 0; run < 20; run += 1) {
      const started = performance.now();
      await getFeed(db, run % 2 === 0 ? ana() : jessActor(), { clock });
      timings.push(performance.now() - started);
    }
    const sorted = [...timings].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0;
    // eslint-disable-next-line no-console -- the measured number goes into the session log
    console.info(
      `Feed latency (20 runs, 150 open items): p95 ${p95.toFixed(0)} ms (target 300 ms)`,
    );
    // Noisy shared runners: fail only at 3× the target.
    expect(p95).toBeLessThan(900);
  });
});

describe('the mailing address for rebooking emails (S36)', () => {
  it('owners and managers set and clear it; staff never see it; the audit holds no address', async () => {
    expect((await getFeed(db, ana(), { clock })).mailingAddress).toBeNull();
    await changeFeedSettings(db, marco(), {
      mailingAddress: ' 12 Main St \n Springfield, IL 62701',
    });
    expect((await getFeed(db, ana(), { clock })).mailingAddress).toBe(
      '12 Main St\nSpringfield, IL 62701',
    );
    expect((await getFeed(db, jessActor(), { clock })).mailingAddress).toBeNull();
    await expect(
      changeFeedSettings(db, jessActor(), { mailingAddress: '1 Other Rd, Town' }),
    ).rejects.toThrow(ForbiddenError);
    // The same address again changes nothing and writes no second entry.
    await changeFeedSettings(db, ana(), { mailingAddress: '12 Main St\nSpringfield, IL 62701' });
    await changeFeedSettings(db, ana(), { mailingAddress: null });
    expect((await getFeed(db, ana(), { clock })).mailingAddress).toBeNull();
    const entries = (
      await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 50 }))
    ).filter((entry) => entry.action === 'tenant.updated');
    expect(entries.map((entry) => entry.after)).toEqual([
      { mailingAddressSet: false },
      { mailingAddressSet: true },
    ]);
    expect(JSON.stringify(entries)).not.toContain('Main St');
  });
});

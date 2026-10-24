import {
  FeedItemIdSchema,
  TenantIdSchema,
  type FeedItemId,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { insertStaffMember } from './repositories/appointments.js';
import { insertClient } from './repositories/clients.js';
import {
  closeFeedItem,
  countDismissals,
  feedOutcomeCounts,
  listDueInsightRuns,
  listOpenFeedItems,
  markInsightRun,
  readFeedSettings,
  requestInsightRun,
  startInsightRun,
  syncFeedItems,
  writeFeedSettings,
  type FeedCandidate,
} from './repositories/feed.js';
import { addMembership } from './repositories/memberships.js';
import { createTenant } from './repositories/tenants.js';
import { withMember, withTenant, type TenantTx } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

// The operator feed against real Postgres (ADR-0039): dedupe by key, expiry when the reason
// goes, the 30-day snooze, staff scope at the RLS level, settings, and the insights pass's run
// bookkeeping. Isolation between businesses is in isolation.int.test.ts.

let database: TestDatabase;
let db: Database;
let tenant: TenantId;
let ana: UserId; // owner
let jess: UserId; // staff, linked to the staff member Jess
let ben: UserId; // staff, linked to the staff member Ben
let jessStaff: string;
let benStaff: string;
let maria: string;

const NOW = new Date('2026-11-02T15:00:00Z');
const DAY_MS = 86_400_000;
const later = (days: number) => new Date(NOW.getTime() + days * DAY_MS);

const as = <T>(userId: UserId, work: (tx: TenantTx) => Promise<T>) =>
  withMember(db, { tenantId: tenant, userId }, work);
const asWorker = <T>(work: (tx: TenantTx) => Promise<T>) => withTenant(db, tenant, work);

function gap(staffId: string, day: string, openMinutes = 120): FeedCandidate {
  return {
    kind: 'schedule_gaps',
    subjectKey: `staff:${staffId}`,
    day,
    audienceStaffId: staffId,
    subjects: { staffMemberId: staffId, clientId: null, bookingId: null, serviceId: null },
    payload: {
      gapCount: 1,
      openMinutes,
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
    payload: { busyDays: [day], horizonDays: 7, peakPercent: 95 },
    expiresAt: later(5),
  };
}

function rebooking(clientId: string, staffId: string): FeedCandidate {
  return {
    kind: 'rebooking_due',
    subjectKey: `client:${clientId}`,
    day: '2026-10-27',
    audienceStaffId: staffId,
    subjects: { staffMemberId: staffId, clientId, bookingId: null, serviceId: null },
    payload: {
      lastVisitAt: '2026-09-15T14:00:00.000Z',
      intervalDays: 42,
      basis: 'service',
      dueOn: '2026-10-27',
    },
    expiresAt: later(30),
  };
}

const open = async (userId?: UserId, at = NOW) =>
  (userId === undefined
    ? await asWorker((tx) => listOpenFeedItems(tx, at))
    : await as(userId, (tx) => listOpenFeedItems(tx, at))
  ).map((item) => item.dedupeKey);
const idOf = async (dedupeKey: string): Promise<FeedItemId> => {
  const items = await asWorker((tx) => listOpenFeedItems(tx, NOW, 200));
  const item = items.find((candidate) => candidate.dedupeKey === dedupeKey);
  if (item === undefined) throw new Error(`no open item ${dedupeKey}`);
  return FeedItemIdSchema.parse(item.id);
};
const sync = (candidates: FeedCandidate[], at = NOW) =>
  asWorker((tx) => syncFeedItems(tx, candidates, at));

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  tenant = TenantIdSchema.parse(
    (await createTenant(db, { name: 'Plum', slug: 'plum-feed', timeZone: 'America/New_York' })).id,
  );
  ana = await insertUser(db, 'Ana');
  jess = await insertUser(db, 'Jess');
  ben = await insertUser(db, 'Ben');
  await asWorker(async (tx) => {
    await addMembership(tx, { userId: ana, role: 'owner' });
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
    maria = (
      await insertClient(tx, { name: 'Maria Lopez', email: null, phone: null, source: 'team' })
    ).id;
  });
});

afterAll(async () => {
  await database.stop();
});

describe('syncFeedItems', () => {
  it('adds new items once: a re-run with the same candidates changes nothing', async () => {
    const candidates = [gap(jessStaff, '2026-11-03'), overload(benStaff, '2026-11-04')];
    expect(await sync(candidates)).toEqual({ created: 2, updated: 0, expired: 0, snoozed: 0 });
    expect(await sync(candidates)).toEqual({ created: 0, updated: 0, expired: 0, snoozed: 0 });
    expect(await open()).toEqual(
      expect.arrayContaining([
        `schedule_gaps:staff:${jessStaff}:2026-11-03`,
        `staff_overload:staff:${benStaff}:2026-11-04`,
      ]),
    );
  });

  it('updates an item whose numbers changed, and expires one whose reason is gone', async () => {
    const result = await sync([gap(jessStaff, '2026-11-03', 60)]);
    expect(result).toMatchObject({ created: 0, updated: 1, expired: 1 });
    const [item] = (await asWorker((tx) => listOpenFeedItems(tx, NOW))).filter(
      (candidate) => candidate.kind === 'schedule_gaps',
    );
    expect(item?.payload).toMatchObject({ openMinutes: 60 });
    expect(await open()).not.toContain(`staff_overload:staff:${benStaff}:2026-11-04`);
  });

  it('opens an expired item again when its reason comes back', async () => {
    const back = overload(benStaff, '2026-11-04');
    expect(await sync([gap(jessStaff, '2026-11-03', 60), back])).toMatchObject({
      created: 0,
      updated: 1,
    });
    expect(await open()).toContain(`staff_overload:staff:${benStaff}:2026-11-04`);
  });

  it('expires items whose time has passed, and hides them from the feed at once', async () => {
    const afterGap = new Date('2026-11-03T22:00:00Z');
    expect(await open(undefined, afterGap)).not.toContain(
      `schedule_gaps:staff:${jessStaff}:2026-11-03`,
    );
    const result = await sync(
      [gap(jessStaff, '2026-11-03', 60), overload(benStaff, '2026-11-04')],
      afterGap,
    );
    expect(result).toMatchObject({ expired: 1 });
  });

  it('rejects a payload that is not an object or too large (checks)', async () => {
    const bad = { ...gap(jessStaff, '2026-11-05'), payload: { text: 'x'.repeat(3000) } };
    await expect(sync([bad])).rejects.toSatisfy((error) => sqlState(error) === '23514');
  });
});

describe('dismiss and snooze', () => {
  it('snoozes the same kind and subject for 30 days, other days included', async () => {
    const first = rebooking(maria, jessStaff);
    await sync([first]);
    const id = await idOf(`rebooking_due:client:${maria}:2026-10-27`);
    const dismissed = await as(jess, (tx) => closeFeedItem(tx, id, 'dismissed', NOW));
    expect(dismissed).toMatchObject({ status: 'dismissed' });
    expect(dismissed?.snoozedUntil?.toISOString()).toBe(later(30).toISOString());

    // The same item again is not revived; the same subject on another day is snoozed.
    const nextDue = {
      ...first,
      day: '2026-12-08',
      payload: { ...first.payload, dueOn: '2026-12-08' },
    };
    expect(await sync([first, nextDue])).toMatchObject({ created: 0, updated: 0, snoozed: 2 });
    expect(await open()).not.toContain(`rebooking_due:client:${maria}:2026-12-08`);
    // After the snooze both may come back: the same key (the same due date) too.
    const again = { ...first, expiresAt: later(60) };
    expect(await sync([again, nextDue], later(31))).toMatchObject({
      created: 1,
      updated: 1,
      snoozed: 0,
    });
    expect(await open(undefined, later(31))).toContain(`rebooking_due:client:${maria}:2026-10-27`);
  });

  it('records done, and closes an item only once', async () => {
    await sync([gap(jessStaff, '2026-11-06')]);
    const id = await idOf(`schedule_gaps:staff:${jessStaff}:2026-11-06`);
    expect(await as(ana, (tx) => closeFeedItem(tx, id, 'done', NOW))).toMatchObject({
      status: 'done',
      snoozedUntil: null,
    });
    expect(await as(ana, (tx) => closeFeedItem(tx, id, 'dismissed', NOW))).toBeUndefined();
  });

  it('counts dismissals and outcomes per kind', async () => {
    expect(await asWorker((tx) => countDismissals(tx, 'rebooking_due', later(-1)))).toBe(1);
    expect(await asWorker((tx) => countDismissals(tx, 'rebooking_due', later(1)))).toBe(0);
    const counts = await asWorker((tx) => feedOutcomeCounts(tx, later(-1)));
    expect(counts).toEqual(
      expect.arrayContaining([
        { kind: 'rebooking_due', status: 'dismissed', count: 1 },
        { kind: 'schedule_gaps', status: 'done', count: 1 },
      ]),
    );
  });
});

describe('staff scope (RLS)', () => {
  it("shows staff only their own items, never another's or the owners' only", async () => {
    await sync([
      gap(jessStaff, '2026-11-07'),
      gap(benStaff, '2026-11-07'),
      overload(jessStaff, '2026-11-07'),
    ]);
    const jessSees = await open(jess);
    expect(jessSees).toContain(`schedule_gaps:staff:${jessStaff}:2026-11-07`);
    expect(jessSees).not.toContain(`schedule_gaps:staff:${benStaff}:2026-11-07`);
    expect(jessSees).not.toContain(`staff_overload:staff:${jessStaff}:2026-11-07`);
    expect(await open(ana)).toEqual(
      expect.arrayContaining([
        `schedule_gaps:staff:${jessStaff}:2026-11-07`,
        `schedule_gaps:staff:${benStaff}:2026-11-07`,
        `staff_overload:staff:${jessStaff}:2026-11-07`,
      ]),
    );
  });

  it('lets staff dismiss only their own items, and not add any', async () => {
    const bens = await idOf(`schedule_gaps:staff:${benStaff}:2026-11-07`);
    expect(await as(jess, (tx) => closeFeedItem(tx, bens, 'dismissed', NOW))).toBeUndefined();
    await expect(
      as(jess, (tx) => syncFeedItems(tx, [gap(jessStaff, '2026-11-08')], NOW)),
    ).rejects.toSatisfy((error) => sqlState(error) === '42501');
  });

  it('adds the names a member may see when reading', async () => {
    const [item] = (await as(jess, (tx) => listOpenFeedItems(tx, NOW))).filter(
      (candidate) => candidate.kind === 'schedule_gaps',
    );
    expect(item).toMatchObject({ staffName: 'Jess', clientName: null, serviceName: null });
  });
});

describe('feed settings', () => {
  it('starts with suggestions on and nothing turned off, and stores a change', async () => {
    expect(await asWorker(readFeedSettings)).toEqual({
      suggestionsPaused: false,
      disabledKinds: [],
      answeredKinds: [],
    });
    const changed = {
      suggestionsPaused: true,
      disabledKinds: ['schedule_gaps' as const],
      answeredKinds: ['schedule_gaps' as const],
    };
    await as(ana, (tx) => writeFeedSettings(tx, changed));
    expect(await asWorker(readFeedSettings)).toEqual(changed);
  });
});

describe('insight runs', () => {
  const EVERY_HOUR = 3_600_000;
  const due = async (at: Date) =>
    (await listDueInsightRuns(db, at, EVERY_HOUR, 1000)).map((run) => run.tenantId);

  it('lists a new business as due, then not after its run, then due when asked or stale', async () => {
    const other = TenantIdSchema.parse(
      (await createTenant(db, { name: 'Fig', slug: 'fig-feed', timeZone: 'Asia/Kolkata' })).id,
    );
    const run = (at: Date) =>
      withTenant(db, other, async (tx) => {
        const seen = await startInsightRun(tx);
        if (seen === undefined) throw new Error('locked');
        await markInsightRun(tx, at, seen);
        return seen;
      });
    expect(await due(NOW)).toContain(other);
    expect(await run(NOW)).toBe(0);
    expect(await due(NOW)).not.toContain(other);

    await withTenant(db, other, requestInsightRun);
    expect(await due(NOW)).toContain(other);
    expect(await run(NOW)).toBe(1);
    expect(await due(NOW)).not.toContain(other);

    expect(await due(new Date(NOW.getTime() + EVERY_HOUR))).toContain(other);
  });

  it('never loses a request made while a run is going', async () => {
    const other = TenantIdSchema.parse(
      (await createTenant(db, { name: 'Oak', slug: 'oak-feed', timeZone: 'America/Phoenix' })).id,
    );
    await withTenant(db, other, async (tx) => {
      const seen = await startInsightRun(tx);
      // A second worker skips the business while the lock is held.
      expect(await withTenant(db, other, startInsightRun)).toBeUndefined();
      // A booking change commits during the run, without waiting for it.
      await withTenant(db, other, requestInsightRun);
      await markInsightRun(tx, NOW, seen ?? 0);
    });
    expect(await due(NOW)).toContain(other);
  });

  it('lets a staff member ask for a run (a booking change in their request)', async () => {
    await expect(as(jess, requestInsightRun)).resolves.toBeUndefined();
  });
});

import { changeFeedSettings } from '@pepper/core';
import { syncFeedItems, withTenant, type Database, type FeedCandidate } from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toolMessageContent, type ToolOutcome } from './registry.js';
import {
  callTool,
  depsFor,
  newWorld,
  NOW,
  startTestDatabase,
  type TestDatabase,
  type World,
} from './test-support.js';

// `get_feed` against real Postgres (S36, ADR-0040, tools as in S24): what each role may read of
// the feed (staff their own items only, never the owners-only kinds), pause and the kind filter,
// another business's items never, and no contact in what the model gets.

let database: TestDatabase;
let db: Database;
let world: World;
let other: World;

const DAY = '2026-11-03';

function gap(w: World): FeedCandidate {
  return {
    kind: 'schedule_gaps',
    subjectKey: `staff:${w.jessStaff.id}`,
    day: DAY,
    audienceStaffId: w.jessStaff.id,
    subjects: { staffMemberId: w.jessStaff.id, clientId: null, bookingId: null, serviceId: null },
    payload: {
      gapCount: 1,
      openMinutes: 120,
      longestStartsAt: '2026-11-03T19:00:00.000Z',
      longestEndsAt: '2026-11-03T21:00:00.000Z',
    },
    expiresAt: new Date('2026-11-04T05:00:00Z'),
  };
}

function rebooking(w: World): FeedCandidate {
  return {
    kind: 'rebooking_due',
    subjectKey: `client:${w.maria.id}`,
    day: '2026-10-27',
    audienceStaffId: w.marcoStaff.id,
    subjects: {
      staffMemberId: w.marcoStaff.id,
      clientId: w.maria.id,
      bookingId: null,
      serviceId: w.haircut.id,
    },
    payload: {
      lastVisitAt: '2026-09-15T14:00:00.000Z',
      intervalDays: 42,
      basis: 'service',
      dueOn: '2026-10-27',
    },
    expiresAt: new Date('2026-12-01T00:00:00Z'),
  };
}

function overload(w: World): FeedCandidate {
  return {
    kind: 'staff_overload',
    subjectKey: `staff:${w.jessStaff.id}`,
    day: DAY,
    audienceStaffId: null,
    subjects: { staffMemberId: w.jessStaff.id, clientId: null, bookingId: null, serviceId: null },
    payload: { busyDays: [DAY, '2026-11-04', '2026-11-05'], horizonDays: 7, peakPercent: 95 },
    expiresAt: new Date('2026-11-06T05:00:00Z'),
  };
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  world = await newWorld(db);
  other = await newWorld(db);
  for (const w of [world, other]) {
    await withTenant(db, w.tenantId, (tx) =>
      syncFeedItems(tx, [gap(w), rebooking(w), overload(w)], new Date(NOW)),
    );
  }
});

afterAll(async () => {
  await database.stop();
});

function answered(outcome: ToolOutcome) {
  if (outcome.status !== 'answered') {
    throw new Error(`expected an answer, got ${JSON.stringify(toolMessageContent(outcome))}`);
  }
  return outcome;
}

const items = async (w: World, actor: World['owner'], kind: string | null = null) =>
  (
    answered(await callTool(depsFor(w, actor), 'get_feed', { kind })).data as {
      items: { kind: string; itemId: string; client: string | null }[];
    }
  ).items;

describe('get_feed', () => {
  it('gives owners every item, in local terms, names cut short and no contact', async () => {
    const outcome = answered(
      await callTool(depsFor(world, world.owner), 'get_feed', { kind: null }),
    );
    const found = (outcome.data as { items: Record<string, unknown>[] }).items;
    expect(found.map((item) => item['kind']).sort()).toEqual([
      'rebooking_due',
      'schedule_gaps',
      'staff_overload',
    ]);
    expect(found).toContainEqual(
      expect.objectContaining({
        kind: 'schedule_gaps',
        staff: 'Jess',
        details: { gapCount: 1, openMinutes: 120, longestFrom: '14:00', longestTo: '16:00' },
        waitingForOk: false,
      }),
    );
    expect(found).toContainEqual(
      expect.objectContaining({ kind: 'rebooking_due', client: 'Maria L.', service: 'Haircut' }),
    );
    expect(toolMessageContent(outcome)).not.toMatch(/@|\+1/);
    expect(outcome.card).toBeNull();
  });

  it('gives staff only the items addressed to them, never the owners-only kinds', async () => {
    expect((await items(world, world.jess)).map((item) => item.kind)).toEqual(['schedule_gaps']);
    expect((await items(world, world.priya)).map((item) => item.kind)).toEqual(['rebooking_due']);
  });

  it('filters by kind, and only to a known kind', async () => {
    expect((await items(world, world.owner, 'rebooking_due')).map((item) => item.kind)).toEqual([
      'rebooking_due',
    ]);
    const refused = await callTool(depsFor(world, world.owner), 'get_feed', {
      kind: 'all_clients',
    });
    expect(refused.status).toBe('refused');
  });

  it('never reads another business’s items', async () => {
    const mine = new Set((await items(world, world.owner)).map((item) => item.itemId));
    for (const item of await items(other, other.owner)) expect(mine.has(item.itemId)).toBe(false);
  });

  it('says suggestions are paused, and gives none', async () => {
    await changeFeedSettings(db, other.owner, { suggestionsPaused: true });
    const outcome = answered(
      await callTool(depsFor(other, other.owner), 'get_feed', { kind: null }),
    );
    // The waitlist is not a suggestion: it is listed while paused too (S37).
    expect(outcome.data).toEqual({ paused: true, items: [], waitlist: [] });
    expect(outcome.summary).toBe('Suggestions are paused for this business.');
  });
});

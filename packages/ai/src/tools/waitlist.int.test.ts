import { addToWaitlist, listWaitlist } from '@pepper/appointments';
import type { Database } from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { undoToolAction } from './registry.js';
import {
  callTool,
  depsFor,
  newWorld,
  startTestDatabase,
  TUESDAY,
  bookOnScreen,
  type TestDatabase,
  type World,
} from './test-support.js';

// The waitlist in the chat against real Postgres (S37, ADR-0041): `add_to_waitlist` (dial
// action `waitlist.change`, "do it and tell me" by default, Undo takes the entry off), its
// permissions (staff only for their own staff member), windows in the business's time, and
// who is waiting in `get_feed` and `find_client_bookings`, never another business's.

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

const windows = [{ date: TUESDAY, start: '13:00', end: '17:00' }];

function add(w: World, actor = w.owner, extra: Record<string, unknown> = {}) {
  return callTool(depsFor(w, actor), 'add_to_waitlist', {
    clientId: w.maria.id,
    serviceId: w.haircut.id,
    staffMemberId: w.jessStaff.id,
    windows,
    ...extra,
  });
}

describe('add_to_waitlist', () => {
  it('puts the client on the list at once (notify) and tells the member, with Undo', async () => {
    const w = await newWorld(db);
    const outcome = await add(w);
    if (outcome.status !== 'done') throw new Error(`expected done, got ${outcome.status}`);
    expect(outcome.summary).toContain(
      'Maria L. is on the waitlist for a haircut with Jess: Tue 2026-11-03 13:00–17:00.',
    );
    expect(outcome.execution).toMatchObject({
      action: 'waitlist.change',
      outcome: 'execute_and_notify',
    });
    const [entry] = await listWaitlist(db, w.owner, {}, { clock: w.clock });
    expect(entry).toMatchObject({
      clientId: w.maria.id,
      staffMemberId: w.jessStaff.id,
      status: 'waiting',
      // 17:00 in New York (UTC-5): windows are the business's local time.
      expiresAt: '2026-11-03T22:00:00.000Z',
    });

    const undone = await undoToolAction(depsFor(w, w.owner), outcome.execution.id, null);
    expect(undone.execution.status).toBe('undone');
    expect(await listWaitlist(db, w.owner, {}, { clock: w.clock })).toEqual([]);
  });

  it('staff add only their own clients, for their own staff member', async () => {
    const w = await newWorld(db);
    // Maria is not Jess's client yet: she can't reach her.
    expect(await add(w, w.jess)).toMatchObject({ status: 'refused', code: 'not_found' });
    await bookOnScreen(w, w.jessStaff, w.maria, '10:00');
    const own = await add(w, w.jess);
    expect(own.status, JSON.stringify(own)).toBe('done');
    const anyone = await add(w, w.jess, { staffMemberId: null });
    expect(anyone).toMatchObject({ status: 'refused', code: 'forbidden' });
    const colleague = await add(w, w.jess, { staffMemberId: w.marcoStaff.id });
    expect(colleague).toMatchObject({ status: 'refused', code: 'forbidden' });
  });

  it('times that have passed are refused as too late; another business is not found', async () => {
    const w = await newWorld(db);
    const past = await add(w, w.owner, {
      windows: [{ date: '2026-11-01', start: '09:00', end: '12:00' }],
    });
    expect(past).toMatchObject({ status: 'refused', code: 'too_late' });
    const other = await newWorld(db);
    const foreign = await add(w, w.owner, { clientId: other.maria.id });
    expect(foreign).toMatchObject({ status: 'refused', code: 'not_found' });
  });
});

describe('who is waiting, in the reads', () => {
  it('get_feed and find_client_bookings list the open entries, staff only their own', async () => {
    const w = await newWorld(db);
    await addToWaitlist(db, w.owner, {
      clientId: w.maria.id,
      serviceId: w.haircut.id,
      staffMemberId: w.jessStaff.id,
      windows,
    });
    await addToWaitlist(db, w.owner, {
      clientId: w.sara.id,
      serviceId: w.haircut.id,
      staffMemberId: w.marcoStaff.id,
      windows,
    });
    const feed = await callTool(depsFor(w, w.owner), 'get_feed', { kind: null });
    if (feed.status !== 'answered') throw new Error('expected an answer');
    expect(feed.summary).toContain('2 on the waitlist');
    expect(feed.data).toMatchObject({
      waitlist: [
        {
          client: 'Maria L.',
          service: 'Haircut',
          staff: 'Jess',
          windows: [{ date: TUESDAY, from: '13:00', to: '17:00' }],
          offered: false,
        },
        { client: 'Sara K.', staff: 'Marco' },
      ],
    });
    expect(JSON.stringify(feed.data)).not.toMatch(/example\.test|\+1212/);

    const jessFeed = await callTool(depsFor(w, w.jess), 'get_feed', { kind: null });
    if (jessFeed.status !== 'answered') throw new Error('expected an answer');
    expect(
      (jessFeed.data as { waitlist: { client: string }[] }).waitlist.map((e) => e.client),
    ).toEqual(['Maria L.']);

    const maria = await callTool(depsFor(w, w.owner), 'find_client_bookings', {
      clientId: w.maria.id,
    });
    if (maria.status !== 'answered') throw new Error('expected an answer');
    expect(maria.summary).toContain('on the waitlist (1)');
    expect((maria.data as { waitlist: unknown[] }).waitlist).toHaveLength(1);
  });
});

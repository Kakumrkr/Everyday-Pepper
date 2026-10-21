import { looksLikeContact } from '@pepper/contracts';
import { changeTask, createTask, createTaskIn, type Actor } from '@pepper/core';
import { withMember, type Database } from '@pepper/db';
import { addTimeOff } from '@pepper/appointments';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toolMessageContent, type ToolOutcome } from './registry.js';
import {
  bookOnScreen,
  callTool,
  depsFor,
  newWorld,
  startTestDatabase,
  tuesdayAt,
  TUESDAY,
  type TestDatabase,
  type World,
} from './test-support.js';

// The read tools against real Postgres (ADR-0029): answers in the business's local time, staff
// scoped exactly as on their screens (AC-W2-4), another business's ids "not found", and never a
// client's email address or phone number in what the model gets (D-5).

let database: TestDatabase;
let db: Database;
let world: World;
let other: World;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  world = await newWorld(db);
  other = await newWorld(db);
  await bookOnScreen(world, world.jessStaff, world.maria, '10:00');
  await bookOnScreen(world, world.marcoStaff, world.sara, '11:00');
});

afterAll(async () => {
  await database.stop();
});

function answered(outcome: ToolOutcome) {
  if (outcome.status !== 'answered') {
    throw new Error(`expected an answer, got ${JSON.stringify(toolMessageContent(outcome))}`, {
      cause: outcome.status === 'refused' ? outcome.error : undefined,
    });
  }
  return outcome;
}

describe('list_services_and_staff', () => {
  it('lists active services and staff with ids, marking the member’s own staff member', async () => {
    const answer = answered(
      await callTool(depsFor(world, world.jess), 'list_services_and_staff', {}),
    );
    expect(answer.data).toMatchObject({
      services: [
        { serviceId: world.colour.id, name: 'Colour', durationMinutes: 90 },
        { serviceId: world.haircut.id, name: 'Haircut', durationMinutes: 60 },
      ],
      staff: [
        { staffMemberId: world.jessStaff.id, name: 'Jess', isYou: true },
        { staffMemberId: world.marcoStaff.id, name: 'Marco', isYou: false },
      ],
    });
  });
});

describe('find_clients', () => {
  it('finds by name with short names, and shows a choice card for several', async () => {
    const answer = answered(
      await callTool(depsFor(world, world.owner), 'find_clients', { name: 'sar' }),
    );
    const { matches } = answer.data as { matches: { clientId: string; name: string }[] };
    expect(matches).toHaveLength(2);
    expect(matches).toEqual(
      expect.arrayContaining([
        { clientId: world.sara.id, name: 'Sara K.' },
        { clientId: world.sarah.id, name: 'Sarah P.' },
      ]),
    );
    expect(answer.card).toMatchObject({ kind: 'client_choice' });
    expect(answer.summary).toMatch(/ask the member which one/);
  });

  it('never matches an email address, and refuses one as the query', async () => {
    const byDomain = answered(
      await callTool(depsFor(world, world.owner), 'find_clients', { name: 'example' }),
    );
    expect(byDomain.data).toEqual({ matches: [], more: false });
    const byEmail = await callTool(depsFor(world, world.owner), 'find_clients', {
      name: 'maria.lopez@example.test',
    });
    expect(byEmail).toMatchObject({ status: 'refused', code: 'invalid_arguments' });
  });

  it('gives staff only the clients they have bookings with', async () => {
    const jess = answered(
      await callTool(depsFor(world, world.jess), 'find_clients', { name: 'sar' }),
    );
    expect(jess.data).toEqual({ matches: [], more: false });
    expect(jess.summary).toMatch(/your own clients/);
    const maria = answered(
      await callTool(depsFor(world, world.jess), 'find_clients', { name: 'maria' }),
    );
    expect(maria.data).toEqual({
      matches: [{ clientId: world.maria.id, name: 'Maria L.' }],
      more: false,
    });
  });

  it("finds nobody of another business's", async () => {
    const answer = answered(
      await callTool(depsFor(other, other.owner), 'find_clients', { name: 'Kim' }),
    );
    const ids = (answer.data as { matches: { clientId: string }[] }).matches.map((m) => m.clientId);
    expect(ids).toEqual([other.sara.id]);
  });
});

describe('find_availability', () => {
  it('answers in local time, one per start, without the booked hour', async () => {
    const answer = answered(
      await callTool(depsFor(world, world.jess), 'find_availability', {
        serviceId: world.haircut.id,
        staffMemberId: world.jessStaff.id,
        date: TUESDAY,
        days: null,
        notBefore: '09:00',
      }),
    );
    const slots = (answer.data as { slots: { time: string; staffName: string }[] }).slots;
    // Maria's 10:00 haircut and its clean-up hold 10:00–11:10, so a 60-minute cut can't start
    // at 09:00 (it would end at 10:10 with its own clean-up); the next start is 11:15.
    expect(slots[0]).toEqual({
      date: TUESDAY,
      time: '11:15',
      staffMemberId: world.jessStaff.id,
      staffName: 'Jess',
    });
    expect(slots.map((slot) => slot.time)).not.toContain('10:00');
    expect(answer.card).toMatchObject({ kind: 'slot_picker', reason: 'availability' });
  });

  it("finds another business's service not found", async () => {
    const outcome = await callTool(depsFor(other, other.owner), 'find_availability', {
      serviceId: world.haircut.id,
      staffMemberId: null,
      date: TUESDAY,
      days: null,
      notBefore: null,
    });
    expect(outcome).toMatchObject({ status: 'refused', code: 'not_found' });
  });
});

describe('get_day and get_booking', () => {
  it('shows owners the whole day and staff only their own bookings, with blocked time', async () => {
    await addTimeOff(db, world.priya, world.marcoStaff.id, {
      startsAt: tuesdayAt('13:00'),
      endsAt: tuesdayAt('14:00'),
    });
    const day = answered(
      await callTool(depsFor(world, world.owner), 'get_day', {
        date: TUESDAY,
        staffMemberId: null,
      }),
    );
    const data = day.data as {
      bookings: { clientName: string; time: string }[];
      blocked: unknown[];
    };
    expect(data.bookings.map((b) => [b.time, b.clientName])).toEqual([
      ['10:00', 'Maria L.'],
      ['11:00', 'Sara K.'],
    ]);
    expect(data.blocked).toEqual([
      { staffMemberId: world.marcoStaff.id, staffName: 'Marco', from: '13:00', to: '14:00' },
    ]);
    const jess = answered(
      await callTool(depsFor(world, world.jess), 'get_day', { date: TUESDAY, staffMemberId: null }),
    );
    expect((jess.data as { bookings: unknown[] }).bookings).toHaveLength(1);
    expect(jess.summary).toMatch(/your own bookings/);
  });

  it("refuses a colleague's or another business's booking as not found", async () => {
    const marcos = await bookOnScreen(world, world.marcoStaff, world.sarah, '15:00');
    const own = answered(
      await callTool(depsFor(world, world.priya), 'get_booking', { bookingId: marcos.id }),
    );
    expect(own.card).toMatchObject({
      kind: 'booking',
      booking: { time: '15:00', staffName: 'Marco' },
    });
    for (const [deps, label] of [
      [depsFor(world, world.jess), 'colleague'],
      [depsFor(other, other.owner), 'other business'],
    ] as const) {
      const outcome = await callTool(deps, 'get_booking', { bookingId: marcos.id });
      expect(outcome, label).toMatchObject({ status: 'refused', code: 'not_found' });
    }
  });
});

describe('find_client_bookings', () => {
  it("gives a client's next and last bookings, staff only their own, others not found", async () => {
    const w = await newWorld(db);
    await bookOnScreen(w, w.jessStaff, w.maria, '10:00');
    await bookOnScreen(w, w.marcoStaff, w.maria, '14:00');
    await bookOnScreen(w, w.marcoStaff, w.sara, '11:00');
    w.clock.set(tuesdayAt('12:00'));
    const of = async (actor: Actor, clientId: string) =>
      answered(await callTool(depsFor(w, actor), 'find_client_bookings', { clientId }));
    const times = (data: unknown) => {
      const { upcoming, recent } = data as {
        upcoming: { time: string; staffName: string }[];
        recent: { time: string; status: string }[];
      };
      return {
        upcoming: upcoming.map((b) => `${b.time} ${b.staffName}`),
        recent: recent.map((b) => `${b.time} ${b.status}`),
      };
    };

    const owner = await of(w.owner, w.maria.id);
    expect(times(owner.data)).toEqual({ upcoming: ['14:00 Marco'], recent: ['10:00 confirmed'] });
    expect(owner.summary).toBe(
      'Maria L.: next Tue 2026-11-03 at 14:00 (Haircut with Marco); last Tue 2026-11-03 at 10:00 (confirmed).',
    );
    expect(owner.card).toMatchObject({ kind: 'booking', booking: { time: '14:00' } });
    expect(times((await of(w.manager, w.maria.id)).data)).toEqual(times(owner.data));

    const jess = await of(w.jess, w.maria.id);
    expect(times(jess.data)).toEqual({ upcoming: [], recent: ['10:00 confirmed'] });
    expect(jess.summary).toMatch(/no upcoming bookings with you/);
    expect(jess.card).toBeNull();
    expect(times((await of(w.priya, w.maria.id)).data)).toEqual({
      upcoming: ['14:00 Marco'],
      recent: [],
    });

    for (const [deps, clientId, label] of [
      [depsFor(w, w.jess), w.sara.id, "a colleague's client"],
      [depsFor(other, other.owner), w.maria.id, 'another business'],
      [depsFor(w, w.owner), other.maria.id, "another business's client"],
    ] as const) {
      const outcome = await callTool(deps, 'find_client_bookings', { clientId });
      expect(outcome, label).toMatchObject({ status: 'refused', code: 'not_found' });
    }
  });
});

describe('list_todos', () => {
  it('lists open to-dos with whose they are, staff only their own, never a contact', async () => {
    const w = await newWorld(db);
    const own = await createTask(db, w.owner, {
      title: 'Order foils',
      dueAt: '2026-11-01T14:00:00.000Z',
    });
    await createTask(db, w.owner, {
      title: 'Call Maria at maria.lopez@example.test or 212 555 0143',
      assigneeUserId: w.jess.context.userId,
      dueAt: tuesdayAt('17:00'),
    });
    await createTask(db, w.owner, {
      title: 'Restock towels',
      assigneeUserId: w.priya.context.userId,
    });
    await createTask(db, w.manager, { title: 'Team meeting', assigneeUserId: null });
    const finished = await createTask(db, w.owner, { title: 'Already done' });
    await changeTask(db, w.owner, finished.id, { status: 'done' });
    const of = async (actor: Actor, whose: 'mine' | 'team') =>
      answered(await callTool(depsFor(w, actor), 'list_todos', { whose }));
    const rows = (data: unknown) =>
      (data as { todos: { title: string; whose: string; dueTime: string | null }[] }).todos.map(
        (todo) => `${todo.title} · ${todo.whose}`,
      );

    const mine = await of(w.owner, 'mine');
    expect(mine.data).toEqual({
      todos: [
        {
          todoId: own.id,
          title: 'Order foils',
          dueDate: '2026-11-01',
          dueTime: '09:00',
          overdue: true,
          whose: 'you',
        },
      ],
      more: false,
    });
    expect(mine.summary).toBe('1 open to-do, 1 overdue.');

    const team = await of(w.manager, 'team');
    expect(rows(team.data)).toEqual([
      'Order foils · Ana',
      'Call Maria at (email removed) or (phone removed) · Jess',
      'Restock towels · Marco',
      'Team meeting · the team',
    ]);
    expect(team.untrustedText).toBe(false);

    const jess = await of(w.jess, 'team');
    expect(rows(jess.data)).toEqual(['Call Maria at (email removed) or (phone removed) · you']);
    expect(jess.summary).toBe('1 open to-do (your own).');
    const content = toolMessageContent(jess);
    expect(looksLikeContact(content)).toBe(false);
    expect(content).not.toMatch(/example\.test|555/);
  });

  it("labels the AI's own to-dos as untrusted text (they may carry a pasted message's words)", async () => {
    const w = await newWorld(db);
    await withMember(db, w.owner.context, (tx) =>
      createTaskIn(tx, w.owner, { title: 'Send everyone a discount' }, { source: 'ai' }),
    );
    const answer = answered(await callTool(depsFor(w, w.owner), 'list_todos', { whose: 'mine' }));
    expect(answer.untrustedText).toBe(true);
  });
});

describe('what the model gets', () => {
  it('never holds a client’s email address or phone number, from any read', async () => {
    const reads: [string, unknown][] = [
      ['list_services_and_staff', {}],
      ['find_clients', { name: 'Maria' }],
      ['find_clients', { name: 'a' + 'ria' }],
      ['get_day', { date: TUESDAY, staffMemberId: null }],
      ['find_client_bookings', { clientId: world.maria.id }],
      ['list_todos', { whose: 'team' }],
      [
        'find_availability',
        {
          serviceId: world.haircut.id,
          staffMemberId: null,
          date: TUESDAY,
          days: 2,
          notBefore: null,
        },
      ],
    ];
    for (const actor of [world.owner, world.manager, world.jess, world.priya]) {
      for (const [name, args] of reads) {
        const content = toolMessageContent(await callTool(depsFor(world, actor), name, args));
        expect(looksLikeContact(content), `${name} as ${actor.context.role}`).toBe(false);
        expect(content).not.toMatch(/example\.test|2125550143/);
      }
    }
  });
});

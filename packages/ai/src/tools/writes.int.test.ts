import { changeBooking, getBooking, listBookings, listTimeOff } from '@pepper/appointments';
import {
  AI_EMAIL_GRACE_SECONDS,
  OutboxMessageIdSchema,
  type ActionExecution,
  type ActionProposal,
} from '@pepper/contracts';
import { changeAutonomy, listTasks, type Actor } from '@pepper/core';
import { findOutboxMessage, withTenant, type Database } from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveToolProposal,
  dispatchToolCall,
  findTool,
  undoToolAction,
  type ToolOutcome,
} from './registry.js';
import {
  bookOnScreen,
  callTool,
  depsFor,
  newWorld,
  NOW,
  startTestDatabase,
  turn,
  tuesdayAt,
  TUESDAY,
  type TestDatabase,
  type World,
} from './test-support.js';

// The write tools against real Postgres, through the trust layer (ADR-0028, ADR-0029):
// - preview = execution (D-1): what a proposal showed is exactly what approving it did;
// - every inverse restores the state, and takes back the unsent email;
// - the role matrix through the tools (AC-W2-4) and another business's ids "not found";
// - a taken time answers with the 3 nearest (AC-W2-1); a stale approval asks again;
// - the dial: ask, notify, untrusted context, the AI's emails held for the undo grace.

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

const defaults = { templateDefaults: {} };
const askFirst = (w: World) => changeAutonomy(db, w.owner, { askFirst: true }, defaults);
const justDoIt = (w: World) =>
  changeAutonomy(
    db,
    w.owner,
    {
      askFirst: false,
      levels: {
        'booking.create': 'auto',
        'booking.move': 'auto',
        'booking.cancel': 'auto',
        'time.block': 'auto',
        'task.create': 'auto',
        'message.confirmation': 'auto',
      },
    },
    defaults,
  );

function proposed(outcome: ToolOutcome): ActionProposal {
  if (outcome.status !== 'awaiting_approval') {
    throw new Error(`expected a proposal, got ${outcome.status}`, {
      cause: outcome.status === 'refused' ? outcome.error : undefined,
    });
  }
  return outcome.proposal;
}

function done(outcome: ToolOutcome): ActionExecution {
  if (outcome.status !== 'done') {
    throw new Error(`expected it done, got ${outcome.status}`, {
      cause: outcome.status === 'refused' ? outcome.error : undefined,
    });
  }
  return outcome.execution;
}

/** A write tool's call in a world, and the domain state it changes (without versions). */
interface Scenario {
  tool: string;
  setup(w: World): Promise<{ args: Record<string, unknown>; state: () => Promise<unknown> }>;
}

const tuesdayBookings = (w: World) => async () =>
  (await listBookings(db, w.owner, { from: tuesdayAt('00:00'), to: tuesdayAt('23:59') }))
    .filter((booking) => booking.status !== 'cancelled')
    .map(({ clientId, staffMemberId, startsAt, status }) => ({
      clientId,
      staffMemberId,
      startsAt,
      status,
    }));

const SCENARIOS: Scenario[] = [
  {
    tool: 'create_booking',
    setup: async (w) => {
      await Promise.resolve();
      return {
        args: {
          clientId: w.maria.id,
          serviceId: w.haircut.id,
          staffMemberId: w.jessStaff.id,
          date: TUESDAY,
          time: '14:00',
          emailClient: true,
        },
        state: tuesdayBookings(w),
      };
    },
  },
  {
    tool: 'move_booking',
    setup: async (w) => {
      await bookOnScreen(w, w.jessStaff, w.maria, '10:00');
      const [booking] = await listBookings(db, w.owner, {
        from: tuesdayAt('00:00'),
        to: tuesdayAt('23:59'),
      });
      return {
        args: {
          bookingId: booking?.id,
          date: TUESDAY,
          time: '15:00',
          staffMemberId: w.marcoStaff.id,
          emailClient: true,
        },
        state: tuesdayBookings(w),
      };
    },
  },
  {
    tool: 'cancel_booking',
    setup: async (w) => {
      const booking = await bookOnScreen(w, w.jessStaff, w.maria, '10:00');
      return { args: { bookingId: booking.id, emailClient: true }, state: tuesdayBookings(w) };
    },
  },
  {
    tool: 'block_time',
    setup: async (w) => {
      await Promise.resolve();
      return {
        args: { staffMemberId: w.jessStaff.id, date: TUESDAY, from: '12:00', to: '13:00' },
        state: async () =>
          (await listTimeOff(db, w.owner, w.jessStaff.id, {}, { clock: w.clock })).map(
            ({ startsAt, endsAt }) => ({ startsAt, endsAt }),
          ),
      };
    },
  },
  {
    tool: 'add_todo',
    setup: async (w) => {
      await Promise.resolve();
      return {
        args: {
          title: 'Call Maria about Friday',
          dueDate: TUESDAY,
          dueTime: '17:00',
          assigneeStaffMemberId: w.jessStaff.id,
        },
        state: async () =>
          (await listTasks(db, w.owner, { status: 'all' })).map(({ title, dueAt, status }) => ({
            title,
            dueAt,
            status,
          })),
      };
    },
  },
];

const outboxOf = (w: World, id: string) =>
  withTenant(db, w.tenantId, (tx) => findOutboxMessage(tx, OutboxMessageIdSchema.parse(id)));

describe.each(SCENARIOS.map((scenario) => [scenario.tool, scenario] as const))(
  '%s',
  (_tool, scenario) => {
    it('does exactly what its proposal showed (preview = execution)', async () => {
      const w = await newWorld(db);
      await askFirst(w);
      const { args, state } = await scenario.setup(w);
      const before = await state();
      const proposal = proposed(await callTool(depsFor(w, w.owner), scenario.tool, args));
      // Nothing changed while it waits, though the dry run made the change to see it.
      expect(await state()).toEqual(before);
      const shown = proposal.preview as {
        before: unknown;
        after: unknown;
        emails: unknown[];
      };

      const approval = await approveToolProposal(
        depsFor(w, w.owner),
        proposal.id,
        proposal.fingerprint,
      );
      if (approval.kind !== 'executed') throw new Error(`expected it to run: ${approval.kind}`);
      const { execution } = approval;
      expect(execution.before).toEqual(shown.before);
      expect(execution.after).toEqual(shown.after);
      expect(execution.outboxMessageIds).toHaveLength(shown.emails.length);
      expect(await state()).not.toEqual(before);
    });

    it('undoes back to the state before, taking back the unsent email', async () => {
      const w = await newWorld(db);
      await justDoIt(w);
      const { args, state } = await scenario.setup(w);
      const before = await state();
      const execution = done(await callTool(depsFor(w, w.owner), scenario.tool, args));
      expect(await state()).not.toEqual(before);

      const undone = await undoToolAction(depsFor(w, w.owner), execution.id, 'wrong');
      expect(undone.execution.status).toBe('undone');
      expect(await state()).toEqual(before);
      for (const id of execution.outboxMessageIds) {
        expect((await outboxOf(w, id))?.status).toBe('cancelled');
      }
    });

    it("refuses another business's ids as not found", async () => {
      const w = await newWorld(db);
      const other = await newWorld(db);
      await justDoIt(other);
      const { args } = await scenario.setup(w);
      const outcome = await callTool(depsFor(other, other.owner), scenario.tool, args);
      expect(outcome).toMatchObject({ status: 'refused', code: 'not_found' });
    });
  },
);

describe('the role matrix through the tools (AC-W2-4)', () => {
  /** Calls on Marco's records: Priya is Marco's login, Jess is a colleague. */
  async function marcosCalls(w: World) {
    const marcos = await bookOnScreen(w, w.marcoStaff, w.sara, '11:00');
    return {
      create_booking: {
        clientId: w.sara.id,
        serviceId: w.haircut.id,
        staffMemberId: w.marcoStaff.id,
        date: TUESDAY,
        time: '14:00',
        emailClient: false,
      },
      move_booking: {
        bookingId: marcos.id,
        date: TUESDAY,
        time: '15:00',
        staffMemberId: null,
        emailClient: false,
      },
      cancel_booking: { bookingId: marcos.id, emailClient: false },
      block_time: { staffMemberId: w.marcoStaff.id, date: TUESDAY, from: '16:00', to: '17:00' },
      add_todo: {
        title: 'Restock towels',
        dueDate: null,
        dueTime: null,
        assigneeStaffMemberId: w.marcoStaff.id,
      },
    };
  }

  const roles: [string, (w: World) => Actor, 'allowed' | 'refused'][] = [
    ['owner', (w) => w.owner, 'allowed'],
    ['manager', (w) => w.manager, 'allowed'],
    ["Marco's own login (staff)", (w) => w.priya, 'allowed'],
    ['a colleague (staff)', (w) => w.jess, 'refused'],
  ];

  it.each(roles)('%s', async (_label, actorOf, expected) => {
    const w = await newWorld(db);
    await askFirst(w);
    // Proposals only (ask first), so one call doesn't change the next one's record.
    for (const [tool, args] of Object.entries(await marcosCalls(w))) {
      const outcome = await callTool(depsFor(w, actorOf(w)), tool, args);
      if (expected === 'allowed') {
        expect(outcome.status, tool).toBe('awaiting_approval');
      } else {
        expect(outcome, tool).toMatchObject({ status: 'refused' });
        expect(['forbidden', 'not_found'], tool).toContain(
          outcome.status === 'refused' ? outcome.code : '',
        );
      }
    }
  });
});

describe('conflicts and stale approvals', () => {
  it('answers a taken time with the 3 nearest free times, in local time (AC-W2-1)', async () => {
    const w = await newWorld(db);
    await bookOnScreen(w, w.jessStaff, w.sara, '10:00');
    const outcome = await callTool(depsFor(w, w.owner), 'create_booking', {
      clientId: w.maria.id,
      serviceId: w.haircut.id,
      staffMemberId: w.jessStaff.id,
      date: TUESDAY,
      time: '10:00',
      emailClient: null,
    });
    if (outcome.status !== 'refused') throw new Error('expected a refusal');
    expect(outcome.code).toBe('slot_unavailable');
    expect(outcome.alternatives).toHaveLength(3);
    for (const slot of outcome.alternatives) {
      expect(slot).toMatchObject({ date: TUESDAY, staffName: 'Jess' });
      expect(slot.time).toMatch(/^\d{2}:\d{2}$/);
    }
    expect(outcome.card).toMatchObject({
      kind: 'slot_picker',
      reason: 'alternatives',
      serviceId: w.haircut.id,
    });
    expect(await tuesdayBookings(w)()).toHaveLength(1);
  });

  it('with no staff member named, books the first one free at that time', async () => {
    const w = await newWorld(db);
    await justDoIt(w);
    await bookOnScreen(w, w.jessStaff, w.sara, '10:00');
    const execution = done(
      await callTool(depsFor(w, w.owner), 'create_booking', {
        clientId: w.maria.id,
        serviceId: w.haircut.id,
        staffMemberId: null,
        date: TUESDAY,
        time: '10:00',
        emailClient: false,
      }),
    );
    expect(execution.after).toMatchObject({ staffName: 'Marco', time: '10:00' });
  });

  it('asks again when the booking changed after the proposal (stale)', async () => {
    const w = await newWorld(db);
    await askFirst(w);
    const booking = await bookOnScreen(w, w.jessStaff, w.maria, '10:00');
    const proposal = proposed(
      await callTool(depsFor(w, w.owner), 'move_booking', {
        bookingId: booking.id,
        date: TUESDAY,
        time: '15:00',
        staffMemberId: null,
        emailClient: false,
      }),
    );
    await changeBooking(db, w.owner, booking.id, { startsAt: tuesdayAt('13:00') }, w);
    const approval = await approveToolProposal(
      depsFor(w, w.owner),
      proposal.id,
      proposal.fingerprint,
    );
    expect(approval.kind).toBe('stale');
    expect((await getBooking(db, w.owner, booking.id)).startsAt).toBe(tuesdayAt('13:00'));
  });

  it('refuses at approval when the time was booked meanwhile, and supersedes it', async () => {
    const w = await newWorld(db);
    await askFirst(w);
    const proposal = proposed(
      await callTool(depsFor(w, w.owner), 'create_booking', {
        clientId: w.maria.id,
        serviceId: w.haircut.id,
        staffMemberId: w.jessStaff.id,
        date: TUESDAY,
        time: '14:00',
        emailClient: false,
      }),
    );
    await bookOnScreen(w, w.jessStaff, w.sara, '14:00');
    const approval = await approveToolProposal(
      depsFor(w, w.owner),
      proposal.id,
      proposal.fingerprint,
    );
    expect(approval.kind).toBe('refused');
    expect(await tuesdayBookings(w)()).toHaveLength(1);
  });

  it('expires a proposal made by an older version of the tool, and books nothing (S26)', async () => {
    const w = await newWorld(db);
    await askFirst(w);
    const proposal = proposed(
      await callTool(depsFor(w, w.owner), 'create_booking', {
        clientId: w.maria.id,
        serviceId: w.haircut.id,
        staffMemberId: w.jessStaff.id,
        date: TUESDAY,
        time: '14:00',
        emailClient: false,
      }),
    );
    const tool = findTool('create_booking');
    if (tool?.kind !== 'write') throw new Error('create_booking is a write tool');
    const version = tool.version;
    tool.version = version + 1;
    try {
      const approval = await approveToolProposal(
        depsFor(w, w.owner),
        proposal.id,
        proposal.fingerprint,
      );
      expect(approval).toEqual({ kind: 'expired' });
    } finally {
      tool.version = version;
    }
    expect(await tuesdayBookings(w)()).toHaveLength(0);
  });

  it('the receipt keeps the tool’s summary, and the card shows it', async () => {
    const w = await newWorld(db);
    await justDoIt(w);
    const outcome = await callTool(depsFor(w, w.owner), 'create_booking', {
      clientId: w.maria.id,
      serviceId: w.haircut.id,
      staffMemberId: w.jessStaff.id,
      date: TUESDAY,
      time: '11:00',
      emailClient: false,
    });
    const execution = done(outcome);
    expect(execution.summary).toMatch(/^New booking: Maria/);
    expect(outcome.card).toMatchObject({ kind: 'change', summary: execution.summary });
  });
});

describe('the dial and the emails', () => {
  it('asks before a booking and does a move, holding its email for the undo grace', async () => {
    const w = await newWorld(db);
    const create = await callTool(depsFor(w, w.owner), 'create_booking', {
      clientId: w.maria.id,
      serviceId: w.haircut.id,
      staffMemberId: w.jessStaff.id,
      date: TUESDAY,
      time: '14:00',
      emailClient: null,
    });
    expect(create.status).toBe('awaiting_approval');
    expect(create.card).toMatchObject({
      kind: 'change',
      state: 'proposed',
      emails: [{ template: 'confirmed', clientId: w.maria.id }],
    });

    const booking = await bookOnScreen(w, w.jessStaff, w.maria, '10:00');
    const move = done(
      await callTool(depsFor(w, w.owner), 'move_booking', {
        bookingId: booking.id,
        date: TUESDAY,
        time: '15:00',
        staffMemberId: null,
        emailClient: null,
      }),
    );
    expect(move.outcome).toBe('execute_and_notify');
    const [emailId] = move.outboxMessageIds;
    const email = await outboxOf(w, emailId ?? '');
    expect(email?.status).toBe('pending');
    expect(email?.availableAt.getTime()).toBe(Date.parse(NOW) + AI_EMAIL_GRACE_SECONDS * 1000);
  });

  it('asks before emailing a client after untrusted text, and sends none when told not to', async () => {
    const w = await newWorld(db);
    const booking = await bookOnScreen(w, w.jessStaff, w.maria, '10:00');
    const args = {
      bookingId: booking.id,
      date: TUESDAY,
      time: '15:00',
      staffMemberId: null,
      emailClient: null,
    };
    const untrusted = turn({ untrustedContext: true });
    const outcome = await callTool(depsFor(w, w.owner), 'move_booking', args, untrusted);
    expect(proposed(outcome).explanation.decision).toEqual({
      outcome: 'propose',
      reason: 'untrusted_context',
    });
    const quiet = done(
      await callTool(
        depsFor(w, w.owner),
        'move_booking',
        { ...args, emailClient: false },
        untrusted,
      ),
    );
    expect(quiet.outboxMessageIds).toEqual([]);
  });

  it('a retried tool call acts once', async () => {
    const w = await newWorld(db);
    await justDoIt(w);
    const call = {
      id: 'call_retry',
      name: 'add_todo',
      arguments: JSON.stringify({
        title: 'Order foils',
        dueDate: null,
        dueTime: null,
        assigneeStaffMemberId: null,
      }),
    };
    const sameTurn = turn();
    const first = done(await dispatchToolCall(depsFor(w, w.owner), sameTurn, call));
    const again = done(await dispatchToolCall(depsFor(w, w.owner), sameTurn, call));
    expect(again.id).toBe(first.id);
    expect(await listTasks(db, w.owner, { status: 'all' })).toHaveLength(1);
  });

  it('a call id the model reuses in a later step is a new call, not a retry', async () => {
    const w = await newWorld(db);
    await justDoIt(w);
    const todo = (title: string) => ({
      id: 'call_1',
      name: 'add_todo',
      arguments: JSON.stringify({
        title,
        dueDate: null,
        dueTime: null,
        assigneeStaffMemberId: null,
      }),
    });
    const first = turn();
    const one = done(await dispatchToolCall(depsFor(w, w.owner), first, todo('Order foils')));
    const two = done(
      await dispatchToolCall(depsFor(w, w.owner), { ...first, step: 2 }, todo('Call the bank')),
    );
    expect(two.id).not.toBe(one.id);
    const titles = (await listTasks(db, w.owner, { status: 'all' })).map((task) => task.title);
    expect(titles.sort()).toEqual(['Call the bank', 'Order foils']);
  });
});

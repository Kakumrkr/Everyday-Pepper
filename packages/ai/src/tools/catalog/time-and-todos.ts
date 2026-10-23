import {
  addTimeOffIn,
  getTimeOffIn,
  listBookingsIn,
  removeTimeOffIn,
  StaffMemberNotFoundError,
} from '@pepper/appointments';
import {
  looksLikeContact,
  redactContacts,
  StaffMemberIdSchema,
  TaskIdSchema,
  TASK_TITLE_MAX,
  TimeOffIdSchema,
  UtcDateTimeSchema,
  type StaffMemberId,
  type UserId,
} from '@pepper/contracts';
import {
  completeTaskIn,
  createTaskIn,
  listTasksIn,
  memberFirstNamesIn,
  permissionScope,
  reopenTaskIn,
  UndoRefusedError,
  withdrawTaskIn,
} from '@pepper/core';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { InvalidToolArgumentsError } from '../errors.js';
import { daysOf, instantOf, localOf } from '../local-time.js';
import type { Performed, ReadTool, ToolScope, WriteScope, WriteTool } from '../tool.js';
import {
  DateArg,
  day,
  directoryOf,
  IdArg,
  ownStaffMember,
  staffLogin,
  staffName,
  TimeArg,
  when,
} from './shared.js';

// Blocking time and to-dos (ADR-0029, ADR-0032): the member's own calendar and follow-through
// (D-3), through the time-off and task services. None of them emails anyone.

const BlockArgs = z.strictObject({
  staffMemberId: IdArg('staff member').nullable().describe('null: the member themselves'),
  date: DateArg,
  from: TimeArg.nullable().describe('Start; null with `to` null: the whole day'),
  to: TimeArg.nullable().describe('End; null with `from` null: the whole day'),
});
type BlockArgs = z.output<typeof BlockArgs>;

export const blockTime: WriteTool = {
  kind: 'write',
  name: 'block_time',
  version: 1,
  localTimes: true,
  tier: 'internal_write',
  guide: {
    use: "Block time in a staff member's calendar (a break, an errand, a day off) so nobody can book it.",
    avoid: [
      'to cancel or move the bookings already in that time (it leaves them; say so)',
      'for more than one day at a time',
    ],
    returns:
      'the blocked time, done or waiting for the member’s OK, and how many bookings stay inside it.',
    examples: [
      {
        say: 'Block my lunch tomorrow 12 to 1',
        args: { staffMemberId: null, from: '12:00', to: '13:00' },
      },
      {
        say: 'Marco is off on Friday',
        args: { staffMemberId: { $any: true }, from: null, to: null },
      },
    ],
  },
  args: BlockArgs,
  actions: () => ['time.block'],
  async perform(scope: WriteScope, args: BlockArgs): Promise<Performed> {
    if ((args.from === null) !== (args.to === null)) {
      throw new InvalidToolArgumentsError(
        'Give both `from` and `to`, or neither for the whole day.',
      );
    }
    const directory = await directoryOf(scope);
    const staffId =
      args.staffMemberId === null
        ? ownStaffMember(scope, directory)?.id
        : StaffMemberIdSchema.parse(args.staffMemberId);
    if (staffId === undefined) {
      throw new InvalidToolArgumentsError(
        'This member has no calendar of their own: say whose time to block (staffMemberId).',
      );
    }
    const wholeDay = daysOf(scope.timeZone, args.date);
    const startsAt =
      args.from === null ? wholeDay.from : instantOf(scope.timeZone, args.date, args.from);
    const endsAt = args.to === null ? wholeDay.to : instantOf(scope.timeZone, args.date, args.to);
    const entry = await addTimeOffIn(scope.tx, scope.actor, staffId, {
      startsAt: UtcDateTimeSchema.parse(startsAt),
      endsAt: UtcDateTimeSchema.parse(endsAt),
    });
    const inside = (
      await listBookingsIn(scope.tx, scope.actor, {
        from: entry.startsAt,
        to: entry.endsAt,
        staffMemberId: staffId,
        status: 'confirmed',
      })
    ).length;
    const name = staffName(directory, staffId);
    const span =
      args.from === null || args.to === null
        ? `all of ${day(args.date)}`
        : `${when(args.date, args.from)}–${localOf(scope.timeZone, endsAt).time}`;
    return {
      entity: { type: 'time_off', id: entry.id },
      targetKey: `time_off:${staffId}:${startsAt}`,
      recordOwner: staffLogin(directory, staffId),
      appointmentStartsAt: null,
      before: null,
      after: {
        staffMemberId: staffId,
        staffName: name,
        date: args.date,
        from: args.from ?? '00:00',
        to: args.to ?? '24:00',
        bookingsInside: inside,
      },
      touched: null,
      inverse: { staffMemberId: staffId, timeOffId: entry.id },
      summary: `Block ${name}'s time, ${span}.${inside > 0 ? ` ${String(inside)} booking${inside === 1 ? '' : 's'} stay inside it: move or cancel them separately.` : ''}`,
      facts: [{ kind: 'bookings_inside', ref: null, value: { count: inside } }],
    };
  },
  async undo(scope, inverse) {
    const { staffMemberId, timeOffId } = z
      .strictObject({ staffMemberId: StaffMemberIdSchema, timeOffId: TimeOffIdSchema })
      .parse(inverse);
    await removeTimeOffIn(scope.tx, scope.actor, staffMemberId, timeOffId);
  },
};

const UnblockArgs = z.strictObject({
  timeOffId: z.uuid().describe("The blocked time's id, from get_day"),
});
type UnblockArgs = z.output<typeof UnblockArgs>;

export const unblockTime: WriteTool = {
  kind: 'write',
  name: 'unblock_time',
  version: 1,
  localTimes: false,
  tier: 'internal_write',
  guide: {
    use: "Remove blocked time from a staff member's calendar (a break, an errand, a day off) so it can be booked again, by its id from get_day.",
    avoid: [
      'to cancel or move a booking (use the booking tools; this never touches bookings)',
      'to take back a block Pepper just made (the member taps Undo on its card)',
    ],
    returns:
      'the removed block with its whole span (a block over several days goes entirely: block the part that stays again), done or waiting for the member’s OK.',
    examples: [
      { say: "Remove Jess's lunch block tomorrow", args: { timeOffId: { $any: true } } },
      {
        say: 'Jess is working through lunch tomorrow after all, free that time',
        args: { timeOffId: { $any: true } },
      },
    ],
  },
  args: UnblockArgs,
  actions: () => ['time.block'],
  async perform(scope: WriteScope, args: UnblockArgs): Promise<Performed> {
    const entry = await getTimeOffIn(scope.tx, scope.actor, TimeOffIdSchema.parse(args.timeOffId));
    const directory = await directoryOf(scope);
    // Staff remove only their own (`forbidden` for a colleague's, which they can see).
    await removeTimeOffIn(scope.tx, scope.actor, entry.staffMemberId, entry.id);
    // Bookings already inside it stay inside it again on Undo; only one made since stops it.
    const inside = await bookingIdsIn(scope, entry.staffMemberId, entry.startsAt, entry.endsAt);
    const name = staffName(directory, entry.staffMemberId);
    const start = localOf(scope.timeZone, entry.startsAt);
    const end = localOf(scope.timeZone, entry.endsAt);
    const span =
      start.date === end.date
        ? `${when(start.date, start.time)}–${end.time}`
        : `${when(start.date, start.time)} to ${when(end.date, end.time)}`;
    return {
      entity: { type: 'time_off', id: entry.id },
      targetKey: `time_off:${entry.id}`,
      recordOwner: staffLogin(directory, entry.staffMemberId),
      appointmentStartsAt: null,
      before: {
        staffMemberId: entry.staffMemberId,
        staffName: name,
        fromDate: start.date,
        from: start.time,
        toDate: end.date,
        to: end.time,
      },
      after: { staffMemberId: entry.staffMemberId, staffName: name, blocked: false },
      touched: { timeOffId: entry.id, startsAt: entry.startsAt, endsAt: entry.endsAt },
      inverse: {
        staffMemberId: entry.staffMemberId,
        startsAt: entry.startsAt,
        endsAt: entry.endsAt,
        bookingsInside: inside,
      },
      summary: `Unblock ${name}'s time, ${span}, so it can be booked again.`,
      facts: [{ kind: 'bookings_untouched', ref: null, value: null }],
    };
  },
  async undo(scope, inverse) {
    const { staffMemberId, startsAt, endsAt, bookingsInside } = z
      .strictObject({
        staffMemberId: StaffMemberIdSchema,
        startsAt: UtcDateTimeSchema,
        endsAt: UtcDateTimeSchema,
        // Receipts from before S27 have no list: any booking inside then stops the Undo.
        bookingsInside: z.array(z.uuid()).default([]),
      })
      .parse(inverse);
    // A client booked into the freed time since: blocking it again would hide their booking
    // behind a break (S27 security review). The member sees "booked since"; nothing changes.
    const now = await bookingIdsIn(scope, staffMemberId, startsAt, endsAt);
    if (now.some((id) => !bookingsInside.includes(id))) throw new UndoRefusedError('slot_taken');
    await addTimeOffIn(scope.tx, scope.actor, staffMemberId, { startsAt, endsAt });
  },
};

/** The confirmed bookings of a staff member that overlap a span, by id. */
async function bookingIdsIn(
  scope: ToolScope,
  staffMemberId: StaffMemberId,
  from: string,
  to: string,
): Promise<string[]> {
  const bookings = await listBookingsIn(scope.tx, scope.actor, {
    from: UtcDateTimeSchema.parse(from),
    to: UtcDateTimeSchema.parse(to),
    staffMemberId,
    status: 'confirmed',
  });
  return bookings.map((booking) => booking.id);
}

const TodoArgs = z.strictObject({
  title: z
    .string()
    .trim()
    .min(1)
    .max(TASK_TITLE_MAX)
    .refine((title) => !looksLikeContact(title), 'Leave contact details out; name the client')
    .describe("What to do, in the member's words (no email addresses or phone numbers)"),
  dueDate: DateArg.nullable().describe('When it is due; null: no due date'),
  dueTime: TimeArg.nullable().describe('Time on the due date; null: 09:00'),
  assigneeStaffMemberId: IdArg('staff member')
    .nullable()
    .describe(
      'Whose to-do: a staff member id from list_services_and_staff (one with a login); null: the member themselves',
    ),
});
type TodoArgs = z.output<typeof TodoArgs>;

export const addTodo: WriteTool = {
  kind: 'write',
  name: 'add_todo',
  version: 1,
  localTimes: true,
  tier: 'internal_write',
  guide: {
    use: 'Add a to-do for the member or a teammate, with an optional due time that reminds them (follow-through). For a teammate, take their staff member id from list_services_and_staff first.',
    avoid: [
      'to book, move or cancel anything (use the booking tools)',
      'to message a client (Pepper can’t write to clients yet)',
    ],
    returns: 'the to-do, done or waiting for the member’s OK.',
    examples: [
      {
        say: 'Remind me to call Maria on Friday',
        args: { title: { $regex: 'maria' }, dueDate: { $any: true }, assigneeStaffMemberId: null },
      },
      {
        say: 'Ask Jess to restock the towels by Thursday at 5pm',
        args: { dueTime: '17:00', assigneeStaffMemberId: { $any: true } },
      },
    ],
  },
  args: TodoArgs,
  actions: () => ['task.create'],
  async perform(scope: WriteScope, args: TodoArgs): Promise<Performed> {
    const directory = await directoryOf(scope);
    // "Remind me": the member whose request it is, also when a lead approves it (S26).
    let assignee: UserId = scope.requester;
    // The same words whoever runs the preview, so a lead's approval matches what was shown.
    let assigneeName = ownStaffMember(scope, directory)?.displayName ?? 'you';
    if (args.assigneeStaffMemberId !== null) {
      const staffId = StaffMemberIdSchema.parse(args.assigneeStaffMemberId);
      if (!directory.staff.has(staffId)) throw new StaffMemberNotFoundError();
      const login = staffLogin(directory, staffId);
      if (login === null) {
        throw new InvalidToolArgumentsError(
          `${staffName(directory, staffId)} has no login, so they can't get to-dos.`,
        );
      }
      assignee = login;
      assigneeName = staffName(directory, staffId);
    }
    const dueAt =
      args.dueDate === null
        ? null
        : UtcDateTimeSchema.parse(instantOf(scope.timeZone, args.dueDate, args.dueTime ?? '09:00'));
    const task = await createTaskIn(
      scope.tx,
      scope.actor,
      { title: args.title, dueAt, assigneeUserId: assignee },
      { source: 'ai' },
    );
    const due = dueAt === null ? null : localOf(scope.timeZone, dueAt);
    const digest = createHash('sha256')
      .update(JSON.stringify([args.title, assignee, dueAt]))
      .digest('hex')
      .slice(0, 32);
    return {
      entity: { type: 'task', id: task.id },
      targetKey: `todo:${digest}`,
      recordOwner: assignee,
      appointmentStartsAt: null,
      before: null,
      after: {
        title: args.title,
        assigneeName,
        dueDate: due?.date ?? null,
        dueTime: due?.time ?? null,
      },
      touched: null,
      inverse: { taskId: task.id },
      summary: `To-do for ${assigneeName}: "${args.title}"${due === null ? '' : `, due ${when(due.date, due.time)}`}.`,
      facts:
        due === null
          ? []
          : [{ kind: 'reminds', ref: null, value: { date: due.date, time: due.time } }],
    };
  },
  async undo(scope, inverse) {
    const { taskId } = z.strictObject({ taskId: TaskIdSchema }).parse(inverse);
    await withdrawTaskIn(scope.tx, scope.actor, taskId);
  },
};

const TODOS_SHOWN = 20;

/** Whose to-do it is, in words: "you", a staff member's name, a member's first name, "the team". */
async function assigneeNamesOf(
  scope: ToolScope,
  assignees: readonly (string | null)[],
): Promise<(assignee: string | null) => string> {
  const directory = await directoryOf(scope);
  const staffNames = new Map<string, string>(
    [...directory.staff.values()].flatMap((member) =>
      member.userId === null ? [] : [[member.userId, member.displayName] as const],
    ),
  );
  const firstNames = await memberFirstNamesIn(scope.tx, scope.actor, assignees);
  return (assignee) => {
    if (assignee === null) return 'the team';
    if (assignee === scope.requester) return 'you';
    const name = staffNames.get(assignee) ?? firstNames.get(assignee) ?? '';
    return name === '' ? 'a teammate' : name;
  };
}

export const listTodos: ReadTool = {
  kind: 'read',
  name: 'list_todos',
  version: 1,
  localTimes: false,
  guide: {
    use: 'List open to-dos with their ids: the member’s own, or everyone’s they may see. Use it for "what’s on my list?" and to find the to-do to mark done.',
    avoid: [
      'to add a to-do (use add_todo)',
      'for appointments (use get_day or find_client_bookings)',
    ],
    returns:
      'up to 20 open to-dos, due first: id, title, local due date and time, whether it is overdue, and whose it is. Staff see only their own.',
    examples: [
      { say: 'What are my to-dos?', args: { whose: 'mine' } },
      { say: "What's still open for the team?", args: { whose: 'team' } },
    ],
  },
  args: z.strictObject({
    whose: z
      .enum(['mine', 'team'])
      .describe("mine: the member's own to-dos; team: everyone's the member may see"),
  }),
  async run(scope, args: { whose: 'mine' | 'team' }) {
    const found = await listTasksIn(scope.tx, scope.actor, {
      status: 'open',
      mine: args.whose === 'mine',
      limit: TODOS_SHOWN + 1,
    });
    const tasks = found.slice(0, TODOS_SHOWN);
    const whose = await assigneeNamesOf(
      scope,
      tasks.map((task) => task.assigneeUserId),
    );
    const todos = tasks.map((task) => {
      const due = task.dueAt === null ? null : localOf(scope.timeZone, task.dueAt);
      return {
        todoId: task.id,
        // Typed on the to-do screen, which allows contact details: never to the model.
        title: redactContacts(task.title),
        dueDate: due?.date ?? null,
        dueTime: due?.time ?? null,
        overdue: task.dueAt !== null && Date.parse(task.dueAt) < scope.now.getTime(),
        whose: whose(task.assigneeUserId),
      };
    });
    const more = found.length > TODOS_SHOWN;
    const overdue = todos.filter((todo) => todo.overdue).length;
    const scopeNote =
      args.whose === 'team' && permissionScope(scope.actor.context.role, 'tasks.read') !== 'all'
        ? ' (your own)'
        : '';
    return {
      summary:
        todos.length === 0
          ? `No open to-dos${scopeNote}.`
          : `${String(todos.length)}${more ? '+' : ''} open to-do${todos.length === 1 ? '' : 's'}${scopeNote}${overdue > 0 ? `, ${String(overdue)} overdue` : ''}.`,
      data: { todos, more },
      card: null,
      // The AI's own to-dos may carry words from an earlier turn's untrusted text (a pasted
      // message): they come back labelled, never as instructions.
      untrustedText: tasks.some((task) => task.source !== 'manual'),
    };
  },
};

/** "your to-do", "Jess's to-do", "the team's to-do". */
const possessive = (whose: string) =>
  whose === 'you' ? 'your' : whose === 'the team' ? "the team's" : `${whose}'s`;

const CompleteArgs = z.strictObject({ todoId: IdArg('to-do') });
type CompleteArgs = z.output<typeof CompleteArgs>;

export const completeTodo: WriteTool = {
  kind: 'write',
  name: 'complete_todo',
  version: 1,
  localTimes: false,
  tier: 'internal_write',
  guide: {
    use: 'Mark one open to-do done, by its id from list_todos.',
    avoid: [
      'to take back a to-do Pepper just added (the member taps Undo on its card)',
      'for several to-dos at once (one call each, after the member named them)',
    ],
    returns: 'the to-do marked done, done or waiting for the member’s OK.',
    examples: [
      { say: 'Mark the Maria call done', args: { todoId: { $any: true } } },
      {
        say: 'I called Maria about her colour, you can tick that off',
        args: { todoId: { $any: true } },
      },
    ],
  },
  args: CompleteArgs,
  actions: () => ['task.create'],
  async perform(scope: WriteScope, args: CompleteArgs): Promise<Performed> {
    const id = TaskIdSchema.parse(args.todoId);
    const { before, after } = await completeTaskIn(scope.tx, scope.actor, id, {
      now: scope.now,
    });
    const whose = (await assigneeNamesOf(scope, [before.assigneeUserId]))(before.assigneeUserId);
    // Typed on the to-do screen, which allows contact details: never in a card or to the model.
    const title = redactContacts(before.title).slice(0, TASK_TITLE_MAX);
    const due = before.dueAt === null ? null : localOf(scope.timeZone, before.dueAt);
    const side = {
      title,
      whose,
      dueDate: due?.date ?? null,
      dueTime: due?.time ?? null,
    };
    return {
      entity: { type: 'task', id },
      targetKey: `todo:${id}`,
      recordOwner: before.assigneeUserId,
      appointmentStartsAt: null,
      before: { ...side, status: 'open' },
      after: { ...side, status: 'done' },
      touched: { todoId: id, updatedAt: before.updatedAt },
      inverse: { taskId: id, completedVersion: after.updatedAt },
      summary: `Mark ${possessive(whose)} to-do "${title}" done.`,
      facts: [{ kind: 'todo_was_open', ref: null, value: null }],
      // The AI's own to-dos may carry a pasted message's words, as in list_todos.
      untrustedText: before.source !== 'manual',
    };
  },
  async undo(scope, inverse) {
    const { taskId, completedVersion } = z
      .strictObject({ taskId: TaskIdSchema, completedVersion: UtcDateTimeSchema })
      .parse(inverse);
    await reopenTaskIn(scope.tx, scope.actor, taskId, { completedVersion });
  },
};

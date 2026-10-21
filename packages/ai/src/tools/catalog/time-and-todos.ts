import {
  addTimeOffIn,
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
  type UserId,
} from '@pepper/contracts';
import {
  createTaskIn,
  listTasksIn,
  memberFirstNamesIn,
  permissionScope,
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
    };
  },
  async undo(scope, inverse) {
    const { staffMemberId, timeOffId } = z
      .strictObject({ staffMemberId: StaffMemberIdSchema, timeOffId: TimeOffIdSchema })
      .parse(inverse);
    await removeTimeOffIn(scope.tx, scope.actor, staffMemberId, timeOffId);
  },
};

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
    .describe('Whose to-do (a staff member with a login); null: the member themselves'),
});
type TodoArgs = z.output<typeof TodoArgs>;

export const addTodo: WriteTool = {
  kind: 'write',
  name: 'add_todo',
  version: 1,
  localTimes: true,
  tier: 'internal_write',
  guide: {
    use: 'Add a to-do for the member or a teammate, with an optional due time that reminds them (follow-through).',
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

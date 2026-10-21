import {
  TaskChangeSchema,
  TaskIdSchema,
  TaskInputSchema,
  TaskQuerySchema,
  TaskSchema,
  TaskSourceSchema,
  TaskStatusSchema,
  UserIdSchema,
  UtcDateTimeSchema,
  type Task,
  type TaskChange,
  type TaskId,
  type TaskInput,
  type TaskQuery,
  type TaskSource,
  type UserId,
} from '@pepper/contracts';
import {
  appendAuditEntry,
  deleteTask,
  findMembership,
  insertTask,
  listDueTasks,
  listTasks as listTaskRows,
  lockTask,
  updateTask,
  withMember,
  withTenant,
  type Database,
  type DueTask,
  type TaskRow,
  type TaskUpdate,
  type TenantTx,
} from '@pepper/db';
import { auditActorOf, requirePermission, type Actor } from '../actor.js';
import { systemClock, type Clock } from '../clock.js';
import {
  TaskAssigneeNotMemberError,
  TaskNotFoundError,
  TaskNotOpenError,
  UndoRefusedError,
} from '../errors.js';
import { taskDuePush } from '../task-pushes.js';
import { leadUserIds, queuePushToMembers } from './push.js';

// To-dos of the business's owners and staff (ADR-0026). `tasks.read` and `tasks.manage` reach
// every task for owners and managers; staff reach the tasks assigned to them or that they
// created (the database's member scope applies the same), and give tasks only to themselves.
// A task's title is free text, so the audit entries record only its status, due time,
// assignee and source.

/** Tasks the member may see: open ones by default (see `TaskQuerySchema`). */
export async function listTasks(
  db: Database,
  actor: Actor,
  query: TaskQuery = {},
): Promise<Task[]> {
  requirePermission(actor, 'tasks.read');
  const parsed = TaskQuerySchema.parse(query);
  return withMember(db, actor.context, (tx) => listTasksIn(tx, actor, parsed));
}

/** `listTasks` inside the caller's transaction (the AI's `list_todos`, S26b). */
export async function listTasksIn(
  tx: TenantTx,
  actor: Actor,
  query: TaskQuery = {},
): Promise<Task[]> {
  requirePermission(actor, 'tasks.read');
  const { status, mine, limit } = TaskQuerySchema.parse(query);
  const rows = await listTaskRows(tx, {
    status,
    limit,
    ...(mine && { assigneeUserId: actor.context.userId }),
  });
  return rows.map(toTask);
}

/**
 * Adds a task. Without an assignee it is the caller's own; `null` leaves it unassigned (owners
 * and managers only); staff may assign only themselves.
 */
export async function createTask(db: Database, actor: Actor, input: TaskInput): Promise<Task> {
  requirePermission(actor, 'tasks.manage');
  const fields = TaskInputSchema.parse(input);
  return withMember(db, actor.context, (tx) => createTaskIn(tx, actor, fields));
}

/** `createTask` inside the caller's transaction; the AI's tools record `source: 'ai'`. */
export async function createTaskIn(
  tx: TenantTx,
  actor: Actor,
  input: TaskInput,
  options: { source?: TaskSource } = {},
): Promise<Task> {
  requirePermission(actor, 'tasks.manage');
  const fields = TaskInputSchema.parse(input);
  const assignee =
    fields.assigneeUserId === undefined ? actor.context.userId : fields.assigneeUserId;
  await checkAssignee(tx, actor, assignee);
  const row = await insertTask(tx, {
    title: fields.title,
    dueAt: fields.dueAt === null ? null : new Date(fields.dueAt),
    assigneeUserId: assignee,
    source: options.source ?? 'manual',
    createdBy: actor.context.userId,
  });
  await appendAuditEntry(tx, {
    actor: auditActorOf(actor),
    change: {
      action: 'task.created',
      entity: { type: 'task', id: row.id },
      before: null,
      after: auditValues(row),
    },
    requestId: actor.requestId,
  });
  return toTask(row);
}

/**
 * Takes back a to-do the AI added (its Undo, ADR-0028), in the caller's transaction: only while
 * it is open and nobody changed it since (`UndoRefusedError` otherwise, as the work would be
 * lost). `TaskNotFoundError` for one the member can't reach.
 */
export async function withdrawTaskIn(tx: TenantTx, actor: Actor, taskId: TaskId): Promise<void> {
  requirePermission(actor, 'tasks.manage');
  const id = TaskIdSchema.parse(taskId);
  const row = await lockTask(tx, id);
  if (row === undefined) throw new TaskNotFoundError();
  requirePermission(actor, 'tasks.manage', { ownerUserId: userIdOf(row.assigneeUserId) });
  if (row.status !== 'open' || row.updatedAt.getTime() !== row.createdAt.getTime()) {
    throw new UndoRefusedError('changed_since');
  }
  // The row is locked; it can't have gone meanwhile.
  if (!(await deleteTask(tx, id))) throw new TaskNotFoundError();
  await appendAuditEntry(tx, {
    actor: auditActorOf(actor),
    change: {
      action: 'task.deleted',
      entity: { type: 'task', id: row.id },
      before: auditValues(row),
      after: null,
    },
    requestId: actor.requestId,
  });
}

function userIdOf(value: string | null): UserId | null {
  return value === null ? null : UserIdSchema.parse(value);
}

/**
 * Changes a task the member may reach: its title, due time (a new one notifies again when it
 * comes due), assignee, or status (done records when; open again clears it).
 */
export async function changeTask(
  db: Database,
  actor: Actor,
  taskId: TaskId,
  change: TaskChange,
  options: { clock?: Clock } = {},
): Promise<Task> {
  requirePermission(actor, 'tasks.manage');
  const id = TaskIdSchema.parse(taskId);
  const fields = TaskChangeSchema.parse(change);
  const now = (options.clock ?? systemClock).now();
  return withMember(db, actor.context, (tx) => changeTaskIn(tx, actor, id, fields, { now }));
}

/** `changeTask` inside the caller's transaction. */
export async function changeTaskIn(
  tx: TenantTx,
  actor: Actor,
  taskId: TaskId,
  change: TaskChange,
  options: { now: Date },
): Promise<Task> {
  requirePermission(actor, 'tasks.manage');
  const id = TaskIdSchema.parse(taskId);
  const fields = TaskChangeSchema.parse(change);
  const row = await lockTask(tx, id);
  if (row === undefined) throw new TaskNotFoundError();
  const update: TaskUpdate = {};
  if (fields.title !== undefined && fields.title !== row.title) update.title = fields.title;
  if (fields.dueAt !== undefined && !sameInstant(fields.dueAt, row.dueAt)) {
    update.dueAt = fields.dueAt === null ? null : new Date(fields.dueAt);
    update.dueNotifiedAt = null;
  }
  if (fields.assigneeUserId !== undefined && fields.assigneeUserId !== row.assigneeUserId) {
    await checkAssignee(tx, actor, fields.assigneeUserId);
    update.assigneeUserId = fields.assigneeUserId;
  }
  if (fields.status !== undefined && fields.status !== row.status) {
    update.status = fields.status;
    update.completedAt = fields.status === 'done' ? options.now : null;
  }
  if (Object.keys(update).length === 0) return toTask(row);

  const updated = await updateTask(tx, id, update);
  // The row is locked and the member could see it; a change that hides it from them (a
  // staff member handing their task to someone else) is refused by the database instead.
  if (updated === undefined) throw new TaskNotFoundError();
  await appendAuditEntry(tx, {
    actor: auditActorOf(actor),
    change: {
      action: 'task.updated',
      entity: { type: 'task', id: row.id },
      before: auditValues(row),
      after: auditValues(updated),
    },
    requestId: actor.requestId,
  });
  return toTask(updated);
}

/**
 * Marks an open to-do done (the AI's `complete_todo`, S26b), in the caller's transaction, as
 * the screen's "done" does: `TaskNotFoundError` for one the member can't see, `TaskNotOpenError`
 * for one already done. Returns it before and after.
 */
export async function completeTaskIn(
  tx: TenantTx,
  actor: Actor,
  taskId: TaskId,
  options: { now: Date },
): Promise<{ before: Task; after: Task }> {
  requirePermission(actor, 'tasks.manage');
  const id = TaskIdSchema.parse(taskId);
  const row = await lockTask(tx, id);
  if (row === undefined) throw new TaskNotFoundError();
  if (row.status !== 'open') throw new TaskNotOpenError();
  const after = await changeTaskIn(tx, actor, id, { status: 'done' }, options);
  return { before: toTask(row), after };
}

/**
 * Opens a to-do the AI completed again (its Undo), only while it is still done and nobody
 * changed it since: `completedVersion` is its `updatedAt` right after it was completed.
 * `UndoRefusedError` otherwise, so nobody's later edit is lost.
 */
export async function reopenTaskIn(
  tx: TenantTx,
  actor: Actor,
  taskId: TaskId,
  options: { completedVersion: string },
): Promise<void> {
  requirePermission(actor, 'tasks.manage');
  const id = TaskIdSchema.parse(taskId);
  const row = await lockTask(tx, id);
  if (row === undefined) throw new TaskNotFoundError();
  const version = UtcDateTimeSchema.parse(options.completedVersion);
  if (row.status !== 'done' || row.updatedAt.getTime() !== Date.parse(version)) {
    throw new UndoRefusedError('changed_since');
  }
  await changeTaskIn(tx, actor, id, { status: 'open' }, { now: row.updatedAt });
}

/** Staff assign only themselves; anyone else must be a member; `null` needs the full scope. */
async function checkAssignee(tx: TenantTx, actor: Actor, assignee: UserId | null): Promise<void> {
  requirePermission(actor, 'tasks.manage', { ownerUserId: assignee });
  if (assignee !== null && (await findMembership(tx, assignee)) === undefined) {
    throw new TaskAssigneeNotMemberError();
  }
}

function sameInstant(value: string | null, current: Date | null): boolean {
  if (value === null || current === null) return value === current;
  return new Date(value).getTime() === current.getTime();
}

function auditValues(row: TaskRow) {
  return {
    status: TaskStatusSchema.parse(row.status),
    dueAt: row.dueAt === null ? null : UtcDateTimeSchema.parse(row.dueAt.toISOString()),
    assigneeUserId: row.assigneeUserId === null ? null : UserIdSchema.parse(row.assigneeUserId),
    source: TaskSourceSchema.parse(row.source),
  };
}

export function toTask(row: TaskRow): Task {
  return TaskSchema.parse({
    id: row.id,
    title: row.title,
    dueAt: row.dueAt?.toISOString() ?? null,
    assigneeUserId: row.assigneeUserId,
    status: row.status,
    source: row.source,
    createdByUserId: row.createdByUserId,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Due tasks handled per pass of the due-task job. */
const DUE_BATCH = 100;

/**
 * The due-task job (ADR-0026): for each open task whose due time has come and whose assignee
 * was not yet told, queues a push to the assignee's devices (an unassigned task: the owners'
 * and managers'), and records that, in one transaction per task. Passes run until nothing is
 * due, so a backlog after downtime goes out at once. Returns how many tasks were handled.
 */
export async function sendDueTaskPushes(
  db: Database,
  options: { key: Buffer; clock?: Clock },
): Promise<number> {
  const clock = options.clock ?? systemClock;
  let handled = 0;
  for (;;) {
    const due = await listDueTasks(db, clock.now(), DUE_BATCH);
    for (const task of due) {
      if (await sendDueTaskPush(db, task, { key: options.key, now: clock.now() })) handled += 1;
    }
    if (due.length < DUE_BATCH) return handled;
  }
}

/**
 * Handles one due task under its business: locked and checked again (it may have been done,
 * moved or handled meanwhile). Returns whether it was due and is now marked notified.
 */
export async function sendDueTaskPush(
  db: Database,
  due: DueTask,
  options: { key: Buffer; now: Date },
): Promise<boolean> {
  return withTenant(db, due.tenantId, async (tx) => {
    const row = await lockTask(tx, due.taskId);
    if (
      row?.status !== 'open' ||
      row.dueAt === null ||
      row.dueNotifiedAt !== null ||
      row.dueAt.getTime() > options.now.getTime()
    ) {
      return false;
    }
    const recipients =
      row.assigneeUserId === null
        ? await leadUserIds(tx)
        : [UserIdSchema.parse(row.assigneeUserId)];
    await queuePushToMembers(tx, recipients, taskDuePush(row.title, row.id), {
      key: options.key,
      dedupeKey: `task.due:${row.id}:${String(row.dueAt.getTime())}`,
      now: options.now,
    });
    await updateTask(tx, due.taskId, { dueNotifiedAt: options.now });
    return true;
  });
}

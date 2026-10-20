import {
  TaskIdSchema,
  TaskSourceSchema,
  TaskStatusSchema,
  TaskTitleSchema,
  TenantIdSchema,
  type TaskId,
  type TaskSource,
  type TaskStatus,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import { and, asc, desc, eq, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import { tasks, type TaskRow } from '../schema.js';
import { withJobScan, type TenantTx } from '../tenant.js';

// To-dos of the transaction's tenant (ADR-0026). Run inside `withMember` for a member's
// request: the `member_scope` policy then limits staff to the tasks assigned to them or that
// they created. The due-task job lists due tasks across businesses (`job_scan`, ids only) and
// takes each one under its business's tenant.

const Id = z.uuid();

export interface NewTask {
  title: string;
  dueAt: Date | null;
  assigneeUserId: UserId | null;
  source: TaskSource;
  /** `null` for the platform's own tasks. */
  createdBy: UserId | null;
}

export async function insertTask(tx: TenantTx, input: NewTask): Promise<TaskRow> {
  const [row] = await tx
    .insert(tasks)
    .values({
      title: TaskTitleSchema.parse(input.title),
      dueAt: input.dueAt,
      assigneeUserId: input.assigneeUserId === null ? null : Id.parse(input.assigneeUserId),
      source: TaskSourceSchema.parse(input.source),
      createdByUserId: input.createdBy === null ? null : Id.parse(input.createdBy),
    })
    .returning();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- INSERT ... RETURNING of one row returns one row
  return row!;
}

/** The task with this id, locked until the transaction ends (`FOR UPDATE`). */
export async function lockTask(tx: TenantTx, id: TaskId): Promise<TaskRow | undefined> {
  const [row] = await tx
    .select()
    .from(tasks)
    .where(eq(tasks.id, TaskIdSchema.parse(id)))
    .for('update');
  return row;
}

/** A change to a task; `undefined` fields stay as they are. */
export interface TaskUpdate {
  title?: string;
  dueAt?: Date | null;
  assigneeUserId?: UserId | null;
  status?: TaskStatus;
  completedAt?: Date | null;
  dueNotifiedAt?: Date | null;
}

export async function updateTask(
  tx: TenantTx,
  id: TaskId,
  update: TaskUpdate,
): Promise<TaskRow | undefined> {
  const [row] = await tx
    .update(tasks)
    .set({
      ...(update.title !== undefined && { title: TaskTitleSchema.parse(update.title) }),
      ...(update.dueAt !== undefined && { dueAt: update.dueAt }),
      ...(update.assigneeUserId !== undefined && {
        assigneeUserId: update.assigneeUserId === null ? null : Id.parse(update.assigneeUserId),
      }),
      ...(update.status !== undefined && { status: TaskStatusSchema.parse(update.status) }),
      ...(update.completedAt !== undefined && { completedAt: update.completedAt }),
      ...(update.dueNotifiedAt !== undefined && { dueNotifiedAt: update.dueNotifiedAt }),
    })
    .where(eq(tasks.id, TaskIdSchema.parse(id)))
    .returning();
  return row;
}

/**
 * At most `limit` tasks: open ones by due time (those without one last, then oldest first),
 * done ones most recently done first, or both (open first). With `assigneeUserId`, only the
 * tasks assigned to that user.
 */
export async function listTasks(
  tx: TenantTx,
  options: { status: TaskStatus | 'all'; assigneeUserId?: UserId; limit: number },
): Promise<TaskRow[]> {
  const conditions: (SQL | undefined)[] = [];
  if (options.status !== 'all') conditions.push(eq(tasks.status, options.status));
  if (options.assigneeUserId !== undefined) {
    conditions.push(eq(tasks.assigneeUserId, Id.parse(options.assigneeUserId)));
  }
  return tx
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(
      // Open before done; open by due time, done by when they were done.
      sql`${tasks.status} = 'done'`,
      sql`CASE WHEN ${tasks.status} = 'open' THEN ${tasks.dueAt} END ASC NULLS LAST`,
      desc(tasks.completedAt),
      asc(tasks.createdAt),
      asc(tasks.id),
    )
    .limit(z.number().int().min(1).max(200).parse(options.limit));
}

/** A due task and its business, as the due-task job's scan lists it. */
export interface DueTask {
  taskId: TaskId;
  tenantId: TenantId;
}

/**
 * Up to `limit` open tasks due at `now` whose assignee was not yet notified, across
 * businesses, the earliest due first: ids only, read in the due-task job's scan.
 */
export async function listDueTasks(db: Database, now: Date, limit: number): Promise<DueTask[]> {
  const max = z.number().int().min(1).max(1000).parse(limit);
  const rows = await withJobScan(db, 'tasks', (tx) =>
    tx
      .select({ id: tasks.id, tenantId: tasks.tenantId })
      .from(tasks)
      .where(
        and(
          eq(tasks.status, 'open'),
          isNotNull(tasks.dueAt),
          isNull(tasks.dueNotifiedAt),
          lte(tasks.dueAt, now),
        ),
      )
      .orderBy(asc(tasks.dueAt))
      .limit(max),
  );
  return rows.map((row) => ({
    taskId: TaskIdSchema.parse(row.id),
    tenantId: TenantIdSchema.parse(row.tenantId),
  }));
}

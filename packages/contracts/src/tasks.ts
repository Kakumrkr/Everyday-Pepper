import { z } from 'zod';
import { UserIdSchema } from './tenancy.js';
import { UtcDateTimeSchema } from './time.js';

// To-dos for the business's owners and staff (W4 "owner to-dos as tasks with due dates",
// ADR-0026): a title, an optional due time and an optional assignee among the business's
// members. Owners and managers see and assign every task; staff see the tasks assigned to them
// or that they created, and give new ones only to themselves. A task coming due notifies its
// assignee by push. Tasks the AI creates (Phase 6) use the same table with source `ai`.

/** A task id: a lowercased UUID. */
export const TaskIdSchema = z.uuid().toLowerCase().brand<'TaskId'>();
export type TaskId = z.infer<typeof TaskIdSchema>;

export const TaskStatusSchema = z.enum(['open', 'done']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** Who made the task: a member in the app, the AI employee (Phase 6), or the platform. */
export const TaskSourceSchema = z.enum(['manual', 'ai', 'system']);
export type TaskSource = z.infer<typeof TaskSourceSchema>;

export const TASK_TITLE_MAX = 200;

export const TaskTitleSchema = z.string().trim().min(1).max(TASK_TITLE_MAX);

/**
 * `POST /v1/tasks`. Without `assigneeUserId`, staff's tasks are their own and an owner's or
 * manager's task is unassigned (`null` also means unassigned).
 */
export const TaskInputSchema = z
  .object({
    title: TaskTitleSchema,
    dueAt: UtcDateTimeSchema.nullable().default(null),
    assigneeUserId: UserIdSchema.nullable().optional(),
  })
  .strict();
export type TaskInput = z.input<typeof TaskInputSchema>;

/** `PATCH /v1/tasks/:id`: any of the fields; `status` marks it done or opens it again. */
export const TaskChangeSchema = z
  .object({
    title: TaskTitleSchema.optional(),
    dueAt: UtcDateTimeSchema.nullable().optional(),
    assigneeUserId: UserIdSchema.nullable().optional(),
    status: TaskStatusSchema.optional(),
  })
  .strict()
  .refine((change) => Object.values(change).some((value) => value !== undefined), {
    message: 'Change at least one field',
  });
export type TaskChange = z.input<typeof TaskChangeSchema>;

/** A task as the api returns it. The creator is `null` for the platform's or a deleted account. */
export const TaskSchema = z.object({
  id: TaskIdSchema,
  title: z.string(),
  dueAt: UtcDateTimeSchema.nullable(),
  assigneeUserId: UserIdSchema.nullable(),
  status: TaskStatusSchema,
  source: TaskSourceSchema,
  createdByUserId: UserIdSchema.nullable(),
  completedAt: UtcDateTimeSchema.nullable(),
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema,
});
export type Task = z.infer<typeof TaskSchema>;

/**
 * `GET /v1/tasks`: open tasks (due first, those without a due time last), or done ones (most
 * recently done first), or both; `mine` keeps only the caller's own.
 */
export const TaskQuerySchema = z
  .object({
    status: z.enum(['open', 'done', 'all']).default('open'),
    // A query string carries "true" or "false"; code may pass a boolean.
    mine: z
      .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
      .default(false),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export type TaskQuery = z.input<typeof TaskQuerySchema>;

export const TasksResponseSchema = z.object({ tasks: z.array(TaskSchema) });
export type TasksResponse = z.infer<typeof TasksResponseSchema>;

import { describe, expect, it } from 'vitest';
import { AuditChangeSchema } from './audit.js';
import {
  TaskChangeSchema,
  TaskInputSchema,
  TaskQuerySchema,
  TaskSchema,
  TASK_TITLE_MAX,
} from './tasks.js';

const USER = '0b6f2a5e-8d0c-4c3f-9c1e-2f7a6d5b4c3a';
const AT = '2026-11-03T15:00:00.000Z';

describe('TaskInputSchema', () => {
  it('trims the title and defaults to no due time; the assignee is left to the service', () => {
    expect(TaskInputSchema.parse({ title: '  Order color ' })).toEqual({
      title: 'Order color',
      dueAt: null,
    });
    expect(
      TaskInputSchema.parse({ title: 'Call back', dueAt: AT, assigneeUserId: USER.toUpperCase() }),
    ).toEqual({ title: 'Call back', dueAt: AT, assigneeUserId: USER });
    expect(TaskInputSchema.parse({ title: 'Team', assigneeUserId: null })).toMatchObject({
      assigneeUserId: null,
    });
  });

  it.each([
    { title: '   ' },
    { title: 'x'.repeat(TASK_TITLE_MAX + 1) },
    { title: 'Order', dueAt: 'tomorrow' },
    { title: 'Order', source: 'ai' },
    { title: 'Order', assigneeUserId: 'not-a-uuid' },
  ])('refuses %j', (input) => {
    expect(TaskInputSchema.safeParse(input).success).toBe(false);
  });
});

describe('TaskChangeSchema', () => {
  it('takes any one field, null clearing the due time or the assignee', () => {
    expect(TaskChangeSchema.parse({ status: 'done' })).toEqual({ status: 'done' });
    expect(TaskChangeSchema.parse({ dueAt: null, assigneeUserId: null })).toEqual({
      dueAt: null,
      assigneeUserId: null,
    });
  });

  it('refuses an empty change, an unknown status or field', () => {
    for (const change of [{}, { status: 'archived' }, { completedAt: AT }]) {
      expect(TaskChangeSchema.safeParse(change).success).toBe(false);
    }
  });
});

describe('TaskQuerySchema', () => {
  it('defaults to open tasks, everyone visible, 100 at most; reads query strings', () => {
    expect(TaskQuerySchema.parse({})).toEqual({ status: 'open', mine: false, limit: 100 });
    expect(TaskQuerySchema.parse({ status: 'all', mine: 'true', limit: '20' })).toEqual({
      status: 'all',
      mine: true,
      limit: 20,
    });
    expect(TaskQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
  });
});

describe('TaskSchema', () => {
  it('parses a task as the api returns it', () => {
    const task = {
      id: USER,
      title: 'Order color',
      dueAt: null,
      assigneeUserId: USER,
      status: 'open',
      source: 'manual',
      createdByUserId: null,
      completedAt: null,
      createdAt: AT,
      updatedAt: AT,
    };
    expect(TaskSchema.parse(task)).toEqual(task);
  });
});

describe('task audit entries', () => {
  const values = { status: 'open', dueAt: AT, assigneeUserId: USER, source: 'manual' };

  it('record status, due time, assignee and source, never the title', () => {
    expect(
      AuditChangeSchema.safeParse({
        action: 'task.created',
        entity: { type: 'task', id: USER },
        before: null,
        after: values,
      }).success,
    ).toBe(true);
    expect(
      AuditChangeSchema.safeParse({
        action: 'task.updated',
        entity: { type: 'task', id: USER },
        before: values,
        after: { ...values, title: 'Order color' },
      }).success,
    ).toBe(false);
  });
});

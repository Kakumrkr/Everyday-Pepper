import {
  TenantIdSchema,
  type MembershipRole,
  type TaskId,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import {
  addMembership,
  deleteMembership,
  listAuditEntries,
  withMember,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from './actor.js';
import { ManualClock } from './clock.js';
import {
  ForbiddenError,
  TaskAssigneeNotMemberError,
  TaskNotFoundError,
  TaskNotOpenError,
  UndoRefusedError,
} from './errors.js';
import { createBusiness } from './services/business.js';
import {
  changeTask,
  completeTaskIn,
  createTask,
  createTaskIn,
  listTasks,
  listTasksIn,
  reopenTaskIn,
  withdrawTaskIn,
} from './services/tasks.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The task services against real Postgres (ADR-0026): who may create, see, assign and change
// tasks, and an audit entry without the title for every change.

let database: TestDatabase;
let db: Database;
let tenantId: TenantId;
let owner: UserId;
let manager: UserId;
let jess: UserId;
let priya: UserId;

const as = (userId: UserId, role: MembershipRole): Actor => ({
  context: { tenantId, userId, role },
});
const ana = () => as(owner, 'owner');
const marco = () => as(manager, 'manager');
const jessActor = () => as(jess, 'staff');
const priyaActor = () => as(priya, 'staff');

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  owner = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, owner, {
    name: 'Juniper Hair Studio',
    slug: 'juniper-tasks',
    timeZone: 'America/New_York',
  });
  tenantId = TenantIdSchema.parse(tenant.id);
  manager = await insertUser(db, 'Marco');
  jess = await insertUser(db, 'Jess');
  priya = await insertUser(db, 'Priya');
  await withTenant(db, tenantId, async (tx) => {
    await addMembership(tx, { userId: manager, role: 'manager' });
    await addMembership(tx, { userId: jess, role: 'staff' });
    await addMembership(tx, { userId: priya, role: 'staff' });
  });
});

afterAll(async () => {
  await database.stop();
});

describe('createTask', () => {
  it("is the caller's own by default; owners and managers may assign anyone or no one", async () => {
    const own = await createTask(db, jessActor(), { title: 'Restock towels' });
    expect(own).toMatchObject({
      title: 'Restock towels',
      assigneeUserId: jess,
      createdByUserId: jess,
      status: 'open',
      source: 'manual',
      dueAt: null,
    });
    const forJess = await createTask(db, ana(), {
      title: 'Call the supplier',
      dueAt: '2026-11-03T14:00:00.000Z',
      assigneeUserId: jess,
    });
    expect(forJess).toMatchObject({ assigneeUserId: jess, dueAt: '2026-11-03T14:00:00.000Z' });
    const team = await createTask(db, marco(), { title: 'Team meeting', assigneeUserId: null });
    expect(team.assigneeUserId).toBeNull();
  });

  it('staff give tasks only to themselves, never to a colleague or no one', async () => {
    await expect(
      createTask(db, jessActor(), { title: 'For Priya', assigneeUserId: priya }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createTask(db, jessActor(), { title: 'For nobody', assigneeUserId: null }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses an assignee outside the business', async () => {
    const outsider = await insertUser(db, 'Outsider');
    await expect(
      createTask(db, ana(), { title: 'Nope', assigneeUserId: outsider }),
    ).rejects.toBeInstanceOf(TaskAssigneeNotMemberError);
  });

  it('audits the change without the title', async () => {
    const task = await createTask(db, ana(), { title: 'Secret plan', assigneeUserId: jess });
    const entries = await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 100 }));
    const entry = entries.find((e) => e.entity.id === task.id);
    expect(entry).toMatchObject({
      action: 'task.created',
      after: { status: 'open', dueAt: null, assigneeUserId: jess, source: 'manual' },
    });
    expect(JSON.stringify(entry)).not.toContain('Secret plan');
  });
});

describe('listTasks', () => {
  it('shows staff only their own tasks and owners everyone’s; `mine` narrows to the caller', async () => {
    const forPriya = await createTask(db, ana(), { title: 'For Priya', assigneeUserId: priya });
    const forJess = await createTask(db, ana(), { title: 'For Jess', assigneeUserId: jess });
    const ids = async (actor: Actor, mine = false) =>
      (await listTasks(db, actor, { status: 'all', mine, limit: 200 })).map((t) => t.id);

    expect(await ids(jessActor())).toContain(forJess.id);
    expect(await ids(jessActor())).not.toContain(forPriya.id);
    expect(await ids(ana())).toEqual(expect.arrayContaining([forJess.id, forPriya.id]));
    expect(await ids(ana(), true)).not.toContain(forJess.id);
  });
});

describe('changeTask', () => {
  it('marks done and open again, records when, and moves the due time', async () => {
    const clock = new ManualClock(new Date('2026-11-02T12:00:00Z'));
    const task = await createTask(db, jessActor(), {
      title: 'Order color',
      dueAt: '2026-11-03T14:00:00.000Z',
    });
    const done = await changeTask(db, jessActor(), task.id, { status: 'done' }, { clock });
    expect(done).toMatchObject({ status: 'done', completedAt: '2026-11-02T12:00:00.000Z' });
    const reopened = await changeTask(db, jessActor(), task.id, { status: 'open' }, { clock });
    expect(reopened).toMatchObject({ status: 'open', completedAt: null });
    const moved = await changeTask(db, jessActor(), task.id, {
      dueAt: '2026-11-04T14:00:00.000Z',
      title: 'Order color (blonde)',
    });
    expect(moved).toMatchObject({
      dueAt: '2026-11-04T14:00:00.000Z',
      title: 'Order color (blonde)',
    });

    const entries = await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 100 }));
    const actions = entries.filter((e) => e.entity.id === task.id).map((e) => e.action);
    expect(actions).toEqual(['task.updated', 'task.updated', 'task.updated', 'task.created']);
  });

  it('writes nothing for a change that changes nothing', async () => {
    const task = await createTask(db, ana(), { title: 'Same', assigneeUserId: null });
    const same = await changeTask(db, ana(), task.id, { title: 'Same', assigneeUserId: null });
    expect(same.updatedAt).toBe(task.updatedAt);
    const entries = await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 100 }));
    expect(entries.filter((e) => e.entity.id === task.id)).toHaveLength(1);
  });

  it("staff cannot reach a colleague's task, nor hand their own away", async () => {
    const forPriya = await createTask(db, ana(), { title: 'Priya only', assigneeUserId: priya });
    await expect(
      changeTask(db, jessActor(), forPriya.id, { status: 'done' }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    const own = await createTask(db, jessActor(), { title: 'Mine' });
    await expect(
      changeTask(db, jessActor(), own.id, { assigneeUserId: priya }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Priya can still change her own task.
    await expect(
      changeTask(db, priyaActor(), forPriya.id, { status: 'done' }),
    ).resolves.toMatchObject({ status: 'done' });
  });

  it('owners reassign, unassign and refuse non-members; an unknown task is not found', async () => {
    const task = await createTask(db, ana(), { title: 'Move me', assigneeUserId: jess });
    expect((await changeTask(db, ana(), task.id, { assigneeUserId: priya })).assigneeUserId).toBe(
      priya,
    );
    expect(
      (await changeTask(db, marco(), task.id, { assigneeUserId: null })).assigneeUserId,
    ).toBeNull();
    const outsider = await insertUser(db, 'Outsider 2');
    await expect(
      changeTask(db, ana(), task.id, { assigneeUserId: outsider }),
    ).rejects.toBeInstanceOf(TaskAssigneeNotMemberError);
    await expect(
      changeTask(db, ana(), '00000000-0000-4000-8000-000000000000' as TaskId, { status: 'done' }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it("a removed member's tasks stay, unassigned, for owners to hand on", async () => {
    const leaving = await insertUser(db, 'Leaving');
    await withTenant(db, tenantId, (tx) => addMembership(tx, { userId: leaving, role: 'staff' }));
    const task = await createTask(db, ana(), { title: 'Theirs', assigneeUserId: leaving });
    await withTenant(db, tenantId, (tx) => deleteMembership(tx, leaving));
    const [after] = (await listTasks(db, ana(), { status: 'all', limit: 200 })).filter(
      (t) => t.id === task.id,
    );
    expect(after?.assigneeUserId).toBeNull();
  });
});

describe("createTaskIn and withdrawTaskIn (the AI's to-dos, ADR-0029)", () => {
  it('records the source and takes back an untouched to-do, audited without the title', async () => {
    const task = await withMember(db, jessActor().context, (tx) =>
      createTaskIn(tx, jessActor(), { title: 'Call Maria' }, { source: 'ai' }),
    );
    expect(task).toMatchObject({ source: 'ai', assigneeUserId: jess, status: 'open' });
    await withMember(db, jessActor().context, (tx) => withdrawTaskIn(tx, jessActor(), task.id));
    expect((await listTasks(db, ana(), { status: 'all' })).map((t) => t.id)).not.toContain(task.id);
    const entries = await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 1 }));
    expect(entries[0]).toMatchObject({
      action: 'task.deleted',
      entity: { type: 'task', id: task.id },
      before: { status: 'open', source: 'ai' },
      after: null,
    });
    expect(JSON.stringify(entries[0])).not.toContain('Call Maria');
  });

  it('refuses once someone changed it, and hides a colleague’s to-do from staff', async () => {
    const task = await createTask(db, jessActor(), { title: 'Order foils' });
    await changeTask(db, jessActor(), task.id, { status: 'done' });
    await expect(
      withMember(db, jessActor().context, (tx) => withdrawTaskIn(tx, jessActor(), task.id)),
    ).rejects.toBeInstanceOf(UndoRefusedError);
    const theirs = await createTask(db, priyaActor(), { title: 'Priya only' });
    await expect(
      withMember(db, jessActor().context, (tx) => withdrawTaskIn(tx, jessActor(), theirs.id)),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});

describe("completeTaskIn and reopenTaskIn (the AI's complete_todo, S26b)", () => {
  const now = new Date('2026-11-02T12:00:00Z');
  const complete = (actor: Actor, id: TaskId) =>
    withMember(db, actor.context, (tx) => completeTaskIn(tx, actor, id, { now }));
  const reopen = (actor: Actor, id: TaskId, completedVersion: string) =>
    withMember(db, actor.context, (tx) => reopenTaskIn(tx, actor, id, { completedVersion }));

  it('marks an open to-do done, and its undo opens it again while nobody touched it', async () => {
    const task = await createTask(db, jessActor(), { title: 'Sweep up' });
    const { before, after } = await complete(jessActor(), task.id);
    expect(before).toMatchObject({ status: 'open', completedAt: null });
    expect(after).toMatchObject({ status: 'done', completedAt: now.toISOString() });
    await reopen(jessActor(), task.id, after.updatedAt);
    const [again] = (await listTasks(db, jessActor(), { status: 'all', limit: 200 })).filter(
      (t) => t.id === task.id,
    );
    expect(again).toMatchObject({ status: 'open', completedAt: null });
    const entries = await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 2 }));
    expect(entries.map((e) => [e.action, e.entity.id])).toEqual([
      ['task.updated', task.id],
      ['task.updated', task.id],
    ]);
  });

  it('refuses a to-do already done, and one the member cannot see', async () => {
    const task = await createTask(db, jessActor(), { title: 'Done already' });
    await changeTask(db, jessActor(), task.id, { status: 'done' });
    await expect(complete(jessActor(), task.id)).rejects.toBeInstanceOf(TaskNotOpenError);
    const theirs = await createTask(db, priyaActor(), { title: 'Priya only' });
    await expect(complete(jessActor(), theirs.id)).rejects.toBeInstanceOf(TaskNotFoundError);
    // An owner reaches everyone's.
    await expect(complete(ana(), theirs.id)).resolves.toMatchObject({ after: { status: 'done' } });
  });

  it('refuses the undo once the to-do changed after it was done', async () => {
    const task = await createTask(db, jessActor(), { title: 'Order foils' });
    const { after } = await complete(jessActor(), task.id);
    await changeTask(db, jessActor(), task.id, { title: 'Order foils and gloves' });
    await expect(reopen(jessActor(), task.id, after.updatedAt)).rejects.toBeInstanceOf(
      UndoRefusedError,
    );
    const reopened = await createTask(db, jessActor(), { title: 'Reopened by hand' });
    const second = await complete(jessActor(), reopened.id);
    await changeTask(db, jessActor(), reopened.id, { status: 'open' });
    await expect(reopen(jessActor(), reopened.id, second.after.updatedAt)).rejects.toBeInstanceOf(
      UndoRefusedError,
    );
  });

  it('lists in the caller’s transaction as listTasks does', async () => {
    const mine = await withMember(db, jessActor().context, (tx) =>
      listTasksIn(tx, jessActor(), { status: 'open', mine: true }),
    );
    expect(mine.every((t) => t.assigneeUserId === jess && t.status === 'open')).toBe(true);
    expect(mine.map((t) => t.id)).toEqual(
      (await listTasks(db, jessActor(), { mine: true })).map((t) => t.id),
    );
  });
});

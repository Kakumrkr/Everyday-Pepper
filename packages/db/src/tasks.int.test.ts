import { TaskIdSchema, TenantIdSchema, type TenantId, type UserId } from '@pepper/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import { addMembership, deleteMembership } from './repositories/memberships.js';
import {
  deletePushSubscription,
  deletePushSubscriptionByEndpoint,
  findPushSubscriptionByEndpoint,
  listPushSubscriptionsOf,
  savePushSubscription,
} from './repositories/push-subscriptions.js';
import { insertTask, listDueTasks, listTasks, lockTask, updateTask } from './repositories/tasks.js';
import { createTenant } from './repositories/tenants.js';
import { withMember, withTenant, type TenantTx } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

// Tasks and push subscriptions against real Postgres (ADR-0026): the staff scope at the RLS
// level, the assignee cleared when a member leaves, ordering, the due scan, and devices. The
// isolation of both tables between businesses is in isolation.int.test.ts.

let database: TestDatabase;
let db: Database;
let tenant: TenantId;
// Ana owns the business, Cara manages it, Jess and Ben are staff.
let ana: UserId;
let cara: UserId;
let jess: UserId;
let ben: UserId;

const as = <T>(userId: UserId, work: (tx: TenantTx) => Promise<T>) =>
  withMember(db, { tenantId: tenant, userId }, work);

const task = (overrides: Partial<Parameters<typeof insertTask>[1]> = {}) => ({
  title: 'Order color',
  dueAt: null,
  assigneeUserId: null,
  source: 'manual' as const,
  createdBy: null,
  ...overrides,
});

const keys = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) };

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  const created = await createTenant(db, {
    name: 'Plum',
    slug: 'plum',
    timeZone: 'America/Chicago',
  });
  tenant = TenantIdSchema.parse(created.id);
  ana = await insertUser(db, 'Ana');
  cara = await insertUser(db, 'Cara');
  jess = await insertUser(db, 'Jess');
  ben = await insertUser(db, 'Ben');
  await withTenant(db, tenant, async (tx) => {
    await addMembership(tx, { userId: ana, role: 'owner' });
    await addMembership(tx, { userId: cara, role: 'manager' });
    await addMembership(tx, { userId: jess, role: 'staff' });
    await addMembership(tx, { userId: ben, role: 'staff' });
  });
});

afterAll(async () => {
  await database.stop();
});

describe('tasks', () => {
  it('staff reach only tasks assigned to them or that they created (RLS)', async () => {
    const ids = await withTenant(db, tenant, async (tx) => ({
      forJess: (await insertTask(tx, task({ assigneeUserId: jess, createdBy: ana }))).id,
      byJess: (await insertTask(tx, task({ assigneeUserId: null, createdBy: jess }))).id,
      forBen: (await insertTask(tx, task({ assigneeUserId: ben, createdBy: ana }))).id,
      team: (await insertTask(tx, task({ createdBy: ana }))).id,
    }));
    const seen = async (userId: UserId) =>
      (await as(userId, (tx) => listTasks(tx, { status: 'all', limit: 200 }))).map((t) => t.id);

    expect(await seen(jess)).toEqual(expect.arrayContaining([ids.forJess, ids.byJess]));
    expect(await seen(jess)).not.toContain(ids.forBen);
    expect(await seen(jess)).not.toContain(ids.team);
    for (const lead of [ana, cara]) {
      expect(await seen(lead)).toEqual(expect.arrayContaining(Object.values(ids)));
    }

    // Jess can neither change Ben's task nor give herself one that is not hers.
    const benTask = TaskIdSchema.parse(ids.forBen);
    expect(await as(jess, (tx) => updateTask(tx, benTask, { title: 'Mine now' }))).toBeUndefined();
    await expect(
      as(jess, (tx) => insertTask(tx, task({ assigneeUserId: ben, createdBy: ana }))),
    ).rejects.toSatisfy((error) => sqlState(error) === '42501');
    // Nor hand her own task to Ben while keeping it hidden from her (WITH CHECK).
    const own = TaskIdSchema.parse(ids.forJess);
    await expect(as(jess, (tx) => updateTask(tx, own, { assigneeUserId: ben }))).rejects.toSatisfy(
      (error) => sqlState(error) === '42501',
    );
  });

  it('refuses an assignee who is not a member of the business', async () => {
    const outsider = await insertUser(db, 'Outsider');
    await expect(
      withTenant(db, tenant, (tx) => insertTask(tx, task({ assigneeUserId: outsider }))),
    ).rejects.toSatisfy((error) => sqlState(error) === '23503');
  });

  it("keeps a leaving member's tasks, unassigned", async () => {
    const leaving = await insertUser(db, 'Leaving');
    const id = await withTenant(db, tenant, async (tx) => {
      await addMembership(tx, { userId: leaving, role: 'staff' });
      return TaskIdSchema.parse((await insertTask(tx, task({ assigneeUserId: leaving }))).id);
    });
    await withTenant(db, tenant, (tx) => deleteMembership(tx, leaving));
    const row = await withTenant(db, tenant, (tx) => lockTask(tx, id));
    expect(row).toMatchObject({ id, assigneeUserId: null, title: 'Order color' });
  });

  it('lists open tasks by due time (none last), then done ones most recent first', async () => {
    const lister = await insertUser(db, 'Lister');
    const titles = await withTenant(db, tenant, async (tx) => {
      await addMembership(tx, { userId: lister, role: 'staff' });
      const add = (title: string, fields: Partial<Parameters<typeof insertTask>[1]> = {}) =>
        insertTask(tx, task({ title, assigneeUserId: lister, ...fields }));
      await add('no due');
      await add('later', { dueAt: new Date('2026-11-05T15:00:00Z') });
      await add('sooner', { dueAt: new Date('2026-11-04T15:00:00Z') });
      for (const [title, doneAt] of [
        ['done first', '2026-11-01T10:00:00Z'],
        ['done last', '2026-11-02T10:00:00Z'],
      ] as const) {
        const row = await add(title);
        await updateTask(tx, TaskIdSchema.parse(row.id), {
          status: 'done',
          completedAt: new Date(doneAt),
        });
      }
      const list = (status: 'open' | 'done' | 'all') =>
        listTasks(tx, { status, assigneeUserId: lister, limit: 200 });
      return {
        open: (await list('open')).map((t) => t.title),
        done: (await list('done')).map((t) => t.title),
        all: (await list('all')).map((t) => t.title),
      };
    });
    expect(titles.open).toEqual(['sooner', 'later', 'no due']);
    expect(titles.done).toEqual(['done last', 'done first']);
    expect(titles.all).toEqual([...titles.open, ...titles.done]);
  });

  it('a done task needs its completion time, and a title has 1–200 characters', async () => {
    await withTenant(db, tenant, async (tx) => {
      const row = await insertTask(tx, task());
      await expect(
        tx.transaction((inner) =>
          inner.execute(sql`UPDATE tasks SET status = 'done' WHERE id = ${row.id}`),
        ),
      ).rejects.toSatisfy((error) => sqlState(error) === '23514');
      await expect(
        tx.transaction((inner) =>
          inner.execute(sql`UPDATE tasks SET title = ${'x'.repeat(201)} WHERE id = ${row.id}`),
        ),
      ).rejects.toSatisfy((error) => sqlState(error) === '23514');
    });
  });

  it('the due scan lists open, due tasks not yet notified, earliest first', async () => {
    const now = new Date('2030-01-01T12:00:00Z');
    const ids = await withTenant(db, tenant, async (tx) => {
      const add = async (dueAt: Date | null, fields: Parameters<typeof updateTask>[2] = {}) => {
        const row = await insertTask(tx, task({ dueAt }));
        const id = TaskIdSchema.parse(row.id);
        if (Object.keys(fields).length > 0) await updateTask(tx, id, fields);
        return id;
      };
      return {
        later: await add(new Date('2030-01-01T11:00:00Z')),
        earlier: await add(new Date('2030-01-01T10:00:00Z')),
        notYet: await add(new Date('2030-01-01T13:00:00Z')),
        notified: await add(new Date('2030-01-01T09:00:00Z'), { dueNotifiedAt: now }),
        done: await add(new Date('2030-01-01T09:00:00Z'), {
          status: 'done',
          completedAt: now,
        }),
        noDue: await add(null),
      };
    });
    const due = (await listDueTasks(db, now, 1000)).filter((d) =>
      Object.values(ids).includes(d.taskId),
    );
    expect(due).toEqual([
      { taskId: ids.earlier, tenantId: tenant },
      { taskId: ids.later, tenantId: tenant },
    ]);
  });
});

describe('push subscriptions', () => {
  const endpoint = () => `https://push.example.test/${newId()}`;

  it('each member reaches only their own devices; work without a user reaches all', async () => {
    const jessDevice = endpoint();
    const benDevice = endpoint();
    await as(jess, (tx) =>
      savePushSubscription(tx, { userId: jess, endpoint: jessDevice, ...keys }),
    );
    await as(ben, (tx) => savePushSubscription(tx, { userId: ben, endpoint: benDevice, ...keys }));

    expect(await as(jess, (tx) => findPushSubscriptionByEndpoint(tx, benDevice))).toBeUndefined();
    // An owner does not see staff's devices either.
    expect(await as(ana, (tx) => findPushSubscriptionByEndpoint(tx, jessDevice))).toBeUndefined();
    expect(await as(jess, (tx) => deletePushSubscriptionByEndpoint(tx, benDevice))).toBe(false);
    // Nobody saves a device for someone else.
    await expect(
      as(jess, (tx) => savePushSubscription(tx, { userId: ben, endpoint: endpoint(), ...keys })),
    ).rejects.toSatisfy((error) => sqlState(error) === '42501');

    const all = await withTenant(db, tenant, (tx) => listPushSubscriptionsOf(tx, [jess, ben]));
    expect(all.map((row) => row.endpoint)).toEqual(expect.arrayContaining([jessDevice, benDevice]));
  });

  it('saving the same device again replaces its keys; removing it works once', async () => {
    const device = endpoint();
    const first = await as(cara, (tx) =>
      savePushSubscription(tx, { userId: cara, endpoint: device, ...keys }),
    );
    const again = await as(cara, (tx) =>
      savePushSubscription(tx, {
        userId: cara,
        endpoint: device,
        p256dh: 'C'.repeat(87),
        auth: 'b'.repeat(22),
      }),
    );
    expect(again).toMatchObject({ id: first.id, p256dh: 'C'.repeat(87), auth: 'b'.repeat(22) });
    expect(await as(cara, (tx) => deletePushSubscriptionByEndpoint(tx, device))).toBe(true);
    expect(await as(cara, (tx) => deletePushSubscriptionByEndpoint(tx, device))).toBe(false);
  });

  it('refuses a non-https endpoint or malformed keys', async () => {
    for (const fields of [
      { endpoint: 'http://push.example.test/x', ...keys },
      { endpoint: endpoint(), p256dh: 'short', auth: keys.auth },
      { endpoint: endpoint(), p256dh: keys.p256dh, auth: 'has spaces in it!!' },
    ]) {
      await expect(
        as(cara, (tx) => savePushSubscription(tx, { userId: cara, ...fields })),
      ).rejects.toSatisfy((error) => sqlState(error) === '23514');
    }
  });

  it('goes with the membership, and can be removed by id', async () => {
    const leaving = await insertUser(db, 'Leaving device');
    const device = endpoint();
    const saved = await withTenant(db, tenant, async (tx) => {
      await addMembership(tx, { userId: leaving, role: 'staff' });
      return savePushSubscription(tx, { userId: leaving, endpoint: device, ...keys });
    });
    await withTenant(db, tenant, (tx) => deleteMembership(tx, leaving));
    expect(
      await withTenant(db, tenant, (tx) => findPushSubscriptionByEndpoint(tx, device)),
    ).toBeUndefined();

    const other = await as(ana, (tx) =>
      savePushSubscription(tx, { userId: ana, endpoint: endpoint(), ...keys }),
    );
    await withTenant(db, tenant, (tx) => deletePushSubscription(tx, other.id));
    expect(await withTenant(db, tenant, (tx) => listPushSubscriptionsOf(tx, [ana]))).toEqual([]);
    expect(saved.userId).toBe(leaving);
  });

  it('keeps each member’s newest 10 devices, so nobody crowds out the others', async () => {
    const many = await insertUser(db, 'Many devices');
    await withTenant(db, tenant, (tx) => addMembership(tx, { userId: many, role: 'staff' }));
    const endpoints = Array.from({ length: 12 }, () => endpoint());
    for (const device of endpoints) {
      await as(many, (tx) => savePushSubscription(tx, { userId: many, endpoint: device, ...keys }));
    }
    const kept = await withTenant(db, tenant, (tx) => listPushSubscriptionsOf(tx, [many, ana]));
    const mine = kept.filter((row) => row.userId === many).map((row) => row.endpoint);
    expect(mine.sort()).toEqual(endpoints.slice(2).sort());
    // Saving an older device again makes it the newest.
    await as(many, (tx) =>
      savePushSubscription(tx, { userId: many, endpoint: endpoints[2] ?? '', ...keys }),
    );
    await as(many, (tx) =>
      savePushSubscription(tx, { userId: many, endpoint: endpoint(), ...keys }),
    );
    const after = (await withTenant(db, tenant, (tx) => listPushSubscriptionsOf(tx, [many]))).map(
      (row) => row.endpoint,
    );
    expect(after).toHaveLength(10);
    expect(after).toContain(endpoints[2]);
    expect(after).not.toContain(endpoints[3]);
  });

  it('a shared device moves to whoever turned it on last (saved without a user)', async () => {
    const shared = endpoint();
    await as(ana, (tx) => savePushSubscription(tx, { userId: ana, endpoint: shared, ...keys }));
    // Jess cannot see Ana's row, so her own save fails under her member scope...
    await expect(
      as(jess, (tx) => savePushSubscription(tx, { userId: jess, endpoint: shared, ...keys })),
    ).rejects.toSatisfy((error) => sqlState(error) === '42501');
    // ...and the service saves it as work without a user, for the authenticated member.
    await withTenant(db, tenant, (tx) =>
      savePushSubscription(tx, { userId: jess, endpoint: shared, ...keys }),
    );
    expect(await as(jess, (tx) => findPushSubscriptionByEndpoint(tx, shared))).toMatchObject({
      userId: jess,
    });
    expect(await as(ana, (tx) => findPushSubscriptionByEndpoint(tx, shared))).toBeUndefined();
  });
});

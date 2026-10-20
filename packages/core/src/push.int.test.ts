import {
  TenantIdSchema,
  type MembershipRole,
  type OutboxMessageId,
  type TaskId,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import {
  addMembership,
  createTenant,
  findOutboxMessage,
  findPushSubscriptionByEndpoint,
  insertTask,
  listDueOutboxMessages,
  listPushSubscriptionsOf,
  lockTask,
  newId,
  updateTask,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from './actor.js';
import { ManualClock } from './clock.js';
import { ForbiddenError } from './errors.js';
import {
  outboxKeyFrom,
  PushRejectedError,
  type Mailer,
  type PushMessage,
  type Pusher,
} from './outbox.js';
import { deliverOutboxMessage, type DeliveryResult } from './services/outbox.js';
import {
  leadUserIds,
  pushDeviceStatus,
  queuePushToMembers,
  removePushDevice,
  savePushDevice,
  type PushNotice,
} from './services/push.js';
import { sendDueTaskPushes } from './services/tasks.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// Web Push through the outbox against real Postgres (ADR-0026): members' devices, one push
// per device queued with the change, delivered once; a device that is gone is removed and its
// push dropped, not alerted; and the due-task job tells each to-do's assignee once.

let database: TestDatabase;
let db: Database;
let slugs = 0;
// A fresh business per test: Ana owns it, Cara manages it, Jess is staff.
let tenant: TenantId;
let ana: UserId;
let cara: UserId;
let jess: UserId;

const key = outboxKeyFrom('an-integration-test-outbox-secret-32+');
const clock = new ManualClock('2026-11-02T15:00:00Z');
const keys = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) };
const mailer: Mailer = { send: () => Promise.resolve() };
const notice: PushNotice = { title: 'To-do due', body: 'Order color', url: '/', tag: 'task-1' };

/** Records what it sends; answers with the next status in `answers` (201 when empty). */
class FakePusher implements Pusher {
  readonly sent: PushMessage[] = [];
  answers: number[] = [];

  send(message: PushMessage): Promise<void> {
    const status = this.answers.shift() ?? 201;
    if (status >= 400) return Promise.reject(new PushRejectedError(status));
    this.sent.push(message);
    return Promise.resolve();
  }
}

const as = (userId: UserId, role: MembershipRole): Actor => ({
  context: { tenantId: tenant, userId, role },
});
const device = () => `https://fcm.googleapis.com/fcm/send/${newId()}`;

/** Queues `notice` to these members' devices under a fresh dedupe key. */
function queueTo(userIds: UserId[], dedupeKey = `test.push:${newId()}`) {
  return withTenant(db, tenant, (tx) =>
    queuePushToMembers(tx, userIds, notice, { key, dedupeKey, now: clock.now() }),
  );
}

async function deliverAll(
  ids: OutboxMessageId[],
  pusher: Pusher | null,
): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];
  for (const messageId of ids) {
    results.push(
      await deliverOutboxMessage(
        db,
        { messageId, tenantId: tenant },
        { key, mailer, pusher, clock },
      ),
    );
  }
  return results;
}

function message(id: OutboxMessageId | undefined) {
  if (id === undefined) throw new Error('Nothing was queued');
  return withTenant(db, tenant, (tx) => findOutboxMessage(tx, id));
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

beforeEach(async () => {
  slugs += 1;
  const created = await createTenant(db, {
    name: 'Plum',
    slug: `plum-push-${String(slugs)}`,
    timeZone: 'America/Chicago',
  });
  tenant = TenantIdSchema.parse(created.id);
  ana = await insertUser(db, 'Ana');
  cara = await insertUser(db, 'Cara');
  jess = await insertUser(db, 'Jess');
  await withTenant(db, tenant, async (tx) => {
    await addMembership(tx, { userId: ana, role: 'owner' });
    await addMembership(tx, { userId: cara, role: 'manager' });
    await addMembership(tx, { userId: jess, role: 'staff' });
  });
});

describe('devices', () => {
  it('a member turns a device on, checks it and turns it off; only their own', async () => {
    const phone = device();
    await savePushDevice(db, as(jess, 'staff'), { endpoint: phone, keys });
    expect(await pushDeviceStatus(db, as(jess, 'staff'), { endpoint: phone })).toBe(true);
    // The owner neither sees nor removes Jess's device.
    expect(await pushDeviceStatus(db, as(ana, 'owner'), { endpoint: phone })).toBe(false);
    await removePushDevice(db, as(ana, 'owner'), { endpoint: phone });
    expect(await pushDeviceStatus(db, as(jess, 'staff'), { endpoint: phone })).toBe(true);
    await removePushDevice(db, as(jess, 'staff'), { endpoint: phone });
    expect(await pushDeviceStatus(db, as(jess, 'staff'), { endpoint: phone })).toBe(false);
    // Removing a device that is not on is fine.
    await removePushDevice(db, as(jess, 'staff'), { endpoint: phone });
  });

  it('a shared device moves to whoever turned it on last', async () => {
    const tablet = device();
    await savePushDevice(db, as(ana, 'owner'), { endpoint: tablet, keys });
    await savePushDevice(db, as(jess, 'staff'), { endpoint: tablet, keys });
    expect(await pushDeviceStatus(db, as(jess, 'staff'), { endpoint: tablet })).toBe(true);
    expect(await pushDeviceStatus(db, as(ana, 'owner'), { endpoint: tablet })).toBe(false);
  });

  it('refuses an endpoint off the push services, and a caller without a role', async () => {
    await expect(
      savePushDevice(db, as(jess, 'staff'), { endpoint: 'https://internal.example.test/x', keys }),
    ).rejects.toThrow();
    await expect(
      savePushDevice(db, as(jess, 'staff'), { endpoint: 'http://push.example.test/x', keys }),
    ).rejects.toThrow();
    const nobody: Actor = { context: { tenantId: tenant, userId: jess, role: 'guest' as never } };
    await expect(savePushDevice(db, nobody, { endpoint: device(), keys })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('queueing and delivery', () => {
  it('queues one push per device of the members, once per change; the leads are owners and managers', async () => {
    await savePushDevice(db, as(ana, 'owner'), { endpoint: device(), keys });
    await savePushDevice(db, as(ana, 'owner'), { endpoint: device(), keys });
    await savePushDevice(db, as(jess, 'staff'), { endpoint: device(), keys });
    const dedupeKey = `test.push:${newId()}`;

    expect(await queueTo([ana, ana, cara], dedupeKey)).toHaveLength(2);
    // The same change again queues nothing.
    expect(await queueTo([ana], dedupeKey)).toEqual([]);
    const leads = await withTenant(db, tenant, (tx) => leadUserIds(tx));
    expect(leads.sort()).toEqual([ana, cara].sort());
  });

  it('sends each push once, to the device it was queued for; content is cleared', async () => {
    const phone = device();
    await savePushDevice(db, as(jess, 'staff'), { endpoint: phone, keys });
    const ids = await queueTo([jess]);
    const pusher = new FakePusher();
    expect(await deliverAll(ids, pusher)).toEqual(['sent']);
    expect(await deliverAll(ids, pusher)).toEqual(['skipped']);
    expect(pusher.sent).toEqual([
      { endpoint: phone, keys, payload: JSON.stringify(notice), ttlSeconds: 86_400 },
    ]);
    expect(await message(ids[0])).toMatchObject({ status: 'sent', payload: null });
  });

  it('drops the push and removes a device its push service no longer knows', async () => {
    const phone = device();
    await savePushDevice(db, as(jess, 'staff'), { endpoint: phone, keys });
    const ids = await queueTo([jess]);
    const pusher = new FakePusher();
    pusher.answers = [410];
    expect(await deliverAll(ids, pusher)).toEqual(['dropped']);
    expect(
      await withTenant(db, tenant, (tx) => findPushSubscriptionByEndpoint(tx, phone)),
    ).toBeUndefined();
    expect(await message(ids[0])).toMatchObject({
      status: 'dead',
      lastError: 'PushSubscriptionGone',
      payload: null,
    });
  });

  it('drops a push to a device turned off meanwhile; retries without a pusher or on 429', async () => {
    const phone = device();
    await savePushDevice(db, as(jess, 'staff'), { endpoint: phone, keys });
    const [later] = await queueTo([jess]);
    const [busy] = await queueTo([jess]);
    const [off] = await queueTo([jess]);
    if (later === undefined || busy === undefined || off === undefined) throw new Error('queued');

    expect(await deliverAll([later], null)).toEqual(['retry']);
    expect(await message(later)).toMatchObject({ lastError: 'ChannelUnavailableError' });
    const pusher = new FakePusher();
    pusher.answers = [429];
    expect(await deliverAll([busy], pusher)).toEqual(['retry']);
    await removePushDevice(db, as(jess, 'staff'), { endpoint: phone });
    expect(await deliverAll([off], pusher)).toEqual(['dropped']);
    expect(pusher.sent).toEqual([]);
  });

  it('gives up on a push refused for good (403: our keys), keeping the device', async () => {
    await savePushDevice(db, as(jess, 'staff'), { endpoint: device(), keys });
    const ids = await queueTo([jess]);
    const pusher = new FakePusher();
    pusher.answers = [403];
    expect(await deliverAll(ids, pusher)).toEqual(['dead']);
    expect(await withTenant(db, tenant, (tx) => listPushSubscriptionsOf(tx, [jess]))).toHaveLength(
      1,
    );
  });
});

describe('sendDueTaskPushes', () => {
  function addTask(fields: { dueAt: Date | null; assigneeUserId: UserId | null }) {
    return withTenant(db, tenant, async (tx) => {
      const row = await insertTask(tx, {
        title: 'Order color',
        source: 'manual',
        createdBy: ana,
        ...fields,
      });
      return row.id as TaskId;
    });
  }

  /** The dedupe keys of this business's pushes now due, i.e. just queued. */
  async function queuedPushKeys(): Promise<string[]> {
    const due = (await listDueOutboxMessages(db, clock.now(), 1000)).filter(
      (m) => m.tenantId === tenant,
    );
    const rows = await Promise.all(due.map((m) => message(m.messageId)));
    return rows.filter((row) => row?.type === 'push').map((row) => String(row?.dedupeKey));
  }

  it('tells the assignee once when it comes due, or the leads for a team task', async () => {
    await savePushDevice(db, as(jess, 'staff'), { endpoint: device(), keys });
    await savePushDevice(db, as(ana, 'owner'), { endpoint: device(), keys });
    await savePushDevice(db, as(cara, 'manager'), { endpoint: device(), keys });
    const now = clock.now();
    const past = new Date(now.getTime() - 60_000);
    const forJess = await addTask({ dueAt: past, assigneeUserId: jess });
    const team = await addTask({ dueAt: past, assigneeUserId: null });
    const later = await addTask({
      dueAt: new Date(now.getTime() + 3_600_000),
      assigneeUserId: jess,
    });

    expect(await sendDueTaskPushes(db, { key, clock })).toBeGreaterThanOrEqual(2);
    const read = (id: TaskId) => withTenant(db, tenant, (tx) => lockTask(tx, id));
    expect((await read(forJess))?.dueNotifiedAt).toEqual(now);
    expect((await read(team))?.dueNotifiedAt).toEqual(now);
    expect((await read(later))?.dueNotifiedAt).toBeNull();
    const pushKeys = await queuedPushKeys();
    // Jess's device for her task; Ana's and Cara's for the team's.
    expect(pushKeys.filter((k) => k.startsWith(`task.due:${forJess}:`))).toHaveLength(1);
    expect(pushKeys.filter((k) => k.startsWith(`task.due:${team}:`))).toHaveLength(2);

    // A second pass sends nothing more; a new due time notifies again once it comes.
    expect(await sendDueTaskPushes(db, { key, clock })).toBe(0);
    await withTenant(db, tenant, (tx) =>
      updateTask(tx, forJess, { dueAt: new Date(now.getTime() - 1000), dueNotifiedAt: null }),
    );
    expect(await sendDueTaskPushes(db, { key, clock })).toBe(1);
  });

  it('skips a task done before it came due', async () => {
    const now = clock.now();
    const done = await addTask({ dueAt: new Date(now.getTime() - 60_000), assigneeUserId: jess });
    await withTenant(db, tenant, (tx) =>
      updateTask(tx, done, { status: 'done', completedAt: now }),
    );
    await sendDueTaskPushes(db, { key, clock });
    expect((await withTenant(db, tenant, (tx) => lockTask(tx, done)))?.dueNotifiedAt).toBeNull();
  });
});

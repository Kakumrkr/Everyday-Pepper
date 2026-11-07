// Screenshots on support requests (S59.2.3, ADR-0062 Part 3, AC-X-27…31): who reaches an unsent
// and a sent screenshot, that a sent one never changes, the operator's logged read, the job's
// sweep and the business's deletion. Part of the isolation evidence with isolation.int.test.ts.
import { randomBytes } from 'node:crypto';
import { TenantIdSchema, type TenantId, type UserId } from '@pepper/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { grantOperator } from './operators.js';
import {
  deleteCurrentTenantIfDue,
  scheduleCurrentTenantDeletion,
} from './repositories/deletion.js';
import { addMembership } from './repositories/memberships.js';
import {
  attachSupportScreenshots,
  countSupportScreenshotUploads,
  deleteStaleSupportScreenshots,
  discardSupportScreenshot,
  findSupportScreenshot,
  insertSupportScreenshot,
  listAllSupportScreenshots,
  listStaleSupportScreenshots,
  listSupportScreenshots,
  listSupportScreenshotsForExport,
  lockAttachableSupportScreenshots,
} from './repositories/support-screenshots.js';
import {
  insertSupportThread,
  listOperatorThreads,
  listSupportThreads,
} from './repositories/support.js';
import { createTenant } from './repositories/tenants.js';
import { newId } from './ids.js';
import { withJobScan, withMember, withOperator, withTenant, type TenantTx } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

let database: TestDatabase;
let db: Database;
let tenantA: TenantId;
let tenantB: TenantId;
let owner: UserId;
let staff: UserId;
let otherStaff: UserId;
let operator: UserId;

async function asAdmin<T extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
  const client = new pg.Client({ connectionString: database.migrationUrl });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

function reference(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  return `PEP-${[...randomBytes(6)].map((byte) => alphabet[byte % 32] ?? '0').join('')}`;
}

async function upload(tenantId: TenantId, userId: UserId, now = new Date()): Promise<string> {
  const id = newId();
  await withMember(db, { tenantId, userId }, (tx) =>
    insertSupportScreenshot(tx, {
      id,
      uploadedBy: userId,
      width: 1170,
      height: 2532,
      widths: [480, 1170],
      bytes: 90_000,
      now,
    }),
  );
  return id;
}

/** Opens a thread as `userId` with `screenshotIds` attached to its first message. */
async function openWith(
  tenantId: TenantId,
  userId: UserId,
  screenshotIds: string[],
): Promise<{ threadId: string; messageId: string }> {
  return withMember(db, { tenantId, userId }, async (tx) => {
    const thread = await insertSupportThread(tx, {
      reference: reference(),
      kind: 'problem',
      openedByUserId: userId,
      context: { appVersion: 'test' },
      body: 'The calendar is empty',
      now: new Date(),
    });
    if (thread === null) throw new Error('reference taken');
    const messageId = await firstMessage(tx, thread.id);
    const locked = await lockAttachableSupportScreenshots(tx, userId, screenshotIds);
    await attachSupportScreenshots(tx, {
      ids: locked.map((row) => row.id),
      threadId: thread.id,
      messageId,
      now: new Date(),
    });
    return { threadId: thread.id, messageId };
  });
}

async function firstMessage(tx: TenantTx, threadId: string): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(
    sql`SELECT id::text FROM support_messages WHERE thread_id = ${threadId} ORDER BY created_at LIMIT 1`,
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('no message');
  return id;
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  tenantA = TenantIdSchema.parse(
    (await createTenant(db, { name: 'Salon A', slug: 'shot-a', timeZone: 'America/New_York' })).id,
  );
  tenantB = TenantIdSchema.parse(
    (await createTenant(db, { name: 'Barber B', slug: 'shot-b', timeZone: 'America/Chicago' })).id,
  );
  owner = await insertUser(db, 'Olga Owner');
  staff = await insertUser(db, 'Sam Staff');
  otherStaff = await insertUser(db, 'Sia Staff');
  await withTenant(db, tenantA, async (tx) => {
    await addMembership(tx, { userId: owner, role: 'owner' });
    await addMembership(tx, { userId: staff, role: 'staff' });
    await addMembership(tx, { userId: otherStaff, role: 'staff' });
  });
  operator = await insertUser(db, 'Olive Operator');
  const rows = await asAdmin<{ email: string }>('SELECT email FROM users WHERE id = $1', [
    operator,
  ]);
  expect(
    await grantOperator(database.migrationUrl, { email: String(rows[0]?.email), note: 'tests' }),
  ).toBe('granted');
});

afterAll(async () => {
  await database.stop();
});

describe('who reaches a screenshot (AC-X-29)', () => {
  it('an unsent one: only its uploader, not the owner or another business', async () => {
    const id = await upload(tenantA, staff);
    const as = (tenantId: TenantId, userId: UserId) =>
      withMember(db, { tenantId, userId }, (tx) => findSupportScreenshot(tx, id));
    expect((await as(tenantA, staff))?.id).toBe(id);
    expect(await as(tenantA, owner)).toBeUndefined();
    expect(await as(tenantA, otherStaff)).toBeUndefined();
    expect(await as(tenantB, staff)).toBeUndefined();
    expect(
      await withMember(db, { tenantId: tenantA, userId: staff }, (tx) =>
        findSupportScreenshot(tx, 'not-a-uuid'),
      ),
    ).toBeUndefined();
  });

  it('a sent one: whoever reaches its thread (the opener and owners), never other staff', async () => {
    const id = await upload(tenantA, staff);
    const { threadId, messageId } = await openWith(tenantA, staff, [id]);
    const as = (userId: UserId) =>
      withMember(db, { tenantId: tenantA, userId }, (tx) => listSupportScreenshots(tx, threadId));
    expect((await as(staff)).map((row) => [row.id, row.messageId])).toEqual([[id, messageId]]);
    expect((await as(owner)).map((row) => row.id)).toEqual([id]);
    expect(await as(otherStaff)).toEqual([]);
    expect(
      await withMember(db, { tenantId: tenantA, userId: otherStaff }, (tx) =>
        findSupportScreenshot(tx, id),
      ),
    ).toBeUndefined();
    const listed = await withMember(db, { tenantId: tenantA, userId: owner }, (tx) =>
      listSupportThreads(tx, { reader: owner, limit: 200 }),
    );
    expect(listed.find((thread) => thread.id === threadId)?.screenshotCount).toBe(1);
  });
});

describe('attaching (AC-X-27)', () => {
  it('attaches only the uploader’s own unsent ones, once', async () => {
    const mine = await upload(tenantA, staff);
    const theirs = await upload(tenantA, otherStaff);
    const { threadId } = await openWith(tenantA, staff, [mine, theirs]);
    const attached = await withTenant(db, tenantA, (tx) => listSupportScreenshots(tx, threadId));
    expect(attached.map((row) => row.id)).toEqual([mine]);
    // Already sent: not attachable again, to this thread or another.
    const again = await withMember(db, { tenantId: tenantA, userId: staff }, (tx) =>
      lockAttachableSupportScreenshots(tx, staff, [mine]),
    );
    expect(again).toEqual([]);
  });

  it('a sent screenshot never changes and can’t be deleted on its own', async () => {
    const id = await upload(tenantA, staff);
    const { threadId } = await openWith(tenantA, staff, [id]);
    const other = await openWith(tenantA, staff, []);
    const moved = await withTenant(db, tenantA, (tx) =>
      tx.execute(
        sql`UPDATE support_screenshots SET thread_id = ${other.threadId}, message_id = ${other.messageId} WHERE id = ${id}`,
      ),
    ).catch((error: unknown) => error);
    expect(sqlState(moved)).toBe('42501');
    const discarded = await withTenant(db, tenantA, (tx) =>
      tx.execute(sql`UPDATE support_screenshots SET discarded_at = now() WHERE id = ${id}`),
    ).catch((error: unknown) => error);
    expect(sqlState(discarded)).toBe('42501');
    const deleted = await withTenant(db, tenantA, (tx) =>
      tx.execute(sql`DELETE FROM support_screenshots WHERE id = ${id}`),
    );
    expect(deleted.rowCount).toBe(0);
    expect(
      (await withTenant(db, tenantA, (tx) => listSupportScreenshots(tx, threadId))).map(
        (row) => row.id,
      ),
    ).toEqual([id]);
  });

  it('a discarded one can’t be attached, and still counts against the day', async () => {
    const since = new Date(Date.now() - 1000);
    const id = await upload(tenantA, otherStaff);
    const as = <T>(work: (tx: TenantTx) => Promise<T>) =>
      withMember(db, { tenantId: tenantA, userId: otherStaff }, work);
    expect((await as((tx) => discardSupportScreenshot(tx, otherStaff, id, new Date())))?.id).toBe(
      id,
    );
    expect(
      await as((tx) => discardSupportScreenshot(tx, otherStaff, id, new Date())),
    ).toBeUndefined();
    expect(await as((tx) => findSupportScreenshot(tx, id))).toBeUndefined();
    expect(await as((tx) => lockAttachableSupportScreenshots(tx, otherStaff, [id]))).toEqual([]);
    expect(
      await as((tx) => countSupportScreenshotUploads(tx, otherStaff, since)),
    ).toBeGreaterThanOrEqual(1);
    // Someone else can't discard it for them.
    const another = await upload(tenantA, otherStaff);
    expect(
      await withMember(db, { tenantId: tenantA, userId: owner }, (tx) =>
        discardSupportScreenshot(tx, owner, another, new Date()),
      ),
    ).toBeUndefined();
  });
});

describe('the console (AC-X-30)', () => {
  it('an operator reads sent screenshots only in a logged transaction, and the inbox counts them', async () => {
    const first = await upload(tenantB, owner);
    const second = await upload(tenantB, owner);
    const unsent = await upload(tenantB, owner);
    const { threadId } = await openWith(tenantB, owner, [first, second]);
    const read = await withOperator(
      db,
      { operatorUserId: operator, action: 'screenshot.read', targetId: first },
      async (tx) => ({
        first: await findSupportScreenshot(tx, first),
        unsent: await findSupportScreenshot(tx, unsent),
      }),
    );
    expect(read.first?.tenantId).toBe(tenantB);
    expect(read.unsent).toBeUndefined();
    const logged = await asAdmin<{ count: number }>(
      "SELECT count(*)::int AS count FROM operator_access_log WHERE action = 'screenshot.read' AND target_id = $1",
      [first],
    );
    expect(logged[0]?.count).toBe(1);
    // Outside an operator transaction, nothing.
    expect(await db.transaction((tx) => findSupportScreenshot(tx, first))).toBeUndefined();
    const inbox = await withOperator(
      db,
      { operatorUserId: operator, action: 'inbox.read', targetId: null },
      (tx) => listOperatorThreads(tx, { statuses: ['waiting_on_pepper'], limit: 500 }),
    );
    expect(inbox.find((row) => row.id === threadId)?.screenshotCount).toBe(2);
  });
});

describe('the sweep, the export and the deletion (AC-X-28/31)', () => {
  it('the support job finds unsent uploads over a day old; deleting spares sent ones', async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const stale = await upload(tenantA, staff, old);
    const sentOld = await upload(tenantA, staff, old);
    await openWith(tenantA, staff, [sentOld]);
    const fresh = await upload(tenantA, staff);
    const before = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const found = await withJobScan(db, 'support', (tx) =>
      listStaleSupportScreenshots(tx, before, 1000),
    );
    const ids = found.map((row) => row.id);
    expect(ids).toContain(stale);
    expect(ids).not.toContain(sentOld);
    expect(ids).not.toContain(fresh);
    const deleted = await withTenant(db, tenantA, (tx) =>
      deleteStaleSupportScreenshots(tx, [stale, sentOld, fresh], before),
    );
    expect(deleted.map((row) => row.id)).toEqual([stale]);
  });

  it('the export lists sent ones only; the business’s deletion takes every row', async () => {
    const tenant = TenantIdSchema.parse(
      (await createTenant(db, { name: 'Gone C', slug: 'shot-c', timeZone: 'America/Denver' })).id,
    );
    const user = await insertUser(db, 'Gus Gone');
    await withTenant(db, tenant, (tx) => addMembership(tx, { userId: user, role: 'owner' }));
    const sent = await upload(tenant, user);
    const unsent = await upload(tenant, user);
    await openWith(tenant, user, [sent]);
    const exported = await withTenant(db, tenant, listSupportScreenshotsForExport);
    expect(exported.map((row) => row.id)).toEqual([sent]);
    const all = await withTenant(db, tenant, listAllSupportScreenshots);
    expect(all.map((row) => row.id).sort()).toEqual([sent, unsent].sort());
    const deleted = await withTenant(db, tenant, async (tx) => {
      await scheduleCurrentTenantDeletion(tx, new Date(Date.now() - 1000));
      return deleteCurrentTenantIfDue(tx, new Date());
    });
    expect(deleted).toBe(true);
    const left = await asAdmin<{ count: number }>(
      'SELECT count(*)::int AS count FROM support_screenshots WHERE tenant_id = $1',
      [tenant],
    );
    expect(left[0]?.count).toBe(0);
  });
});

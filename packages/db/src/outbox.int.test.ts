import {
  OutboxMessageIdSchema,
  TenantIdSchema,
  type OutboxMessageId,
  type TenantId,
} from '@pepper/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database, type DatabaseHandle } from './client.js';
import { newId } from './ids.js';
import {
  claimOutboxMessage,
  findOutboxMessage,
  insertOutboxMessage,
  listDueOutboxMessages,
  markOutboxMessageFailed,
  markOutboxMessageSent,
  type NewOutboxMessage,
} from './repositories/outbox.js';
import { createTenant } from './repositories/tenants.js';
import { outboxDispatch } from './schema.js';
import { withTenant } from './tenant.js';
import { sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

// The outbox repository against real Postgres (ADR-0024). The isolation of `outbox_messages`
// and the classification of `outbox_dispatch` are in isolation.int.test.ts.

let database: TestDatabase;
let db: Database;
/** The schema owner, for looking behind RLS and deleting a business. */
let owner: DatabaseHandle;
let tenant: TenantId;
let other: TenantId;

const T0 = new Date('2026-10-20T15:00:00Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
let keys = 0;

function message(overrides: Partial<NewOutboxMessage> = {}): NewOutboxMessage {
  keys += 1;
  return {
    id: OutboxMessageIdSchema.parse(newId()),
    type: 'email',
    dedupeKey: `test.message:${String(keys)}`,
    payload: Buffer.from('ciphertext'),
    availableAt: T0,
    ...overrides,
  };
}

async function queue(
  tenantId: TenantId,
  overrides: Partial<NewOutboxMessage> = {},
): Promise<OutboxMessageId> {
  const row = await withTenant(db, tenantId, (tx) => insertOutboxMessage(tx, message(overrides)));
  if (row === undefined) throw new Error('not queued');
  return OutboxMessageIdSchema.parse(row.id);
}

/** The message's dispatch row, as its business sees it. */
async function dispatchRow(id: OutboxMessageId, tenantId: TenantId = tenant) {
  const [row] = await withTenant(db, tenantId, (tx) =>
    tx
      .select({ tenant_id: outboxDispatch.tenantId, available_at: outboxDispatch.availableAt })
      .from(outboxDispatch)
      .where(eq(outboxDispatch.id, id)),
  );
  return row;
}

const find = (tenantId: TenantId, id: OutboxMessageId) =>
  withTenant(db, tenantId, (tx) => findOutboxMessage(tx, id));

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  owner = createDatabase({ url: database.migrationUrl, maxConnections: 1 });
  const a = await createTenant(db, { name: 'Plum', slug: 'plum', timeZone: 'America/Chicago' });
  const b = await createTenant(db, { name: 'Fig', slug: 'fig', timeZone: 'America/New_York' });
  tenant = TenantIdSchema.parse(a.id);
  other = TenantIdSchema.parse(b.id);
});

afterAll(async () => {
  await owner.close();
  await database.stop();
});

async function clearDispatch(): Promise<void> {
  // Due rows from earlier tests would crowd the listings below.
  await owner.db.execute(sql`DELETE FROM outbox_dispatch`);
}

describe('queueing', () => {
  it('stores a pending message of the tenant with its dispatch row', async () => {
    const id = await queue(tenant, { availableAt: at(30) });
    const row = await find(tenant, id);
    expect(row).toMatchObject({
      tenantId: tenant,
      type: 'email',
      status: 'pending',
      attempts: 0,
      leaseUntil: null,
      lastError: null,
      sentAt: null,
    });
    expect(row?.payload?.toString()).toBe('ciphertext');
    expect(await dispatchRow(id)).toEqual({ tenant_id: tenant, available_at: at(30) });
    expect(await dispatchRow(id, other)).toBeUndefined();
  });

  it('queues nothing for a dedupe key the business already used', async () => {
    const first = message({ dedupeKey: 'booking.confirmed:dup' });
    await withTenant(db, tenant, (tx) => insertOutboxMessage(tx, first));
    const again = await withTenant(db, tenant, (tx) =>
      insertOutboxMessage(tx, message({ dedupeKey: 'booking.confirmed:dup' })),
    );
    expect(again).toBeUndefined();
    // Another business may use the same key.
    const elsewhere = await withTenant(db, other, (tx) =>
      insertOutboxMessage(tx, message({ dedupeKey: 'booking.confirmed:dup' })),
    );
    expect(elsewhere?.tenantId).toBe(other);
  });

  it('rejects a dedupe key with anything but the allowed characters', async () => {
    await expect(
      withTenant(db, tenant, (tx) =>
        insertOutboxMessage(tx, message({ dedupeKey: 'ana@example.com' })),
      ),
    ).rejects.toThrow();
  });

  it('keeps the content only while pending, by constraint', async () => {
    const id = await queue(tenant);
    const error = await withTenant(db, tenant, (tx) =>
      tx.execute(sql`UPDATE outbox_messages SET payload = NULL WHERE id = ${id}`),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514');
  });
});

describe('finding due messages', () => {
  it('lists due messages across businesses, the longest waiting first, up to the limit', async () => {
    await clearDispatch();
    const late = await queue(tenant, { availableAt: at(-10) });
    const early = await queue(other, { availableAt: at(-60) });
    await queue(tenant, { availableAt: at(60) });
    expect(await listDueOutboxMessages(db, T0, 10)).toEqual([
      { messageId: early, tenantId: other },
      { messageId: late, tenantId: tenant },
    ]);
    expect(await listDueOutboxMessages(db, T0, 1)).toEqual([{ messageId: early, tenantId: other }]);
  });
});

describe('claiming', () => {
  it('claims a due message once per lease and counts the attempt', async () => {
    const id = await queue(tenant);
    const claimed = await withTenant(db, tenant, (tx) => claimOutboxMessage(tx, id, T0, at(300)));
    expect(claimed).toMatchObject({ attempts: 1, leaseUntil: at(300) });
    expect((await dispatchRow(id))?.available_at).toEqual(at(300));
    // Leased: nobody else gets it until the lease ends.
    expect(
      await withTenant(db, tenant, (tx) => claimOutboxMessage(tx, id, at(299), at(600))),
    ).toBeUndefined();
    // A worker that died: due again when the lease ends.
    const reclaimed = await withTenant(db, tenant, (tx) =>
      claimOutboxMessage(tx, id, at(300), at(600)),
    );
    expect(reclaimed?.attempts).toBe(2);
  });

  it('gives one claim to concurrent workers', async () => {
    const id = await queue(tenant);
    const claims = await Promise.all(
      Array.from({ length: 5 }, () =>
        withTenant(db, tenant, (tx) => claimOutboxMessage(tx, id, T0, at(300))),
      ),
    );
    expect(claims.filter((c) => c !== undefined)).toHaveLength(1);
  });

  it('does not claim a message before it is due', async () => {
    const id = await queue(tenant, { availableAt: at(60) });
    expect(
      await withTenant(db, tenant, (tx) => claimOutboxMessage(tx, id, T0, at(300))),
    ).toBeUndefined();
  });

  it("does not reach another business's message", async () => {
    const id = await queue(other);
    expect(
      await withTenant(db, tenant, (tx) => claimOutboxMessage(tx, id, T0, at(300))),
    ).toBeUndefined();
    expect(await find(tenant, id)).toBeUndefined();
    expect(await withTenant(db, tenant, (tx) => markOutboxMessageSent(tx, id, T0))).toBe(false);
    expect((await find(other, id))?.status).toBe('pending');
  });
});

describe('finishing', () => {
  it('marks a message sent once, clears its content and its dispatch row', async () => {
    const id = await queue(tenant);
    await withTenant(db, tenant, (tx) => claimOutboxMessage(tx, id, T0, at(300)));
    expect(await withTenant(db, tenant, (tx) => markOutboxMessageSent(tx, id, at(5)))).toBe(true);
    expect(await find(tenant, id)).toMatchObject({
      status: 'sent',
      payload: null,
      leaseUntil: null,
      sentAt: at(5),
    });
    expect(await dispatchRow(id)).toBeUndefined();
    expect(await withTenant(db, tenant, (tx) => markOutboxMessageSent(tx, id, at(9)))).toBe(false);
    expect(
      await withTenant(db, tenant, (tx) => claimOutboxMessage(tx, id, at(999), at(1999))),
    ).toBeUndefined();
  });

  it('schedules a retry after a failure, keeping only the error name', async () => {
    const id = await queue(tenant);
    await withTenant(db, tenant, (tx) => claimOutboxMessage(tx, id, T0, at(300)));
    const retried = await withTenant(db, tenant, (tx) =>
      markOutboxMessageFailed(tx, id, { errorName: 'Error: ana@example.com', retryAt: at(30) }),
    );
    expect(retried).toBe(true);
    const row = await find(tenant, id);
    expect(row).toMatchObject({ status: 'pending', leaseUntil: null, availableAt: at(30) });
    expect(row?.lastError).toBe('Error:anaexample.com');
    expect((await dispatchRow(id))?.available_at).toEqual(at(30));
    expect(
      await withTenant(db, tenant, (tx) => claimOutboxMessage(tx, id, at(30), at(330))),
    ).toMatchObject({ attempts: 2 });
  });

  it('gives up a message: dead, content cleared, no longer dispatched', async () => {
    const id = await queue(tenant);
    await withTenant(db, tenant, (tx) => claimOutboxMessage(tx, id, T0, at(300)));
    expect(
      await withTenant(db, tenant, (tx) =>
        markOutboxMessageFailed(tx, id, { errorName: 'ECONNREFUSED', retryAt: null }),
      ),
    ).toBe(true);
    expect(await find(tenant, id)).toMatchObject({
      status: 'dead',
      payload: null,
      lastError: 'ECONNREFUSED',
      sentAt: null,
    });
    expect(await dispatchRow(id)).toBeUndefined();
    expect(
      await withTenant(db, tenant, (tx) =>
        markOutboxMessageFailed(tx, id, { errorName: 'Error', retryAt: at(60) }),
      ),
    ).toBe(false);
  });

  it('drops dispatch rows with their business', async () => {
    const gone = await createTenant(db, { name: 'Gone', slug: 'gone', timeZone: 'UTC' });
    const goneId = TenantIdSchema.parse(gone.id);
    const id = await queue(goneId, { availableAt: at(-3600) });
    await owner.db.execute(sql`DELETE FROM tenants WHERE id = ${gone.id}`);
    const due = await listDueOutboxMessages(db, T0, 1000);
    expect(due.map((d) => d.messageId)).not.toContain(id);
  });
});

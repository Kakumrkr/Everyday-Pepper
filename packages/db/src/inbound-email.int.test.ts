// Replies by email (S59.3, ADR-0063, AC-X-33/35): inbound rows are reachable only in the inbound
// context, stored once per event, email and `Message-ID`, taken under a lease, kept by the
// services (no delete), and found from a request's reference only through the definer function.
// Part of the isolation evidence with isolation.int.test.ts.
import { TenantIdSchema, type TenantId, type UserId } from '@pepper/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { addMembership } from './repositories/memberships.js';
import {
  claimInboundEmails,
  countInboundLanded,
  emptyHeldInboundEmails,
  failInboundEmailsPastAttempts,
  findInboundEmail,
  findSupportThreadForInbound,
  finishInboundEmail,
  insertInboundEmail,
  lockReceivedInboundEmail,
} from './repositories/inbound-email.js';
import { appendSupportMessage, insertSupportThread } from './repositories/support.js';
import { createTenant } from './repositories/tenants.js';
import { inboundEmails } from './schema.js';
import { setTransactionInboundMail, withInboundMail, withMember, withTenant } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

let database: TestDatabase;
let db: Database;
let tenant: TenantId;
let owner: UserId;
let threadId: string;
const REFERENCE = 'PEP-7K2M9Q';
const T0 = new Date('2026-11-08T10:00:00Z');

let counter = 0;
function event(overrides: Partial<Parameters<typeof insertInboundEmail>[1]> = {}) {
  counter += 1;
  return {
    provider: 'resend' as const,
    eventId: `msg_${String(counter)}`,
    providerEmailId: `email_${String(counter)}`,
    messageId: `<m${String(counter)}@mail.example.test>`,
    receivedAt: new Date(T0.getTime() + counter * 1000),
    ...overrides,
  };
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  tenant = TenantIdSchema.parse(
    (await createTenant(db, { name: 'Salon In', slug: 'inbound-a', timeZone: 'UTC' })).id,
  );
  owner = await insertUser(db, 'Olga Owner');
  await withTenant(db, tenant, (tx) => addMembership(tx, { userId: owner, role: 'owner' }));
  const thread = await withMember(db, { tenantId: tenant, userId: owner }, (tx) =>
    insertSupportThread(tx, {
      reference: REFERENCE,
      kind: 'problem',
      openedByUserId: owner,
      context: { appVersion: 'test' },
      body: 'The calendar is empty',
      now: T0,
    }),
  );
  if (thread === null) throw new Error('reference taken');
  threadId = thread.id;
});

afterAll(async () => {
  await database.stop();
});

describe('inbound emails (S59.3, ADR-0063)', () => {
  it('stores an email once: the same event, provider email or Message-ID again is nothing', async () => {
    const first = event();
    const stored = await withInboundMail(db, (tx) => insertInboundEmail(tx, first));
    expect(stored?.id).toBeDefined();
    await withInboundMail(db, async (tx) => {
      expect(await insertInboundEmail(tx, { ...event(), eventId: first.eventId })).toBeUndefined();
      expect(
        await insertInboundEmail(tx, { ...event(), providerEmailId: first.providerEmailId }),
      ).toBeUndefined();
      expect(
        await insertInboundEmail(tx, { ...event(), messageId: first.messageId }),
      ).toBeUndefined();
      // No Message-ID: never a duplicate by it.
      expect(await insertInboundEmail(tx, event({ messageId: null }))).toBeDefined();
      expect(await insertInboundEmail(tx, event({ messageId: null }))).toBeDefined();
    });
  });

  it('is unreachable outside the inbound context, even in a business transaction', async () => {
    await withInboundMail(db, (tx) => insertInboundEmail(tx, event()));
    const seen = await withTenant(db, tenant, (tx) =>
      tx.select({ id: inboundEmails.id }).from(inboundEmails),
    );
    expect(seen).toEqual([]);
    const plain = await db.select({ id: inboundEmails.id }).from(inboundEmails);
    expect(plain).toEqual([]);
    const refused = await withTenant(db, tenant, (tx) => insertInboundEmail(tx, event())).catch(
      (error: unknown) => error,
    );
    expect(sqlState(refused)).toBe('42501');
    // Inside a business's transaction that names the context too: reachable (the job lands and
    // records a reply together).
    const together = await withTenant(db, tenant, async (tx) => {
      await setTransactionInboundMail(tx);
      return tx.select({ id: inboundEmails.id }).from(inboundEmails);
    });
    expect(together.length).toBeGreaterThan(0);
  });

  it('keeps every row for the services: no delete, no truncate', async () => {
    const deleted = await withInboundMail(db, (tx) =>
      tx.execute(sql`DELETE FROM inbound_emails`),
    ).catch((error: unknown) => error);
    expect(sqlState(deleted)).toBe('42501');
  });

  it('takes received emails oldest first under a lease, and a second pass skips them', async () => {
    await withInboundMail(db, (tx) =>
      tx.execute(
        sql`UPDATE inbound_emails SET status = 'ignored', reason = 'test', processed_at = now()`,
      ),
    );
    const a = await withInboundMail(db, (tx) => insertInboundEmail(tx, event()));
    const b = await withInboundMail(db, (tx) => insertInboundEmail(tx, event()));
    const now = new Date(T0.getTime() + 3_600_000);
    const take = () =>
      withInboundMail(db, (tx) =>
        claimInboundEmails(tx, { now, leaseMs: 60_000, limit: 10, maxAttempts: 5 }),
      );
    const [first, second] = await Promise.all([take(), take()]);
    const taken = [...(first ?? []), ...(second ?? [])].map((row) => row.id).sort();
    expect(taken).toEqual([a?.id, b?.id].sort());
    expect([...(first ?? []), ...(second ?? [])].every((row) => row.attempts === 1)).toBe(true);
    // The lease ends: taken again, a second attempt.
    const later = await withInboundMail(db, (tx) =>
      claimInboundEmails(tx, {
        now: new Date(now.getTime() + 61_000),
        leaseMs: 60_000,
        limit: 10,
        maxAttempts: 5,
      }),
    );
    expect(later.map((row) => row.attempts)).toEqual([2, 2]);
  });

  it('gives up after the last attempt, once its lease ends', async () => {
    const row = await withInboundMail(db, (tx) => insertInboundEmail(tx, event()));
    const id = row?.id ?? '';
    await withInboundMail(db, (tx) =>
      tx.execute(sql`UPDATE inbound_emails SET attempts = 5, lease_until = NULL WHERE id = ${id}`),
    );
    const failed = await withInboundMail(db, (tx) =>
      failInboundEmailsPastAttempts(tx, { now: new Date(), maxAttempts: 5 }),
    );
    expect(failed).toBeGreaterThanOrEqual(1);
    const stored = await withInboundMail(db, (tx) => findInboundEmail(tx, id));
    expect(stored).toMatchObject({ status: 'failed', reason: 'gave_up' });
    expect(await withInboundMail(db, (tx) => lockReceivedInboundEmail(tx, id))).toBeUndefined();
  });

  it('records a landed reply with its message and counts it for the loop guard', async () => {
    const row = await withInboundMail(db, (tx) => insertInboundEmail(tx, event()));
    const id = row?.id ?? '';
    const messageId = await withMember(db, { tenantId: tenant, userId: owner }, async (tx) => {
      const written = await appendSupportMessage(tx, {
        threadId,
        author: { kind: 'member', userId: owner },
        body: 'By email',
        status: 'waiting_on_pepper',
        now: T0,
        channel: 'email',
      });
      return written.id;
    });
    const processedAt = new Date();
    await withInboundMail(db, (tx) =>
      finishInboundEmail(
        tx,
        id,
        { status: 'landed', tenantId: tenant, threadId, supportMessageId: messageId },
        processedAt,
      ),
    );
    const count = await withInboundMail(db, (tx) =>
      countInboundLanded(tx, {
        tenantId: tenant,
        threadId,
        since: new Date(processedAt.getTime() - 60_000),
      }),
    );
    expect(count).toBe(1);
    const channel = await withTenant(db, tenant, (tx) =>
      tx.execute<{ channel: string }>(
        sql`SELECT channel FROM support_messages WHERE id = ${messageId}`,
      ),
    );
    expect(channel.rows[0]?.channel).toBe('email');
  });

  it('refuses an email channel on the team’s message, and contents on anything but a held one', async () => {
    const team = await withTenant(db, tenant, (tx) =>
      appendSupportMessage(tx, {
        threadId,
        author: { kind: 'pepper' },
        body: 'Hi',
        status: 'pepper_replied',
        now: T0,
        channel: 'email',
      }),
    ).catch((error: unknown) => error);
    expect(sqlState(team)).toBe('23514');
    const row = await withInboundMail(db, (tx) => insertInboundEmail(tx, event()));
    const stray = await withInboundMail(db, (tx) =>
      tx.execute(
        sql`UPDATE inbound_emails SET held_text = 'x', status = 'ignored' WHERE id = ${row?.id ?? ''}`,
      ),
    ).catch((error: unknown) => error);
    expect(sqlState(stray)).toBe('23514');
  });

  it('empties a held reply’s sender and text once it is older than the cut-off', async () => {
    const row = await withInboundMail(db, (tx) => insertInboundEmail(tx, event()));
    const id = row?.id ?? '';
    const heldAt = new Date('2026-11-01T10:00:00Z');
    await withInboundMail(db, (tx) =>
      finishInboundEmail(
        tx,
        id,
        {
          status: 'held',
          reason: 'unknown_sender',
          tenantId: tenant,
          threadId,
          fromAddress: 'someone@else.test',
          heldText: 'Forwarded to you',
        },
        heldAt,
      ),
    );
    expect(
      await withInboundMail(db, (tx) =>
        emptyHeldInboundEmails(tx, new Date('2026-11-01T09:59:59Z')),
      ),
    ).toBe(0);
    expect(
      await withInboundMail(db, (tx) =>
        emptyHeldInboundEmails(tx, new Date('2026-11-01T10:00:01Z')),
      ),
    ).toBe(1);
    expect(await withInboundMail(db, (tx) => findInboundEmail(tx, id))).toMatchObject({
      status: 'held',
      fromAddress: null,
      heldText: null,
    });
  });

  it('finds a request from its reference only through the definer function', async () => {
    expect(await findSupportThreadForInbound(db, REFERENCE)).toEqual({
      tenantId: tenant,
      threadId,
    });
    expect(await findSupportThreadForInbound(db, 'PEP-000000')).toBeUndefined();
    await expect(findSupportThreadForInbound(db, "PEP-' OR 1=1")).rejects.toThrow();
    // The services' role itself still reads no thread without a business.
    const direct = await db.execute(sql`SELECT id FROM support_threads`);
    expect(direct.rows).toEqual([]);
  });

  it('goes with its business', async () => {
    const other = TenantIdSchema.parse(
      (await createTenant(db, { name: 'Gone', slug: 'inbound-gone', timeZone: 'UTC' })).id,
    );
    const row = await withInboundMail(db, (tx) => insertInboundEmail(tx, event()));
    await withInboundMail(db, (tx) =>
      finishInboundEmail(
        tx,
        row?.id ?? '',
        { status: 'ignored', reason: 'auto_reply', tenantId: other },
        new Date(),
      ),
    );
    const client = new (await import('pg')).default.Client({
      connectionString: database.migrationUrl,
    });
    await client.connect();
    try {
      await client.query('DELETE FROM tenants WHERE id = $1', [other]);
    } finally {
      await client.end();
    }
    expect(await withInboundMail(db, (tx) => findInboundEmail(tx, row?.id ?? ''))).toBeUndefined();
  });
});

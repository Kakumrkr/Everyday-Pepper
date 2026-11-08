// Replies by email (S59.3, ADR-0063, AC-X-33/35): inbound rows are reachable only in the inbound
// context, stored once per event, email and `Message-ID`, taken under a lease, kept by the
// services (no delete), and found from a request's reference only through the definer function.
// Part of the isolation evidence with isolation.int.test.ts.
import { TenantIdSchema, type TenantId, type UserId } from '@pepper/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { addMembership } from './repositories/memberships.js';
import { grantOperator } from './operators.js';
import {
  acceptHeldInboundEmail,
  claimInboundEmails,
  countHeldInboundEmails,
  countInboundByOutcome,
  countInboundFromSender,
  countInboundLanded,
  discardHeldInboundEmail,
  findSupportMemberForInbound,
  listHeldInboundEmails,
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
import { inboundEmails, sessions, users } from './schema.js';
import {
  setTransactionInboundMail,
  withInboundMail,
  withMember,
  withOperator,
  withTenant,
} from './tenant.js';
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
    const taken = [...first, ...second].map((row) => row.id).sort();
    expect(taken).toEqual([a?.id, b?.id].sort());
    expect([...first, ...second].every((row) => row.attempts === 1)).toBe(true);
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

describe('inbound emails, part 2 (S59.3.2, ADR-0063 Part 2)', () => {
  const HASH = 'a'.repeat(64);

  async function verifiedUser(name: string): Promise<{ id: UserId; email: string }> {
    const id = await insertUser(db, name);
    const email = `${name.toLowerCase().replace(/[^a-z]/g, '')}-${id.slice(0, 8)}@example.test`;
    await db.update(users).set({ email, emailVerified: true }).where(eq(users.id, id));
    return { id, email };
  }

  async function business(slug: string, member: UserId): Promise<TenantId> {
    const id = TenantIdSchema.parse(
      (await createTenant(db, { name: slug, slug, timeZone: 'UTC' })).id,
    );
    await withTenant(db, id, (tx) => addMembership(tx, { userId: member, role: 'owner' }));
    return id;
  }

  async function held(
    outcome: { tenantId: string | null; threadId: string | null; subject?: string },
    at = new Date(),
  ): Promise<string> {
    const row = await withInboundMail(db, (tx) => insertInboundEmail(tx, event()));
    const id = row?.id ?? '';
    await withInboundMail(db, (tx) =>
      finishInboundEmail(
        tx,
        id,
        {
          status: 'held',
          reason: outcome.tenantId === null ? 'unverified_sender' : 'unknown_sender',
          tenantId: outcome.tenantId,
          threadId: outcome.threadId,
          fromAddress: 'stranger@else.test',
          heldText: 'Hello <b>team</b>',
          heldSubject: outcome.subject ?? null,
        },
        at,
        HASH,
      ),
    );
    return id;
  }

  it('finds the business of a verified member: their latest session’s choice, else the first joined', async () => {
    const solo = await verifiedUser('Sam Solo');
    const first = await business('member-first', solo.id);
    expect(await findSupportMemberForInbound(db, solo.email.toUpperCase())).toEqual({
      userId: solo.id,
      tenantId: first,
      businesses: 1,
    });
    const second = await business('member-second', solo.id);
    expect((await findSupportMemberForInbound(db, solo.email))?.tenantId).toBe(first);
    const older = newSession(solo.id, first, new Date('2026-11-01T00:00:00Z'));
    const newer = newSession(solo.id, second, new Date('2026-11-07T00:00:00Z'));
    await db.insert(sessions).values([older, newer]);
    expect(await findSupportMemberForInbound(db, solo.email)).toEqual({
      userId: solo.id,
      tenantId: second,
      businesses: 2,
    });
  });

  it('finds no one for an unverified, unknown or departing address, and no one with bad input', async () => {
    const unverified = await insertUser(db, 'Una Verified');
    const [row] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, unverified));
    await business('member-unverified', unverified);
    expect(await findSupportMemberForInbound(db, row?.email ?? '')).toBeUndefined();
    expect(await findSupportMemberForInbound(db, 'nobody@example.test')).toBeUndefined();
    const leaving = await verifiedUser('Lea Ving');
    await business('member-leaving', leaving.id);
    await db.update(users).set({ deletionDueAt: new Date() }).where(eq(users.id, leaving.id));
    expect(await findSupportMemberForInbound(db, leaving.email)).toBeUndefined();
    const noBusiness = await verifiedUser('Nob Usiness');
    expect(await findSupportMemberForInbound(db, noBusiness.email)).toBeUndefined();
    await expect(findSupportMemberForInbound(db, 'x')).rejects.toThrow();
  });

  it('keeps a stranger’s held email without a business, and its subject only while held', async () => {
    const id = await held({ tenantId: null, threadId: null, subject: 'Can’t sign in' });
    expect(await withInboundMail(db, (tx) => findInboundEmail(tx, id))).toMatchObject({
      status: 'held',
      tenantId: null,
      heldSubject: 'Can’t sign in',
      senderHash: HASH,
    });
    const stray = await withInboundMail(db, (tx) =>
      tx.execute(sql`UPDATE inbound_emails SET status = 'ignored' WHERE id = ${id}`),
    ).catch((error: unknown) => error);
    expect(sqlState(stray)).toBe('23514');
  });

  it('counts a sender’s recent emails for the loop guard', async () => {
    const since = new Date(Date.now() - 60_000);
    const before = await withInboundMail(db, (tx) =>
      countInboundFromSender(tx, { senderHash: HASH, since }),
    );
    await held({ tenantId: null, threadId: null });
    expect(
      await withInboundMail(db, (tx) => countInboundFromSender(tx, { senderHash: HASH, since })),
    ).toBe(before + 1);
    expect(
      await withInboundMail(db, (tx) =>
        countInboundFromSender(tx, { senderHash: 'b'.repeat(64), since }),
      ),
    ).toBe(0);
  });

  it('lets a logged operator list, count, accept and discard held mail, and nothing else', async () => {
    const operator = await verifiedUser('Otto Operator');
    expect(
      await grantOperator(database.migrationUrl, { email: operator.email, note: 'tests' }),
    ).toBe('granted');
    const reply = await held({ tenantId: tenant, threadId }, new Date(T0.getTime() - 3_600_000));
    const stranger = await held({ tenantId: null, threadId: null, subject: 'Hi' }, T0);
    const as = (action: 'held.read' | 'held.accept' | 'held.discard', targetId: string | null) =>
      ({ operatorUserId: operator.id, action, targetId }) as const;
    const list = await withOperator(db, as('held.read', null), async (tx) => ({
      rows: await listHeldInboundEmails(tx, { limit: 50 }),
      count: await countHeldInboundEmails(tx),
    }));
    const ids = list.rows.map((row) => row.id);
    expect(ids).toContain(reply);
    expect(ids).toContain(stranger);
    expect(ids.indexOf(reply)).toBeLessThan(ids.indexOf(stranger));
    expect(list.count).toBe(list.rows.length);
    expect(list.rows.find((row) => row.id === stranger)).toMatchObject({
      tenantId: null,
      fromAddress: 'stranger@else.test',
      subject: 'Hi',
      text: 'Hello <b>team</b>',
    });

    const now = new Date();
    expect(
      await withOperator(db, as('held.accept', reply), (tx) =>
        acceptHeldInboundEmail(tx, { id: reply, operatorUserId: operator.id, now }),
      ),
    ).toBe(true);
    // Back to the inbound job, emptied, with the operator's word.
    const accepted = await withInboundMail(db, (tx) => findInboundEmail(tx, reply));
    expect(accepted).toMatchObject({
      status: 'received',
      attempts: 0,
      fromAddress: null,
      heldText: null,
      acceptedBy: operator.id,
    });
    const [claimed] = await withInboundMail(db, (tx) =>
      claimInboundEmails(tx, { now: new Date(), leaseMs: 60_000, limit: 100, maxAttempts: 5 }),
    ).then((rows) => rows.filter((row) => row.id === reply));
    expect(claimed?.acceptedBy).toBe(operator.id);
    // Once reviewed, never again.
    expect(
      await withOperator(db, as('held.accept', reply), (tx) =>
        acceptHeldInboundEmail(tx, { id: reply, operatorUserId: operator.id, now }),
      ),
    ).toBe(false);
    expect(
      await withOperator(db, as('held.discard', stranger), (tx) =>
        discardHeldInboundEmail(tx, { id: stranger, now }),
      ),
    ).toBe(true);
    expect(await withInboundMail(db, (tx) => findInboundEmail(tx, stranger))).toMatchObject({
      status: 'ignored',
      reason: 'discarded',
      fromAddress: null,
      heldText: null,
      heldSubject: null,
    });
    // An operator moves held rows only; landed or received ones stay put.
    const other = await withOperator(db, as('held.read', null), (tx) =>
      tx.execute(sql`UPDATE inbound_emails SET reason = 'x' WHERE id = ${reply}`),
    );
    expect(other.rowCount).toBe(0);
    // The access log has each one, in its transaction.
    const client = new (await import('pg')).default.Client({
      connectionString: database.migrationUrl,
    });
    await client.connect();
    try {
      const log = await client.query<{ action: string; target_id: string | null }>(
        'SELECT action, target_id FROM operator_access_log WHERE operator_user_id = $1 ORDER BY created_at',
        [operator.id],
      );
      expect(log.rows.map((row) => row.action)).toEqual([
        'held.read',
        'held.accept',
        'held.accept',
        'held.discard',
        'held.read',
      ]);
    } finally {
      await client.end();
    }
  });

  it('shows held mail to no one but a logged operator', async () => {
    await held({ tenantId: tenant, threadId });
    expect(await withTenant(db, tenant, (tx) => countHeldInboundEmails(tx))).toBe(0);
    expect(await db.transaction((tx) => countHeldInboundEmails(tx))).toBe(0);
    const write = await withTenant(db, tenant, (tx) =>
      tx.execute(sql`UPDATE inbound_emails SET status = 'received' WHERE status = 'held'`),
    );
    expect(write.rowCount).toBe(0);
  });

  it('counts inbound mail by outcome and reason', async () => {
    const counts = await withInboundMail(db, (tx) => countInboundByOutcome(tx, new Date(0)));
    const held = counts.filter((row) => row.status === 'held');
    expect(held.length).toBeGreaterThan(0);
    expect(
      counts.find((row) => row.status === 'ignored' && row.reason === 'discarded')?.count,
    ).toBe(1);
    expect(
      await withInboundMail(db, (tx) => countInboundByOutcome(tx, new Date('2100-01-01'))),
    ).toEqual([]);
  });
});

function newSession(userId: UserId, activeTenantId: TenantId, updatedAt: Date) {
  const id = crypto.randomUUID();
  return {
    id,
    userId,
    token: `token-${id}`,
    expiresAt: new Date(Date.now() + 60_000),
    activeTenantId,
    createdAt: updatedAt,
    updatedAt,
  };
}

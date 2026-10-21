import {
  ActionExecutionIdSchema,
  ActionProposalIdSchema,
  OutboxMessageIdSchema,
  TenantIdSchema,
  type ActionExplanation,
  type OutboxMessageId,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import { addMembership } from './repositories/memberships.js';
import {
  cancelOutboxMessages,
  claimOutboxMessage,
  insertOutboxMessage,
  markOutboxMessageSent,
} from './repositories/outbox.js';
import { createTenant } from './repositories/tenants.js';
import {
  decideProposal,
  expirePendingProposals,
  findAutonomySettings,
  findExecutionByKey,
  findProposalByKey,
  insertExecution,
  insertProposal,
  listExecutions,
  listPendingProposals,
  lockExecution,
  lockPendingProposalFor,
  lockProposal,
  markExecutionUndone,
  saveAutonomySettings,
  type NewExecution,
  type NewProposal,
} from './repositories/trust.js';
import { withMember, withTenant, type TenantTx } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

// The trust layer's tables against real Postgres (ADR-0028): the staff scope, the database
// checks behind the contracts, the triggers that keep receipts unchanged, one pending proposal
// per target, and taking back outbox messages. Isolation between businesses is in
// isolation.int.test.ts; the decisions and their concurrency are in @pepper/core.

let database: TestDatabase;
let db: Database;
let tenant: TenantId;
// Ana owns the business, Jess and Ben are staff.
let ana: UserId;
let jess: UserId;
let ben: UserId;

const as = <T>(userId: UserId, work: (tx: TenantTx) => Promise<T>) =>
  withMember(db, { tenantId: tenant, userId }, work);
const inTenant = <T>(work: (tx: TenantTx) => Promise<T>) => withTenant(db, tenant, work);

const explanation: ActionExplanation = {
  requestMessageId: null,
  steps: [{ tool: 'get_booking', input: { bookingId: '0190f5b2-7c1a-7d3e-9a1b-2c3d4e5f6a7b' } }],
  facts: [],
  alternatives: [],
  untrustedContext: false,
  decision: { outcome: 'propose', reason: 'setting' },
};

function proposal(overrides: Partial<NewProposal> = {}): NewProposal {
  return {
    action: 'booking.cancel',
    tool: 'cancel_booking',
    targetKey: `booking:${newId()}`,
    idempotencyKey: `turn:${newId()}`,
    payload: { bookingId: newId(), notifyClient: true },
    preview: { status: { from: 'confirmed', to: 'cancelled' } },
    fingerprint: 'b'.repeat(64),
    explanation,
    requestedBy: ana,
    recordOwner: null,
    expiresAt: new Date(Date.now() + 86_400_000),
    ...overrides,
  };
}

function execution(overrides: Partial<NewExecution> = {}): NewExecution {
  return {
    proposalId: null,
    action: 'booking.move',
    tool: 'move_booking',
    outcome: 'execute_and_notify',
    idempotencyKey: `turn:${newId()}`,
    entity: { type: 'booking', id: newId() },
    before: { startsAt: '2026-10-23T15:00:00.000Z' },
    after: { startsAt: '2026-10-23T16:00:00.000Z' },
    undo: { inverse: { startsAt: '2026-10-23T15:00:00.000Z' }, until: new Date('2026-10-24') },
    explanation: { ...explanation, decision: { outcome: 'execute_and_notify', reason: 'setting' } },
    outboxMessageIds: [],
    onBehalfOf: ana,
    recordOwner: null,
    ...overrides,
  };
}

async function stored<T>(row: Promise<T | undefined>): Promise<T> {
  const value = await row;
  if (value === undefined) throw new Error('expected a stored row');
  return value;
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  const created = await createTenant(db, { name: 'Fig', slug: 'fig', timeZone: 'America/Denver' });
  tenant = TenantIdSchema.parse(created.id);
  ana = await insertUser(db, 'Ana');
  jess = await insertUser(db, 'Jess');
  ben = await insertUser(db, 'Ben');
  await inTenant(async (tx) => {
    await addMembership(tx, { userId: ana, role: 'owner' });
    await addMembership(tx, { userId: jess, role: 'staff' });
    await addMembership(tx, { userId: ben, role: 'staff' });
  });
});

afterAll(async () => {
  await database.stop();
});

describe('autonomy settings', () => {
  it('keeps one row per business and reads it back', async () => {
    await as(ana, (tx) =>
      saveAutonomySettings(tx, {
        askFirst: false,
        levels: { 'booking.create': 'notify' },
        updatedBy: ana,
      }),
    );
    const saved = await as(ana, (tx) =>
      saveAutonomySettings(tx, { askFirst: true, levels: {}, updatedBy: ana }),
    );
    expect(saved).toMatchObject({ askFirst: true, levels: {}, updatedByUserId: ana });
    const { rows } = await inTenant((tx) =>
      tx.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM autonomy_settings`),
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('staff read it but cannot change it, even past the service (RLS)', async () => {
    expect(await as(jess, (tx) => findAutonomySettings(tx))).toMatchObject({ askFirst: true });
    const error = await as(jess, (tx) =>
      tx.execute(sql`UPDATE autonomy_settings SET ask_first = false`),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('42501');
  });

  it.each([
    ['"just do it" for bulk messages', `'{"message.bulk": "auto"}'`],
    ['an unknown action', `'{"booking.delete": "ask"}'`],
    ['an unknown level', `'{"booking.create": "always"}'`],
    ['a non-object', `'[]'`],
  ])('the database refuses %s', async (_label, levels) => {
    const error = await inTenant((tx) =>
      tx.execute(sql.raw(`UPDATE autonomy_settings SET levels = ${levels}::jsonb`)),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514');
  });
});

describe('proposals', () => {
  it('a retried tool call finds its proposal instead of storing a second one', async () => {
    const input = proposal();
    const first = await stored(inTenant((tx) => insertProposal(tx, input)));
    expect(await inTenant((tx) => insertProposal(tx, input))).toBeUndefined();
    expect((await inTenant((tx) => findProposalByKey(tx, input.idempotencyKey)))?.id).toBe(
      first.id,
    );
  });

  it('keeps at most one pending proposal per target', async () => {
    const targetKey = `booking:${newId()}`;
    const first = await stored(inTenant((tx) => insertProposal(tx, proposal({ targetKey }))));
    expect(await inTenant((tx) => insertProposal(tx, proposal({ targetKey })))).toBeUndefined();
    await inTenant((tx) =>
      decideProposal(tx, ActionProposalIdSchema.parse(first.id), {
        status: 'superseded',
        by: null,
        at: new Date(),
      }),
    );
    const second = await stored(inTenant((tx) => insertProposal(tx, proposal({ targetKey }))));
    expect((await inTenant((tx) => lockPendingProposalFor(tx, targetKey)))?.id).toBe(second.id);
  });

  it('refuses a payload holding a client contact, in the repository and the database', async () => {
    await expect(
      inTenant((tx) => insertProposal(tx, proposal({ payload: { email: 'maria@example.com' } }))),
    ).rejects.toThrow();
    const row = await stored(inTenant((tx) => insertProposal(tx, proposal())));
    const error = await inTenant((tx) =>
      tx.execute(
        sql`UPDATE ai_action_proposals SET payload = ${JSON.stringify({ x: 'y'.repeat(9000) })}::jsonb WHERE id = ${row.id}`,
      ),
    ).catch((e: unknown) => e);
    // The guard trigger refuses any change to the payload before the size check runs.
    expect(sqlState(error)).toBe('P0001');
  });

  it('is decided once, and what was proposed never changes (trigger)', async () => {
    const row = await stored(inTenant((tx) => insertProposal(tx, proposal())));
    const id = ActionProposalIdSchema.parse(row.id);
    const approved = await inTenant((tx) =>
      decideProposal(tx, id, { status: 'approved', by: ana, at: new Date() }),
    );
    expect(approved).toMatchObject({ status: 'approved', decidedByUserId: ana });
    expect(
      await inTenant((tx) =>
        decideProposal(tx, id, { status: 'rejected', by: ana, at: new Date() }),
      ),
    ).toBeUndefined();
    for (const change of [
      sql`status = 'rejected'`,
      sql`payload = '{"bookingId": "x"}'::jsonb`,
      sql`fingerprint = ${'c'.repeat(64)}`,
      sql`requested_by_user_id = ${jess}`,
      sql`decided_by_user_id = ${jess}`,
    ]) {
      const error = await inTenant((tx) =>
        tx.execute(sql`UPDATE ai_action_proposals SET ${change} WHERE id = ${id}`),
      ).catch((e: unknown) => e);
      expect(sqlState(error)).toBe('P0001');
    }
  });

  it('cannot be deleted by the services', async () => {
    const row = await stored(inTenant((tx) => insertProposal(tx, proposal())));
    const error = await inTenant((tx) =>
      tx.execute(sql`DELETE FROM ai_action_proposals WHERE id = ${row.id}`),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('42501');
  });

  it('staff reach only the proposals made for them (RLS)', async () => {
    const forJess = await stored(
      inTenant((tx) => insertProposal(tx, proposal({ requestedBy: jess }))),
    );
    const forBen = await stored(
      inTenant((tx) => insertProposal(tx, proposal({ requestedBy: ben }))),
    );
    const seen = (await as(jess, (tx) => listPendingProposals(tx, 500))).map((p) => p.id);
    expect(seen).toContain(forJess.id);
    expect(seen).not.toContain(forBen.id);
    expect(await as(jess, (tx) => lockProposal(tx, ActionProposalIdSchema.parse(forBen.id)))).toBe(
      undefined,
    );
    expect((await as(ana, (tx) => listPendingProposals(tx, 500))).map((p) => p.id)).toEqual(
      expect.arrayContaining([forJess.id, forBen.id]),
    );
    const error = await as(jess, (tx) => insertProposal(tx, proposal({ requestedBy: ben }))).catch(
      (e: unknown) => e,
    );
    expect(sqlState(error)).toBe('42501');
  });

  it('expires pending proposals whose time has come, and only those', async () => {
    const now = new Date();
    const due = await stored(
      inTenant(async (tx) => {
        const row = await insertProposal(
          tx,
          proposal({ expiresAt: new Date(now.getTime() + 1000) }),
        );
        return row;
      }),
    );
    const later = await stored(inTenant((tx) => insertProposal(tx, proposal())));
    const expired = await inTenant((tx) =>
      expirePendingProposals(tx, new Date(now.getTime() + 2000), 500),
    );
    const ids = expired.map((row) => row.id);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(later.id);
    expect(expired.find((row) => row.id === due.id)).toMatchObject({
      status: 'expired',
      decidedByUserId: null,
    });
  });
});

describe('executions', () => {
  it('a retry finds its execution; a proposal runs at most once', async () => {
    const input = execution();
    const first = await stored(inTenant((tx) => insertExecution(tx, input)));
    expect(await inTenant((tx) => insertExecution(tx, input))).toBeUndefined();
    expect((await inTenant((tx) => findExecutionByKey(tx, input.idempotencyKey)))?.id).toBe(
      first.id,
    );

    const approved = await stored(inTenant((tx) => insertProposal(tx, proposal())));
    const proposalId = ActionProposalIdSchema.parse(approved.id);
    const once = execution({ proposalId, outcome: 'propose' });
    await stored(inTenant((tx) => insertExecution(tx, once)));
    expect(
      await inTenant((tx) => insertExecution(tx, { ...once, idempotencyKey: `turn:${newId()}` })),
    ).toBeUndefined();
  });

  it('the database ties outcomes to proposals and undo to an inverse', async () => {
    await expect(
      inTenant((tx) => insertExecution(tx, execution({ outcome: 'propose' }))),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    const row = await stored(inTenant((tx) => insertExecution(tx, execution({ undo: null }))));
    expect(row).toMatchObject({ inverse: null, undoUntil: null });
  });

  it('is undone once, and its receipt never changes (trigger)', async () => {
    const row = await stored(inTenant((tx) => insertExecution(tx, execution())));
    const id = ActionExecutionIdSchema.parse(row.id);
    const at = new Date();
    const undone = await inTenant((tx) =>
      markExecutionUndone(tx, id, { by: ana, at, reason: 'wrong' }),
    );
    expect(undone).toMatchObject({ status: 'undone', undoneByUserId: ana, undoReason: 'wrong' });
    expect(
      await inTenant((tx) => markExecutionUndone(tx, id, { by: ana, at, reason: null })),
    ).toBeUndefined();
    for (const change of [
      sql`status = 'done', undone_at = NULL, undo_reason = NULL`,
      sql`undo_reason = 'other'`,
      sql`after = '{}'::jsonb`,
      sql`undo_until = now() + interval '1 year'`,
      sql`outbox_message_ids = '{}'::uuid[] || ${newId()}::uuid`,
    ]) {
      const error = await inTenant((tx) =>
        tx.execute(sql`UPDATE ai_action_executions SET ${change} WHERE id = ${id}`),
      ).catch((e: unknown) => e);
      expect(sqlState(error)).toBe('P0001');
    }
  });

  it('keeps the receipt when its member account is deleted', async () => {
    const leaver = await insertUser(db, 'Leaver');
    await inTenant((tx) => addMembership(tx, { userId: leaver, role: 'staff' }));
    const row = await stored(
      inTenant((tx) => insertExecution(tx, execution({ onBehalfOf: leaver }))),
    );
    await db.execute(sql`DELETE FROM users WHERE id = ${leaver}`);
    const kept = await inTenant((tx) => lockExecution(tx, ActionExecutionIdSchema.parse(row.id)));
    expect(kept).toMatchObject({ id: row.id, onBehalfOfUserId: null });
  });

  it('staff see only what the AI did for them (RLS)', async () => {
    const forJess = await stored(
      inTenant((tx) => insertExecution(tx, execution({ onBehalfOf: jess }))),
    );
    const forBen = await stored(
      inTenant((tx) => insertExecution(tx, execution({ onBehalfOf: ben }))),
    );
    const seen = (await as(jess, (tx) => listExecutions(tx, { limit: 500 }))).map((e) => e.id);
    expect(seen).toContain(forJess.id);
    expect(seen).not.toContain(forBen.id);
  });
});

describe('cancelOutboxMessages', () => {
  async function queue(): Promise<OutboxMessageId> {
    const id = OutboxMessageIdSchema.parse(newId());
    await inTenant((tx) =>
      insertOutboxMessage(tx, {
        id,
        type: 'email',
        dedupeKey: `test:${id}`,
        payload: Buffer.from('sealed'),
        availableAt: new Date(),
      }),
    );
    return id;
  }

  async function statusOf(id: OutboxMessageId) {
    const { rows } = await inTenant((tx) =>
      tx.execute<{ status: string; payload: unknown; dispatch: number }>(
        sql`SELECT status::text, payload,
              (SELECT count(*)::int FROM outbox_dispatch d WHERE d.id = m.id) AS dispatch
              FROM outbox_messages m WHERE id = ${id}`,
      ),
    );
    return rows[0];
  }

  it('takes back a pending message, and never one being delivered or sent', async () => {
    const [waiting, delivering, sent, expiredLease] = [
      await queue(),
      await queue(),
      await queue(),
      await queue(),
    ];
    // After queueing: a message can be claimed once its time has come.
    const now = new Date();
    await inTenant((tx) =>
      claimOutboxMessage(tx, delivering, now, new Date(now.getTime() + 60_000)),
    );
    await inTenant(async (tx) => {
      await claimOutboxMessage(tx, sent, now, new Date(now.getTime() + 60_000));
      await markOutboxMessageSent(tx, sent, now);
    });
    // A worker that died: its lease ended, so the message is due again and may be taken back.
    await inTenant((tx) => claimOutboxMessage(tx, expiredLease, now, new Date(now.getTime() - 1)));

    const result = await inTenant((tx) =>
      cancelOutboxMessages(
        tx,
        [waiting, delivering, sent, expiredLease, OutboxMessageIdSchema.parse(newId())],
        now,
      ),
    );
    expect(new Set(result.cancelled)).toEqual(new Set([waiting, expiredLease]));
    expect(new Set(result.tooLate)).toEqual(new Set([delivering, sent]));
    expect(await statusOf(waiting)).toEqual({ status: 'cancelled', payload: null, dispatch: 0 });
    expect(await statusOf(delivering)).toMatchObject({ status: 'pending', dispatch: 1 });
  });

  it('a cancelled message is never claimed or marked sent afterwards', async () => {
    const id = await queue();
    const now = new Date();
    await inTenant((tx) => cancelOutboxMessages(tx, [id], now));
    expect(
      await inTenant((tx) => claimOutboxMessage(tx, id, now, new Date(now.getTime() + 60_000))),
    ).toBeUndefined();
    expect(await inTenant((tx) => markOutboxMessageSent(tx, id, now))).toBe(false);
    expect(await statusOf(id)).toMatchObject({ status: 'cancelled' });
  });
});

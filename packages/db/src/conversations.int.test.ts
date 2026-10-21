import {
  TenantIdSchema,
  UsagePeriodSchema,
  type ConversationId,
  type ConversationTurnId,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import {
  deleteIdleConversations,
  findConversation,
  findTurnByClientId,
  finishTurn,
  insertConversation,
  insertMessage,
  insertTurn,
  listConversations,
  listRecentMessages,
  lockRunningTurn,
  saveTurnProgress,
} from './repositories/conversations.js';
import { addMembership, deleteMembership } from './repositories/memberships.js';
import { createTenant } from './repositories/tenants.js';
import { listUsage, reserveUsage, settleUsage } from './repositories/usage.js';
import { withMember, withTenant, type TenantTx } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

// Conversations with the AI against real Postgres (ADR-0030): own-only for every role, the
// checks and triggers that keep a record of what the model was sent, one running turn per
// conversation, a retried request finding its turn, retention, and the token budget's
// reservation holding under concurrency. Isolation between businesses is in
// isolation.int.test.ts.

let database: TestDatabase;
let db: Database;
let tenant: TenantId;
// Ana owns the business; Jess is staff.
let ana: UserId;
let jess: UserId;

const as = <T>(userId: UserId, work: (tx: TenantTx) => Promise<T>) =>
  withMember(db, { tenantId: tenant, userId }, work);
const inTenant = <T>(work: (tx: TenantTx) => Promise<T>) => withTenant(db, tenant, work);

async function startTurn(userId: UserId, conversationId?: ConversationId) {
  return as(userId, async (tx) => {
    const id =
      conversationId ??
      ((await insertConversation(tx, { userId, channel: 'chat' })).id as ConversationId);
    const turn = await insertTurn(tx, {
      conversationId: id,
      userId,
      clientTurnId: newId(),
      deadlineAt: new Date(Date.now() + 20_000),
    });
    if (turn === undefined) throw new Error('no turn');
    return { conversationId: id, turnId: turn.id as ConversationTurnId };
  });
}

const userMessage = (
  userId: UserId,
  at: { conversationId: ConversationId; turnId: ConversationTurnId },
  content = 'What does tomorrow look like?',
) =>
  ({
    ...at,
    userId,
    role: 'user',
    content,
    untrusted: false,
  }) as const;

const done = { status: 'completed', stopReason: 'answered', at: new Date() } as const;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  const created = await createTenant(db, {
    name: 'Fig',
    slug: 'fig-chat',
    timeZone: 'America/Denver',
  });
  tenant = TenantIdSchema.parse(created.id);
  ana = await insertUser(db, 'Ana');
  jess = await insertUser(db, 'Jess');
  await inTenant(async (tx) => {
    await addMembership(tx, { userId: ana, role: 'owner' });
    await addMembership(tx, { userId: jess, role: 'staff' });
  });
});

afterAll(async () => {
  await database.stop();
});

describe('own conversations only', () => {
  it("not even the owner sees a staff member's chat", async () => {
    const jessChat = await startTurn(jess);
    await as(jess, (tx) => insertMessage(tx, userMessage(jess, jessChat)));
    expect(await as(ana, (tx) => findConversation(tx, jessChat.conversationId))).toBeUndefined();
    expect(await as(ana, (tx) => listRecentMessages(tx, jessChat.conversationId, 10))).toEqual([]);
    expect(
      await as(jess, (tx) => listRecentMessages(tx, jessChat.conversationId, 10)),
    ).toHaveLength(1);
    // Work without a user (the clean-up) reaches every conversation.
    expect(await inTenant((tx) => findConversation(tx, jessChat.conversationId))).toBeDefined();
  });

  it('a member cannot start a conversation, a turn or a message as someone else', async () => {
    const asOther = await as(jess, (tx) =>
      insertConversation(tx, { userId: ana, channel: 'chat' }),
    ).catch((e: unknown) => e);
    expect(sqlState(asOther)).toBe('42501');
    const anaChat = await startTurn(ana);
    const intoAnas = await as(jess, (tx) => insertMessage(tx, userMessage(jess, anaChat))).catch(
      (e: unknown) => e,
    );
    // Ana's turn is invisible to Jess, so for her it is not a running turn (and the same-member
    // key would refuse the row anyway).
    expect(sqlState(intoAnas)).toBe('P0001');
  });

  it('lists the member’s conversations, newest first', async () => {
    const older = await startTurn(ana);
    const newer = await startTurn(ana);
    await inTenant(async (tx) => {
      await tx.execute(
        sql`UPDATE conversations SET last_message_at = now() - interval '1 hour' WHERE id = ${older.conversationId}`,
      );
    });
    const listed = await as(ana, (tx) => listConversations(tx, ana, 50));
    const ids = listed.map((row) => row.id);
    expect(ids.indexOf(newer.conversationId)).toBeLessThan(ids.indexOf(older.conversationId));
    expect(listed.every((row) => row.userId === ana)).toBe(true);
  });

  it('a member who leaves takes their conversations with them', async () => {
    const leaver = await insertUser(db, 'Lee');
    await inTenant((tx) => addMembership(tx, { userId: leaver, role: 'staff' }));
    const chat = await startTurn(leaver);
    await as(leaver, (tx) => insertMessage(tx, userMessage(leaver, chat)));
    await inTenant((tx) => deleteMembership(tx, leaver));
    expect(await inTenant((tx) => findConversation(tx, chat.conversationId))).toBeUndefined();
  });
});

describe('turns', () => {
  it('runs one turn per conversation, and a retried request finds its turn', async () => {
    const first = await startTurn(ana);
    const second = await as(ana, (tx) =>
      insertTurn(tx, {
        conversationId: first.conversationId,
        userId: ana,
        clientTurnId: newId(),
        deadlineAt: new Date(Date.now() + 20_000),
      }),
    );
    expect(second).toBeUndefined();
    const clientTurnId = newId();
    await as(ana, (tx) => finishTurn(tx, first.turnId, done));
    const started = await as(ana, (tx) =>
      insertTurn(tx, {
        conversationId: first.conversationId,
        userId: ana,
        clientTurnId,
        deadlineAt: new Date(Date.now() + 20_000),
      }),
    );
    expect(started).toBeDefined();
    const retried = await as(ana, (tx) =>
      insertTurn(tx, {
        conversationId: first.conversationId,
        userId: ana,
        clientTurnId,
        deadlineAt: new Date(Date.now() + 20_000),
      }),
    );
    expect(retried).toBeUndefined();
    expect((await as(ana, (tx) => findTurnByClientId(tx, ana, clientTurnId)))?.id).toBe(
      started?.id,
    );
    expect((await as(ana, (tx) => lockRunningTurn(tx, first.conversationId)))?.id).toBe(
      started?.id,
    );
  });

  it('ends once; an untrusted turn stays untrusted; messages go only into a running turn', async () => {
    const at = await startTurn(ana);
    const progress = {
      steps: 2,
      untrusted: true,
      inputTokens: 900,
      cachedInputTokens: 600,
      outputTokens: 40,
    };
    expect(await as(ana, (tx) => saveTurnProgress(tx, at.turnId, progress))).toBe(true);
    const laundered = await as(ana, (tx) =>
      saveTurnProgress(tx, at.turnId, { ...progress, untrusted: false }),
    ).catch((e: unknown) => e);
    expect(sqlState(laundered)).toBe('P0001');
    expect(await as(ana, (tx) => finishTurn(tx, at.turnId, { ...done, ...progress }))).toBe(true);
    expect(await as(ana, (tx) => finishTurn(tx, at.turnId, done))).toBe(false);
    expect(await as(ana, (tx) => saveTurnProgress(tx, at.turnId, progress))).toBe(false);
    const reopened = await as(ana, (tx) =>
      tx.execute(
        sql`UPDATE conversation_turns SET status = 'running', finished_at = NULL, stop_reason = NULL WHERE id = ${at.turnId}`,
      ),
    ).catch((e: unknown) => e);
    expect(sqlState(reopened)).toBe('P0001');
    const late = await as(ana, (tx) => insertMessage(tx, userMessage(ana, at))).catch(
      (e: unknown) => e,
    );
    expect(sqlState(late)).toBe('P0001');
  });
});

describe('messages', () => {
  it('numbers messages in order and returns the newest, oldest first', async () => {
    const at = await startTurn(ana);
    await as(ana, async (tx) => {
      await insertMessage(tx, userMessage(ana, at, 'one'));
      await insertMessage(tx, {
        ...at,
        userId: ana,
        role: 'assistant',
        content: '',
        step: 1,
        toolCalls: [{ id: 'call_1', name: 'get_day', arguments: '{}' }],
        replay: [{ type: 'reasoning', encrypted_content: 'opaque' }],
        untrusted: false,
      });
      await insertMessage(tx, {
        ...at,
        userId: ana,
        role: 'tool',
        content: '{"status":"answered"}',
        step: 1,
        toolCallId: 'call_1',
        toolName: 'get_day',
        isError: false,
        card: null,
        untrusted: false,
      });
    });
    const recent = await as(ana, (tx) => listRecentMessages(tx, at.conversationId, 2));
    expect(recent.map((row) => [row.seq, row.role])).toEqual([
      [2, 'assistant'],
      [3, 'tool'],
    ]);
    // A tool result is recorded once per step and call.
    const twice = await as(ana, (tx) =>
      insertMessage(tx, {
        ...at,
        userId: ana,
        role: 'tool',
        content: '{}',
        step: 1,
        toolCallId: 'call_1',
        toolName: 'get_day',
        isError: false,
        card: null,
        untrusted: false,
      }),
    ).catch((e: unknown) => e);
    expect(sqlState(twice)).toBe('23505');
  });

  it('are never changed or deleted by the services', async () => {
    const at = await startTurn(ana);
    const message = await as(ana, (tx) => insertMessage(tx, userMessage(ana, at)));
    for (const statement of [
      sql`UPDATE conversation_messages SET content = 'edited' WHERE id = ${message.id}`,
      sql`DELETE FROM conversation_messages WHERE id = ${message.id}`,
    ]) {
      const error = await as(ana, (tx) => tx.execute(statement)).catch((e: unknown) => e);
      expect(sqlState(error)).toBe('42501');
    }
  });

  it('the database refuses tool fields on a user message and tool calls on a tool result', async () => {
    const at = await startTurn(ana);
    const bad = [
      sql`INSERT INTO conversation_messages (id, conversation_id, turn_id, user_id, seq, role, content, tool_call_id, tool_name)
          VALUES (${newId()}, ${at.conversationId}, ${at.turnId}, ${ana}, 100, 'user', 'x', 'call_1', 'get_day')`,
      sql`INSERT INTO conversation_messages (id, conversation_id, turn_id, user_id, seq, role, content, step, tool_call_id, tool_name, tool_calls)
          VALUES (${newId()}, ${at.conversationId}, ${at.turnId}, ${ana}, 101, 'tool', 'x', 1, 'call_1', 'get_day', '[{"id":"c"}]'::jsonb)`,
      sql`INSERT INTO conversation_messages (id, conversation_id, turn_id, user_id, seq, role, content)
          VALUES (${newId()}, ${at.conversationId}, ${at.turnId}, ${ana}, 102, 'system', 'x')`,
    ];
    for (const statement of bad) {
      const error = await as(ana, (tx) => tx.execute(statement)).catch((e: unknown) => e);
      expect(sqlState(error)).toBe('23514');
    }
  });
});

describe('retention', () => {
  it('deletes idle conversations with their turns and messages, never one that is running', async () => {
    const idle = await startTurn(ana);
    await as(ana, (tx) => insertMessage(tx, userMessage(ana, idle)));
    await as(ana, (tx) => finishTurn(tx, idle.turnId, done));
    const running = await startTurn(ana);
    await inTenant((tx) =>
      tx.execute(
        sql`UPDATE conversations SET last_message_at = now() - interval '100 days' WHERE id IN (${idle.conversationId}, ${running.conversationId})`,
      ),
    );
    const before = new Date(Date.now() - 90 * 86_400_000);
    expect(await inTenant((tx) => deleteIdleConversations(tx, before, 100))).toBe(1);
    expect(await inTenant((tx) => findConversation(tx, idle.conversationId))).toBeUndefined();
    expect(await inTenant((tx) => findConversation(tx, running.conversationId))).toBeDefined();
    const { rows } = await inTenant((tx) =>
      tx.execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM conversation_messages WHERE conversation_id = ${idle.conversationId}`,
      ),
    );
    expect(rows[0]?.count).toBe(0);
  });
});

describe('token budget reservations', () => {
  const period = UsagePeriodSchema.parse('2026-10');

  it('of many concurrent reservations, only those that fit succeed', async () => {
    const created = await createTenant(db, {
      name: 'Budget',
      slug: `budget-${newId().slice(-8)}`,
      timeZone: 'America/Denver',
    });
    const business = TenantIdSchema.parse(created.id);
    const reserve = () =>
      withTenant(db, business, (tx) =>
        reserveUsage(tx, { metric: 'llm_tokens', period, amount: 1_000, limit: 10_000 }),
      );
    const results = await Promise.all(Array.from({ length: 25 }, reserve));
    expect(results.filter((after) => after !== null)).toHaveLength(10);
    expect(results.filter((after) => after !== null).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      Array.from({ length: 10 }, (_unused, index) => (index + 1) * 1_000),
    );
    const [usage] = await withTenant(db, business, (tx) => listUsage(tx, period));
    expect(usage).toEqual({ metric: 'llm_tokens', amount: 10_000 });
  });

  it('settles a reservation to what was used, never below zero, and refuses one over the limit', async () => {
    const created = await createTenant(db, {
      name: 'Settle',
      slug: `settle-${newId().slice(-8)}`,
      timeZone: 'America/Denver',
    });
    const business = TenantIdSchema.parse(created.id);
    const inBusiness = <T>(work: (tx: TenantTx) => Promise<T>) => withTenant(db, business, work);
    expect(
      await inBusiness((tx) =>
        reserveUsage(tx, { metric: 'llm_tokens', period, amount: 20_001, limit: 20_000 }),
      ),
    ).toBeNull();
    expect(
      await inBusiness((tx) =>
        reserveUsage(tx, { metric: 'llm_tokens', period, amount: 5_000, limit: 20_000 }),
      ),
    ).toBe(5_000);
    await inBusiness((tx) => settleUsage(tx, { metric: 'llm_tokens', period, delta: -3_800 }));
    expect(await inBusiness((tx) => listUsage(tx, period))).toEqual([
      { metric: 'llm_tokens', amount: 1_200 },
    ]);
    await inBusiness((tx) => settleUsage(tx, { metric: 'llm_tokens', period, delta: -9_999 }));
    expect(await inBusiness((tx) => listUsage(tx, period))).toEqual([
      { metric: 'llm_tokens', amount: 0 },
    ]);
  });
});

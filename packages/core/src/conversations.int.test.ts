import {
  ConversationIdSchema,
  TenantIdSchema,
  type MembershipRole,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import { addMembership, newId, touchConversation, withTenant, type Database } from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from './actor.js';
import { ManualClock } from './clock.js';
import { ConversationNotFoundError } from './errors.js';
import { createBusiness } from './services/business.js';
import { cleanUp } from './services/cleanup.js';
import {
  beginTurn,
  CONVERSATION_RETENTION_MS,
  conversationHistory,
  endTurn,
  getTurn,
  listMyConversations,
  recentMessages,
  recordTurnMessages,
  STALE_TURN_GRACE_MS,
  type BeginTurnResult,
} from './services/conversations.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The conversation services against real Postgres (ADR-0030): a turn starts once per client
// id, one runs per conversation, an abandoned one is reported stale, and every role reaches
// only its own conversations.

let database: TestDatabase;
let db: Database;
let tenantId: TenantId;
let owner: UserId;
let jess: UserId;

const as = (userId: UserId, role: MembershipRole): Actor => ({
  context: { tenantId, userId, role },
});
const ana = () => as(owner, 'owner');
const jessActor = () => as(jess, 'staff');

const progress = {
  steps: 1,
  untrusted: false,
  inputTokens: 10,
  cachedInputTokens: 0,
  outputTokens: 5,
};

function start(
  actor: Actor,
  options: { conversationId?: string | null; clientTurnId?: string; now?: Date } = {},
): Promise<BeginTurnResult> {
  const now = options.now ?? new Date();
  return beginTurn(db, actor, {
    clientTurnId: options.clientTurnId ?? newId(),
    conversationId:
      options.conversationId === undefined || options.conversationId === null
        ? null
        : ConversationIdSchema.parse(options.conversationId),
    message: 'What does tomorrow look like?',
    channel: 'chat',
    deadlineAt: new Date(now.getTime() + 20_000),
    now,
  });
}

function started(result: BeginTurnResult) {
  if (result.kind !== 'started') throw new Error(`expected a started turn, got ${result.kind}`);
  return result;
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  owner = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, owner, {
    name: 'Juniper Hair Studio',
    slug: 'juniper-chat',
    timeZone: 'America/New_York',
  });
  tenantId = TenantIdSchema.parse(tenant.id);
  jess = await insertUser(db, 'Jess');
  await withTenant(db, tenantId, (tx) => addMembership(tx, { userId: jess, role: 'staff' }));
});

afterAll(async () => {
  await database.stop();
});

describe('beginTurn', () => {
  it('starts a conversation with the member’s message, and a retry finds that turn', async () => {
    const clientTurnId = newId();
    const first = started(await start(ana(), { clientTurnId }));
    const again = await start(ana(), { clientTurnId });
    expect(again).toEqual({ kind: 'existing', turn: first.turn });
    const messages = await recentMessages(db, ana(), first.turn.conversationId, 10);
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'What does tomorrow look like?'],
    ]);
    expect(messages[0]?.id).toBe(first.requestMessageId);
  });

  it('answers busy while the conversation runs a turn, stale once it was abandoned', async () => {
    const now = new Date();
    const first = started(await start(ana(), { now }));
    const conversationId = first.turn.conversationId;
    expect((await start(ana(), { conversationId, now })).kind).toBe('busy');
    const later = new Date(now.getTime() + 20_000 + STALE_TURN_GRACE_MS + 1);
    const stale = await start(ana(), { conversationId, now: later });
    expect(stale).toEqual({ kind: 'stale', turn: first.turn });
    expect(
      await endTurn(db, ana(), first.turn.id, { reason: 'interrupted', progress, now: later }),
    ).toBe(true);
    expect((await start(ana(), { conversationId, now: later })).kind).toBe('started');
  });

  it('never continues another member’s conversation, and needs the chat permission', async () => {
    const anas = started(await start(ana()));
    await expect(start(jessActor(), { conversationId: anas.turn.conversationId })).rejects.toThrow(
      ConversationNotFoundError,
    );
    await expect(getTurn(db, jessActor(), anas.turn.id)).rejects.toThrow(ConversationNotFoundError);
    expect(await recentMessages(db, jessActor(), anas.turn.conversationId, 10)).toEqual([]);
    expect(
      (await listMyConversations(db, jessActor())).some(
        (conversation) => conversation.id === anas.turn.conversationId,
      ),
    ).toBe(false);
  });
});

describe('recording a turn', () => {
  it('records the answer, the tool result and its card, then ends once', async () => {
    const turn = started(await start(jessActor())).turn;
    const at = new Date();
    await recordTurnMessages(
      db,
      jessActor(),
      turn,
      [
        {
          role: 'assistant',
          content: '',
          step: 1,
          toolCalls: [{ id: 'call_1', name: 'get_day', arguments: '{"date":"2026-11-03"}' }],
          replay: [],
          untrusted: false,
        },
        {
          role: 'tool',
          content: '{"status":"answered"}',
          step: 1,
          toolCallId: 'call_1',
          toolName: 'get_day',
          isError: false,
          card: { kind: 'day', date: '2026-11-03', bookings: [], blocked: [] },
          untrusted: false,
        },
        {
          role: 'assistant',
          content: 'Tomorrow is free.',
          step: 2,
          toolCalls: [],
          replay: [],
          untrusted: false,
        },
      ],
      { ...progress, steps: 2 },
      at,
    );
    expect(await endTurn(db, jessActor(), turn.id, { reason: 'answered', progress, now: at })).toBe(
      true,
    );
    expect(await endTurn(db, jessActor(), turn.id, { reason: 'internal', progress, now: at })).toBe(
      false,
    );
    expect((await getTurn(db, jessActor(), turn.id)).status).toBe('completed');
    const history = await conversationHistory(db, jessActor(), turn.conversationId);
    expect(history.map((item) => item.kind)).toEqual(['user', 'tool', 'assistant']);
    expect(history[1]).toMatchObject({ kind: 'tool', tool: 'get_day', card: { kind: 'day' } });
    await expect(conversationHistory(db, ana(), turn.conversationId)).rejects.toThrow(
      ConversationNotFoundError,
    );
    // Nothing is added to a turn that ended.
    await expect(
      recordTurnMessages(
        db,
        jessActor(),
        turn,
        [
          {
            role: 'assistant',
            content: 'late',
            step: 3,
            toolCalls: [],
            replay: [],
            untrusted: false,
          },
        ],
        progress,
        at,
      ),
    ).rejects.toThrow();
  });
});

describe('retention', () => {
  it('the clean-up deletes conversations 90 days after their last message', async () => {
    const turn = started(await start(ana())).turn;
    await endTurn(db, ana(), turn.id, { reason: 'answered', progress, now: new Date() });
    await withTenant(db, tenantId, (tx) =>
      touchConversation(tx, turn.conversationId, new Date(Date.now() - 91 * 86_400_000)),
    );
    const result = await cleanUp(db, { clock: new ManualClock(new Date()) });
    expect(result.conversations).toBeGreaterThanOrEqual(1);
    expect(
      (await listMyConversations(db, ana())).some((each) => each.id === turn.conversationId),
    ).toBe(false);
    expect(CONVERSATION_RETENTION_MS).toBe(90 * 86_400_000);
  });
});

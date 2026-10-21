import type { ChatEvent, LlmToolCall } from '@pepper/contracts';
import {
  changeAutonomy,
  listTasks,
  recentMessages,
  usageFor,
  usagePeriodOf,
  type Actor,
} from '@pepper/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptedProvider, scriptedResponse } from '../scripted-provider.js';
import { dispatchToolCall } from '../tools/registry.js';
import {
  newWorld,
  startTestDatabase,
  type TestDatabase,
  type World,
} from '../tools/test-support.js';
import { withTenant, type Database } from '@pepper/db';
import { startTurn, type AgentDeps } from './loop.js';
import type { ConversationStore } from './store.js';
import { agentDepsFor, clientTurnId } from './test-support.js';

// The loop against real Postgres and the real tools (ADR-0030):
// - a retried or concurrent request never runs a turn twice;
// - a server that stops after a write but before recording it leaves the turn to be recovered,
//   and the write is reported, never made again;
// - no transaction is open while the model is called;
// - every call is metered against the business's budget.

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

const justDoIt = (w: World) =>
  changeAutonomy(
    db,
    w.owner,
    { askFirst: false, levels: { 'task.create': 'auto' } },
    { templateDefaults: {} },
  );

const todo = (id: string, title: string): LlmToolCall => ({
  id,
  name: 'add_todo',
  arguments: JSON.stringify({ title, dueDate: null, dueTime: null, assigneeStaffMemberId: null }),
});

async function runTurn(
  deps: AgentDeps,
  message: string,
  id = clientTurnId(),
  conversationId: string | null = null,
) {
  const started = await startTurn(deps, {
    clientTurnId: id,
    conversationId: conversationId as never,
    message,
    channel: 'chat',
  });
  if (started.kind !== 'started') return { started, events: [] as ChatEvent[], reason: null };
  const events: ChatEvent[] = [];
  const reason = await started.run((event) => {
    events.push(event);
  });
  return { started, events, reason };
}

describe('exactly once', () => {
  it('a retried request reattaches to its turn and the to-do is added once', async () => {
    const w = await newWorld(db);
    await justDoIt(w);
    const provider = new ScriptedProvider([
      scriptedResponse({ toolCalls: [todo('call_1', 'Order foils')] }),
      scriptedResponse({ text: 'Added it.' }),
    ]);
    const deps = agentDepsFor(w, w.owner, provider);
    const id = clientTurnId();
    const first = await runTurn(deps, 'Remind me to order foils', id);
    expect(first.reason).toBe('answered');
    const again = await runTurn(deps, 'Remind me to order foils', id);
    expect(again.started.kind).toBe('existing');
    expect(await listTasks(db, w.owner, { status: 'all' })).toHaveLength(1);
  });

  it('two copies of the same request at once start one turn', async () => {
    const w = await newWorld(db);
    const deps = agentDepsFor(w, w.owner, new ScriptedProvider([]));
    const id = clientTurnId();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        startTurn(deps, { clientTurnId: id, conversationId: null, message: 'Hi', channel: 'chat' }),
      ),
    );
    const kinds = results.map((result) =>
      result.status === 'fulfilled' ? result.value.kind : 'error',
    );
    expect(kinds.sort()).toEqual([
      'existing',
      'existing',
      'existing',
      'existing',
      'existing',
      'started',
    ]);
    // One turn, one conversation: the copies that lost the race left nothing behind.
    const counts = await withTenant(db, w.tenantId, (tx) =>
      tx.execute<{ turns: number; conversations: number }>(
        sql`SELECT (SELECT count(*)::int FROM conversation_turns) AS turns, (SELECT count(*)::int FROM conversations) AS conversations`,
      ),
    );
    expect(counts.rows).toEqual([{ turns: 1, conversations: 1 }]);
  });

  it('a server that stopped after a write: the next message recovers the turn, the write is not made again', async () => {
    const w = await newWorld(db);
    await justDoIt(w);
    const provider = new ScriptedProvider([
      scriptedResponse({
        toolCalls: [todo('call_1', 'Order foils'), todo('call_2', 'Call the bank')],
      }),
      scriptedResponse({ text: 'Hello again.' }),
    ]);
    const real = agentDepsFor(w, w.owner, provider);
    // The server "dies" right after the first write commits: nothing more is recorded.
    let died = false;
    const dying: ConversationStore = {
      ...real.store,
      record: (turn, messages, progress) =>
        died
          ? Promise.reject(new Error('the server stopped'))
          : real.store.record(turn, messages, progress),
      end: (turnId, reason, progress) =>
        died
          ? Promise.reject(new Error('the server stopped'))
          : real.store.end(turnId, reason, progress),
    };
    const crashing: AgentDeps = {
      ...real,
      store: dying,
      dispatch: async (deps, turn, call) => {
        if (died) throw new Error('the server stopped');
        const outcome = await dispatchToolCall(deps, turn, call);
        died = true;
        return outcome;
      },
    };
    const crashed = await runTurn(crashing, 'Remind me to order foils and to call the bank');
    expect(crashed.started.kind).toBe('started');
    expect(await listTasks(db, w.owner, { status: 'all' })).toHaveLength(1);

    // Later, past the turn's deadline: a new message in the same conversation.
    w.clock.advanceBy(60_000);
    const conversationId = crashed.started.turn.conversationId;
    const next = await runTurn(real, 'Hello?', clientTurnId(), conversationId);
    expect(next.reason).toBe('answered');
    expect((await listTasks(db, w.owner, { status: 'all' })).map((task) => task.title)).toEqual([
      'Order foils',
    ]);
    const messages = await recentMessages(db, w.owner, conversationId, 50);
    const recovered = messages.filter(
      (m) => m.turnId === crashed.started.turn.id && m.role === 'tool',
    );
    expect(
      recovered.map((m) => [m.toolCallId, (JSON.parse(m.content) as { status: string }).status]),
    ).toEqual([
      ['call_1', 'done'],
      ['call_2', 'refused'],
    ]);
    // The model saw the recovered results with the next message, so it knows what is done.
    const sent = JSON.stringify(provider.requests.at(-1)?.messages);
    expect(sent).toContain('Done before the interruption');
  });
});

describe('around the model call', () => {
  it('holds no transaction open while the model thinks', async () => {
    const w = await newWorld(db);
    const open: number[] = [];
    const idleInTransaction = async () => {
      const { rows } = await db.execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename = current_user AND state LIKE 'idle in transaction%'`,
      );
      open.push(rows[0]?.count ?? -1);
    };
    const provider = new ScriptedProvider([
      async () => {
        await idleInTransaction();
        return scriptedResponse({
          toolCalls: [
            {
              id: 'c1',
              name: 'get_day',
              arguments: JSON.stringify({ date: '2026-11-03', staffMemberId: null }),
            },
            { id: 'c2', name: 'list_services_and_staff', arguments: '{}' },
          ],
        });
      },
      async () => {
        await idleInTransaction();
        return scriptedResponse({ text: 'Tuesday is quiet.' });
      },
    ]);
    const { reason } = await runTurn(
      agentDepsFor(w, w.owner, provider),
      'What does Tuesday look like?',
    );
    expect(reason).toBe('answered');
    expect(open).toEqual([0, 0]);
  });

  it('meters every call against the business, and pauses the AI at the hard limit', async () => {
    const w = await newWorld(db);
    const provider = new ScriptedProvider([
      scriptedResponse({
        text: 'Hi.',
        usage: { inputTokens: 2_000, cachedInputTokens: 1_500, outputTokens: 50 },
      }),
    ]);
    const deps = agentDepsFor(w, w.owner, provider, { limits: { soft: 40_000, hard: 50_000 } });
    expect((await runTurn(deps, 'Hi')).reason).toBe('answered');
    const used = (await usageFor(db, w.tenantId, usagePeriodOf(w.clock.now()))).llm_tokens;
    expect(used).toBe(2_050);
    // The next call's estimate no longer fits under the hard limit.
    const paused = await runTurn(
      agentDepsFor(w, w.owner, new ScriptedProvider([]), { limits: { soft: 2_000, hard: 2_100 } }),
      'Hi again',
    );
    expect(paused.reason).toBe('budget_exhausted');
  });

  it('staff chat only in their own conversations, and act only within their own permissions', async () => {
    const w = await newWorld(db);
    const jess: Actor = w.jess;
    const provider = new ScriptedProvider([
      scriptedResponse({
        toolCalls: [
          {
            id: 'c1',
            name: 'get_day',
            arguments: JSON.stringify({ date: '2026-11-03', staffMemberId: w.marcoStaff.id }),
          },
        ],
      }),
      scriptedResponse({ text: 'I can only see your own day.' }),
    ]);
    const turn = await runTurn(agentDepsFor(w, jess, provider), "What's Marco doing Tuesday?");
    expect(turn.reason).toBe('answered');
    const finished = turn.events.find((event) => event.type === 'tool.finished');
    expect(finished).toMatchObject({ type: 'tool.finished', tool: 'get_day' });
    // The owner can't read Jess's conversation.
    const conversationId = turn.started.turn.conversationId;
    expect(await recentMessages(db, w.owner, conversationId, 10)).toEqual([]);
  });
});

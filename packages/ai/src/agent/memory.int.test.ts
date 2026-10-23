import type { ChatEvent, LlmRequest } from '@pepper/contracts';
import { changeAutonomy, forgetFact, listFacts, listRecentActions, saveFact } from '@pepper/core';
import { storedTextsOf, withTenant, type Database } from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptedProvider, scriptedResponse } from '../scripted-provider.js';
import {
  newWorld,
  startTestDatabase,
  type TestDatabase,
  type World,
} from '../tools/test-support.js';
import { startTurn, type AgentDeps } from './loop.js';
import { agentDepsFor, clientTurnId } from './test-support.js';

// Memory through the real loop (S30): a fact told in one chat is used in the next (AC-W3-1);
// a forgotten fact never reaches the model again, also when the same chat goes on, and is
// stored nowhere (AC-W7-2), judged on the requests the model was sent; the business's own
// facts come in the instructions and make the turn untrusted.

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

async function say(deps: AgentDeps, message: string, conversationId: string | null = null) {
  const started = await startTurn(deps, {
    clientTurnId: clientTurnId(),
    conversationId: conversationId as never,
    message,
    channel: 'chat',
  });
  if (started.kind !== 'started') throw new Error(started.kind);
  const events: ChatEvent[] = [];
  const reason = await started.run((event) => {
    events.push(event);
  });
  expect(reason).toBe('answered');
  return started.turn.conversationId;
}

const call = (id: string, name: string, args: unknown) => ({
  id,
  name,
  arguments: JSON.stringify(args),
});
const text = (requests: readonly LlmRequest[]) => JSON.stringify(requests);

describe('memory through the loop', () => {
  it('a fact told in one chat is used in the next (AC-W3-1)', async () => {
    const w: World = await newWorld(db);
    const provider = new ScriptedProvider([
      scriptedResponse({ toolCalls: [call('c1', 'find_clients', { name: 'Maria' })] }),
      scriptedResponse({
        toolCalls: [
          call('c2', 'remember_fact', {
            about: 'client',
            id: w.maria.id,
            key: 'allergy',
            value: 'Hazelnut oil',
            sensitive: null,
          }),
        ],
      }),
      scriptedResponse({ text: 'Saved: Maria is allergic to hazelnut oil.' }),
      scriptedResponse({ toolCalls: [call('c3', 'find_clients', { name: 'Maria' })] }),
      scriptedResponse({ text: 'Maria is allergic to hazelnut oil.' }),
    ]);
    const deps = agentDepsFor(w, w.owner, provider);
    await say(deps, 'Remember that Maria is allergic to hazelnut oil');
    expect((await listFacts(db, w.owner)).map((f) => f.value)).toEqual(['Hazelnut oil']);
    await say(deps, 'Anything I should know about Maria?');
    const [, , , lookup, answer] = provider.requests;
    expect(JSON.stringify(lookup)).not.toMatch(/hazelnut/i);
    expect(answer?.messages.at(-1)?.role).toBe('tool');
    expect(JSON.stringify(answer?.messages.at(-1))).toMatch(/Hazelnut oil/);
    expect(JSON.stringify(answer?.messages.at(-1))).toMatch(/untrusted_data/);
  });

  it('a forgotten fact never reaches the model again in the same chat, and is stored nowhere (AC-W7-2)', async () => {
    const w = await newWorld(db);
    const { fact } = await saveFact(db, w.owner, {
      subject: { type: 'client', id: w.maria.id },
      key: 'allergy',
      value: 'Hazelnut oil',
    });
    const provider = new ScriptedProvider([
      scriptedResponse({ toolCalls: [call('c1', 'find_clients', { name: 'Maria' })] }),
      scriptedResponse({ text: 'Careful: Maria is allergic to hazelnut oil.' }),
      scriptedResponse({ text: 'Sure.' }),
    ]);
    const deps = agentDepsFor(w, w.owner, provider);
    const chat = await say(deps, 'What do we know about Maria? (hazelnut oil?)');
    expect(text(provider.requests)).toMatch(/hazelnut/i);
    await forgetFact(db, w.owner, fact.id);
    const before = provider.requests.length;
    await say(deps, 'Thanks. What else?', chat);
    const after = provider.requests.slice(before);
    expect(after).toHaveLength(1);
    expect(text(after)).not.toMatch(/hazelnut/i);
    const stored = await withTenant(db, w.tenantId, (tx) => storedTextsOf(tx));
    expect(stored.filter((each) => /hazelnut/i.test(each))).toEqual([]);
  });

  it('the business’s own facts come with the instructions and make the turn untrusted', async () => {
    const w = await newWorld(db);
    await changeAutonomy(
      db,
      w.owner,
      { levels: { 'task.create': 'auto' } },
      { templateDefaults: {} },
    );
    await saveFact(db, w.owner, {
      subject: { type: 'business' },
      key: 'policy',
      value: 'Deposits for color over two hours',
    });
    const provider = new ScriptedProvider([
      scriptedResponse({
        toolCalls: [
          call('c1', 'add_todo', {
            title: 'Order foils',
            dueDate: null,
            dueTime: null,
            assigneeStaffMemberId: null,
          }),
        ],
      }),
      scriptedResponse({ text: 'Added.' }),
    ]);
    await say(agentDepsFor(w, w.owner, provider), 'Remind me to order foils');
    expect(provider.requests[0]?.instructions).toMatch(/Deposits for color over two hours/);
    const [action] = await listRecentActions(db, w.owner);
    expect(action?.explanation.decision).toEqual({
      outcome: 'execute_and_notify',
      reason: 'untrusted_context',
    });
  });
});

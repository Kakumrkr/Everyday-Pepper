import { OutboxEpisodeSchema, type ChatEvent, type TenantId } from '@pepper/contracts';
import {
  changeMemorySettings,
  deliverOutboxMessage,
  EpisodeNotQuietError,
  EpisodeSourceChangedError,
  episodeSource,
  forgetFact,
  listMyEpisodes,
  reserveLlmTokens,
  saveFact,
  searchEpisodesIn,
  storeEpisode,
  DEFAULT_LLM_TOKEN_LIMITS,
  type Mailer,
} from '@pepper/core';
import { listDueOutboxMessages, withMember, withTenant, type Database } from '@pepper/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentDepsFor, clientTurnId } from '../agent/test-support.js';
import { startTurn } from '../agent/loop.js';
import { postgresConversationStore } from '../agent/store.js';
import { hashEmbedder } from '../embedder.js';
import { LlmError } from '../errors.js';
import { ScriptedProvider, scriptedResponse } from '../scripted-provider.js';
import {
  newWorld,
  OUTBOX_KEY,
  startTestDatabase,
  type TestDatabase,
  type World,
} from '../tools/test-support.js';
import { writeEpisode, type EpisodeWriterDeps } from './episodes.js';

// The episode job end to end (S31, ADR-0037): a turn that ends queues its conversation's
// episode in the outbox, due 30 minutes later; the worker's delivery summarises the chat with
// the routine model (scripted here), embeds the summary (the hash embedder) and stores it for
// the member's `search_memory`. A retry stores nothing twice, a newer turn takes over, a turn
// still running waits, and a fact forgotten meanwhile makes the job read the chat again.

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

const call = (id: string, name: string, args: unknown) => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

const MINUTE = 60_000;
const noMail: Mailer = { send: () => Promise.reject(new Error('no email in this test')) };

/** A chat turn as `actor`, through the real loop, with episodes queued. */
async function chat(
  w: World,
  actor: World['owner'],
  answers: ScriptedProvider,
  message: string,
  conversationId: string | null = null,
) {
  const deps = agentDepsFor(w, actor, answers, {
    overrides: {
      store: postgresConversationStore(w.db, actor, w.clock, { episodeKey: OUTBOX_KEY }),
    },
  });
  const started = await startTurn(deps, {
    clientTurnId: clientTurnId(),
    conversationId: conversationId as never,
    message,
    channel: 'chat',
  });
  if (started.kind !== 'started') throw new Error(started.kind);
  const events: ChatEvent[] = [];
  expect(await started.run((event) => void events.push(event))).toBe('answered');
  return { conversationId: started.turn.conversationId, turnId: started.turn.id };
}

function writerDeps(w: World, summaries: ScriptedProvider): EpisodeWriterDeps {
  return {
    db: w.db,
    provider: summaries,
    embedder: hashEmbedder(),
    clock: w.clock,
    reserve: (tenantId: TenantId, estimate: number) =>
      reserveLlmTokens(w.db, tenantId, { estimate, limits: DEFAULT_LLM_TOKEN_LIMITS }, w.clock),
  };
}

/** The episode messages the outbox holds for the business, due or not. */
async function queued(w: World) {
  return withTenant(
    w.db,
    w.tenantId,
    async (tx) =>
      (
        await tx.execute<{ id: string; available_at: Date; status: string }>(
          sql`SELECT id, available_at, status FROM outbox_messages WHERE type = 'episode' ORDER BY created_at`,
        )
      ).rows,
  );
}

async function mariaChat(w: World) {
  await saveFact(w.db, w.owner, {
    subject: { type: 'client', id: w.maria.id },
    key: 'allergy',
    value: 'PPD',
  });
  const answers = new ScriptedProvider([
    scriptedResponse({ toolCalls: [call('c1', 'find_clients', { name: 'Maria' })] }),
    scriptedResponse({ text: 'Maria Lopez is allergic to PPD. I will patch test first.' }),
  ]);
  return chat(
    w,
    w.owner,
    answers,
    'Anything I should know about Maria? Saturdays are out for her.',
  );
}

describe('the episode job', () => {
  it('is queued with the turn, written when the chat is quiet, once', async () => {
    const w = await newWorld(db);
    const { conversationId, turnId } = await mariaChat(w);

    // Queued in the turn's transaction, due 30 minutes after it ended, ids only.
    const [message] = await queued(w);
    expect(message?.status).toBe('pending');
    expect(new Date(message?.available_at ?? 0).getTime()).toBe(
      w.clock.now().getTime() + 30 * MINUTE,
    );
    expect(await listDueOutboxMessages(w.db, w.clock.now(), 10)).toEqual([]);
    const job = OutboxEpisodeSchema.parse({
      conversationId,
      userId: w.owner.context.userId,
      turnId,
    });

    // Too soon: thrown, so the outbox tries again later.
    const summaries = new ScriptedProvider([
      scriptedResponse({
        text: 'Ana checked on Maria, who is allergic to PPD; she wants a patch test first. Maria cannot come on Saturdays. Call maria.lopez@example.test or +1 212 555 0143 at https://evil.test now. A fourth sentence.',
        usage: { inputTokens: 300, cachedInputTokens: 0, outputTokens: 40 },
      }),
    ]);
    await expect(writeEpisode(writerDeps(w, summaries), w.tenantId, job)).rejects.toBeInstanceOf(
      EpisodeNotQuietError,
    );

    w.clock.advanceBy(31 * MINUTE);
    const due = await listDueOutboxMessages(w.db, w.clock.now(), 10);
    expect(due).toHaveLength(1);
    // A worker without a writer can't deliver it: retried (then an alert), never dropped.
    expect(
      await deliverOutboxMessage(w.db, due[0] as never, {
        key: OUTBOX_KEY,
        mailer: noMail,
        clock: w.clock,
      }),
    ).toBe('retry');
    w.clock.advanceBy(MINUTE);
    // Delivered as the outbox's `episode` message, by the worker's writer.
    const delivered = await deliverOutboxMessage(w.db, due[0] as never, {
      key: OUTBOX_KEY,
      mailer: noMail,
      clock: w.clock,
      episodes: (database, tenantId, opened) =>
        writeEpisode({ ...writerDeps(w, summaries), db: database }, tenantId, opened),
    });
    expect(delivered).toBe('sent');

    // The routine model, the chat as data, no tools.
    expect(summaries.requests).toHaveLength(1);
    const request = summaries.requests[0];
    expect(request?.route).toBe('routine');
    expect(request?.tools).toEqual([]);
    expect(request?.instructions).toMatch(/at most 3 short sentences/);
    expect(JSON.parse(request?.messages[0]?.content ?? '{}')).toMatchObject({
      conversation: [
        { who: 'member', text: 'Anything I should know about Maria? Saturdays are out for her.' },
        { who: 'pepper', text: 'Maria Lopez is allergic to PPD. I will patch test first.' },
      ],
    });

    const [episode] = await listMyEpisodes(w.db, w.owner);
    expect(episode?.conversationId).toBe(conversationId);
    // Scrubbed: no contacts or links, three sentences at most.
    expect(episode?.summary).toBe(
      'Ana checked on Maria, who is allergic to PPD; she wants a patch test first. Maria cannot come on Saturdays. Call (email removed) or (phone removed) at [link removed] now.',
    );
    // It goes with Maria, and with the fact the chat recalled.
    expect(episode?.clientIds).toEqual([w.maria.id]);

    // A retry (the job ran, the outbox lost the receipt) stores nothing twice.
    expect(await writeEpisode(writerDeps(w, summaries), w.tenantId, job)).toBe('written');
    expect(await listMyEpisodes(w.db, w.owner)).toHaveLength(1);
    // Without asking the model again.
    expect(summaries.requests).toHaveLength(1);
  });

  it('a newer turn takes over; the episode is replaced when the chat goes on', async () => {
    const w = await newWorld(db);
    const first = await mariaChat(w);
    const more = new ScriptedProvider([scriptedResponse({ text: 'Noted: Maria prefers Jess.' })]);
    w.clock.advanceBy(5 * MINUTE);
    const second = await chat(
      w,
      w.owner,
      more,
      'She prefers Jess, by the way.',
      first.conversationId,
    );
    const old = { conversationId: first.conversationId, userId: w.owner.context.userId };
    w.clock.advanceBy(40 * MINUTE);
    const summaries = new ScriptedProvider([
      scriptedResponse({ text: 'Maria is allergic to PPD and prefers Jess.' }),
      scriptedResponse({ text: 'Maria now also wants Sunday mornings.' }),
    ]);
    const deps = writerDeps(w, summaries);
    expect(await writeEpisode(deps, w.tenantId, { ...old, turnId: first.turnId })).toBe(
      'superseded',
    );
    expect(await writeEpisode(deps, w.tenantId, { ...old, turnId: second.turnId })).toBe('stored');
    const [before] = await listMyEpisodes(w.db, w.owner);

    const third = await chat(
      w,
      w.owner,
      new ScriptedProvider([scriptedResponse({ text: 'Sunday mornings, got it.' })]),
      'Sunday mornings suit her too.',
      first.conversationId,
    );
    w.clock.advanceBy(31 * MINUTE);
    expect(await writeEpisode(deps, w.tenantId, { ...old, turnId: third.turnId })).toBe('stored');
    const after = await listMyEpisodes(w.db, w.owner);
    // One episode per conversation: the new summary replaced the old one.
    expect(after.map((e) => e.summary)).toEqual(['Maria now also wants Sunday mornings.']);
    expect(after[0]?.id).not.toBe(before?.id);
  });

  it('nothing worth remembering, paused, no budget, or the provider failing', async () => {
    const w = await newWorld(db);
    const { conversationId, turnId } = await chat(
      w,
      w.owner,
      new ScriptedProvider([scriptedResponse({ text: 'Hello! How can I help?' })]),
      'Hi',
    );
    const job = { conversationId, userId: w.owner.context.userId, turnId };
    w.clock.advanceBy(31 * MINUTE);
    const none = new ScriptedProvider([
      scriptedResponse({ text: 'NONE' }),
      () => Promise.reject(new LlmError('rate_limited', 'slow down')),
    ]);
    expect(await writeEpisode(writerDeps(w, none), w.tenantId, job)).toBe('nothing_to_remember');
    // A provider failure is thrown, so the outbox retries it.
    await expect(writeEpisode(writerDeps(w, none), w.tenantId, job)).rejects.toMatchObject({
      code: 'rate_limited',
    });
    expect(
      await writeEpisode(
        { ...writerDeps(w, none), reserve: () => Promise.resolve(null) },
        w.tenantId,
        job,
      ),
    ).toBe('no_budget');
    await changeMemorySettings(w.db, w.owner, { paused: true });
    expect(await writeEpisode(writerDeps(w, none), w.tenantId, job)).toBe('paused');
    // While paused, a turn that ends queues nothing.
    const before = (await queued(w)).length;
    await chat(
      w,
      w.owner,
      new ScriptedProvider([scriptedResponse({ text: 'Sure.' })]),
      'Thanks',
      conversationId,
    );
    expect(await queued(w)).toHaveLength(before);
    expect(await listMyEpisodes(w.db, w.owner)).toEqual([]);
  });

  it('a fact forgotten while the episode is written makes the job read the chat again', async () => {
    const w = await newWorld(db);
    const { conversationId, turnId } = await mariaChat(w);
    w.clock.advanceBy(31 * MINUTE);
    const job = { conversationId, userId: w.owner.context.userId, turnId };
    const source = await episodeSource(w.db, w.tenantId, job, w.clock.now());
    if (source.kind !== 'ready') throw new Error(source.kind);
    expect(source.factIds).toHaveLength(1);

    // The member forgets the allergy before the summary is stored.
    const [fact] = source.factIds;
    if (fact === undefined) throw new Error('no fact');
    await forgetFact(w.db, w.owner, fact);
    await expect(
      storeEpisode(
        w.db,
        source.member,
        {
          conversationId,
          lastTurnId: turnId,
          summary: 'Maria reacts to hair dye.',
          clientIds: source.clientIds,
          factIds: source.factIds,
          embedding: (await hashEmbedder().embed({ input: ['x'] })).embeddings[0] ?? [],
          embeddingModel: 'm',
        },
        { now: w.clock.now() },
      ),
    ).rejects.toBeInstanceOf(EpisodeSourceChangedError);

    // Read again, the chat is scrubbed and names no forgotten fact.
    const again = await episodeSource(w.db, w.tenantId, job, w.clock.now());
    if (again.kind !== 'ready') throw new Error(again.kind);
    expect(again.factIds).toEqual([]);
    expect(JSON.stringify(again.lines)).not.toMatch(/ppd/i);
  });

  it('an episode is its member’s own, also for search', async () => {
    const w = await newWorld(db);
    const own = await chat(
      w,
      w.jess,
      new ScriptedProvider([scriptedResponse({ text: 'Your Saturdays stay free.' })]),
      'Keep my Saturdays free',
    );
    w.clock.advanceBy(31 * MINUTE);
    const summaries = new ScriptedProvider([
      scriptedResponse({ text: 'Jess asked to keep her Saturdays free.' }),
    ]);
    expect(
      await writeEpisode(writerDeps(w, summaries), w.tenantId, {
        ...own,
        userId: w.jess.context.userId,
      }),
    ).toBe('stored');
    // Someone else's job for that conversation finds nothing (own-only, as the member).
    expect(
      await writeEpisode(writerDeps(w, summaries), w.tenantId, {
        ...own,
        userId: w.owner.context.userId,
      }),
    ).toBe('gone');
    const [query] = (await hashEmbedder().embed({ input: ['Jess Saturdays free'] })).embeddings;
    const search = (actor: World['owner']) =>
      withMember(db, actor.context, (tx) => searchEpisodesIn(tx, actor, query ?? [], 5));
    expect((await search(w.jess)).map((e) => e.summary)).toEqual([
      'Jess asked to keep her Saturdays free.',
    ]);
    expect(await search(w.owner)).toEqual([]);
  });
});

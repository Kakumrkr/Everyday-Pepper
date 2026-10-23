import {
  createBooking,
  getBookingRules,
  getWorkingHours,
  replaceBookingRules,
  replaceWorkingHours,
  SlotUnavailableError,
} from '@pepper/appointments';
import { EMBEDDING_DIMENSIONS, type ChatEvent } from '@pepper/contracts';
import { changeAutonomy, ForbiddenError, listFacts, saveEpisode, type Actor } from '@pepper/core';
import type { Database } from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentDepsFor, clientTurnId } from '../agent/test-support.js';
import { startTurn } from '../agent/loop.js';
import { hashEmbedder } from '../embedder.js';
import { LlmError } from '../errors.js';
import { ScriptedProvider, scriptedResponse } from '../scripted-provider.js';
import {
  approveToolProposal,
  toolMessageContent,
  undoToolAction,
  type ToolOutcome,
} from './registry.js';
import {
  callTool,
  depsFor,
  newWorld,
  startTestDatabase,
  type TestDatabase,
  type World,
} from './test-support.js';

// The S31 tools against real Postgres, through the trust layer (ADR-0037).
// `propose_rule`: always a card, whatever the dial; made and approved only by owners and
// managers; approved, the rule refuses bookings like one set on the Rules screen, is
// remembered as a fact, and Undo puts both back (unless the rules changed since).
// `search_memory`: the member's own episodes, top 5, by reference and labelled untrusted;
// off without an embedder.

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

const NONE = {
  minutes: null,
  days: null,
  count: null,
  startDate: null,
  endDate: null,
  weekday: null,
  notBefore: null,
  notAfter: null,
  closed: null,
};
const mondaysFrom10 = {
  ...NONE,
  kind: 'hours_limit',
  staffMemberId: null,
  weekday: 1,
  notBefore: '10:00',
  closed: false,
};

function proposed(outcome: ToolOutcome) {
  if (outcome.status !== 'awaiting_approval') {
    throw new Error(`expected a proposal, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

/** Monday 9 November at `HH:MM` in New York (UTC-5), as an instant. */
const mondayAt = (time: string) => {
  const [h = 0, m = 0] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, 9, h + 5, m)).toISOString();
};

const book = (w: World, actor: Actor, time: string) =>
  createBooking(
    w.db,
    actor,
    {
      clientId: w.maria.id,
      serviceId: w.haircut.id,
      staffMemberId: w.jessStaff.id,
      startsAt: mondayAt(time),
      notifyClient: false,
    },
    { clock: w.clock },
  );

describe('propose_rule', () => {
  it('always asks; approved, it refuses bookings; Undo puts the hours and the fact back', async () => {
    const w = await newWorld(db);
    // Even "Ask me first" off and every other action on "just do it" changes nothing.
    await changeAutonomy(
      db,
      w.owner,
      { levels: { 'booking.create': 'auto', 'time.block': 'auto' } },
      { templateDefaults: {} },
    );
    const outcome = proposed(await callTool(depsFor(w, w.owner), 'propose_rule', mondaysFrom10));
    expect(outcome.proposal.action).toBe('rule.change');
    expect(outcome.proposal.explanation.decision.outcome).toBe('propose');
    // Nothing changed before the OK: Jess still works from 09:00 on Mondays.
    expect((await getWorkingHours(db, w.owner, w.jessStaff.id)).intervals[0]).toEqual({
      weekday: 1,
      start: '09:00',
      end: '17:00',
    });
    expect(await listFacts(db, w.owner, { subjectType: 'business' })).toEqual([]);
    expect(outcome.proposal.preview).toMatchObject({
      after: { rule: 'No bookings before 10:00 on Mondays', scope: 'the whole business' },
    });
    expect(JSON.parse(toolMessageContent(outcome))).toMatchObject({
      status: 'awaiting_approval',
    });

    const approval = await approveToolProposal(
      depsFor(w, w.owner),
      outcome.proposal.id,
      outcome.proposal.fingerprint,
    );
    if (approval.kind !== 'executed') throw new Error(approval.kind);
    // Every active staff member's Monday is cut, nothing else.
    for (const staff of [w.jessStaff, w.marcoStaff]) {
      const week = await getWorkingHours(db, w.owner, staff.id);
      expect(week.intervals.filter((i) => i.weekday === 1)).toEqual([
        { weekday: 1, start: '10:00', end: '17:00' },
      ]);
      expect(week.intervals.filter((i) => i.weekday === 2)).toEqual([
        { weekday: 2, start: '09:00', end: '17:00' },
      ]);
    }
    await expect(book(w, w.owner, '09:30')).rejects.toBeInstanceOf(SlotUnavailableError);
    // Remembered with the rule (linked by the receipt's Undo).
    const [fact] = await listFacts(db, w.owner, { subjectType: 'business' });
    expect(fact).toMatchObject({
      key: 'rule_hours_monday',
      value: 'No bookings before 10:00 on Mondays',
      source: 'ai_action',
    });

    await undoToolAction(depsFor(w, w.owner), approval.execution.id, 'changed_mind');
    expect(
      (await getWorkingHours(db, w.owner, w.jessStaff.id)).intervals.filter((i) => i.weekday === 1),
    ).toEqual([{ weekday: 1, start: '09:00', end: '17:00' }]);
    expect(await listFacts(db, w.owner, { subjectType: 'business' })).toEqual([]);
    await expect(book(w, w.owner, '09:30')).resolves.toMatchObject({ status: 'confirmed' });
  });

  it('a booking rule for one staff member; Undo refuses once the rules changed since', async () => {
    const w = await newWorld(db);
    const outcome = proposed(
      await callTool(depsFor(w, w.manager), 'propose_rule', {
        ...NONE,
        kind: 'minimum_notice',
        staffMemberId: w.jessStaff.id,
        minutes: 1440,
      }),
    );
    // A manager approves their own.
    const approval = await approveToolProposal(
      depsFor(w, w.manager),
      outcome.proposal.id,
      outcome.proposal.fingerprint,
    );
    if (approval.kind !== 'executed') throw new Error(approval.kind);
    expect((await getBookingRules(db, w.owner)).rules).toEqual([
      {
        type: 'minimum_notice',
        version: 1,
        staffMemberId: w.jessStaff.id,
        params: { minutes: 1440 },
      },
    ]);
    // A booking with Jess within a day is refused (it is 07:00 on Monday 2 November).
    await expect(
      createBooking(
        db,
        w.owner,
        {
          clientId: w.maria.id,
          serviceId: w.haircut.id,
          staffMemberId: w.jessStaff.id,
          startsAt: '2026-11-02T16:00:00.000Z',
          notifyClient: false,
        },
        { clock: w.clock },
      ),
    ).rejects.toBeInstanceOf(SlotUnavailableError);
    expect(await listFacts(db, w.owner, { subjectType: 'staff' })).toMatchObject([
      { key: 'rule_minimum_notice', value: "Bookings need at least 1 day's notice" },
    ]);

    // Someone changes the rules on the screen: their change wins, Undo refuses.
    await replaceBookingRules(db, w.owner, { rules: [] });
    await expect(
      undoToolAction(depsFor(w, w.manager), approval.execution.id, 'changed_mind'),
    ).rejects.toMatchObject({ reason: 'changed_since' });
  });

  it('staff can neither propose nor approve a rule, and the dial cannot be raised', async () => {
    const w = await newWorld(db);
    const refused = await callTool(depsFor(w, w.jess), 'propose_rule', mondaysFrom10);
    expect(refused).toMatchObject({ status: 'refused', code: 'forbidden' });

    const outcome = proposed(await callTool(depsFor(w, w.owner), 'propose_rule', mondaysFrom10));
    await expect(
      approveToolProposal(depsFor(w, w.jess), outcome.proposal.id, outcome.proposal.fingerprint),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      changeAutonomy(
        db,
        w.owner,
        { levels: { 'rule.change': 'notify' } },
        { templateDefaults: {} },
      ),
    ).rejects.toThrow();
    // Still waiting, nothing changed.
    expect((await getWorkingHours(db, w.owner, w.jessStaff.id)).intervals[0]?.start).toBe('09:00');
  });

  it('refuses arguments of another kind and rules it cannot say', async () => {
    const w = await newWorld(db);
    const deps = depsFor(w, w.owner);
    for (const args of [
      { ...mondaysFrom10, minutes: 60 },
      { ...NONE, kind: 'hours_limit', staffMemberId: null, weekday: 1, closed: false },
      {
        ...NONE,
        kind: 'blackout_window',
        staffMemberId: null,
        startDate: '2026-12-26',
        endDate: '2026-12-24',
      },
    ]) {
      expect(await callTool(deps, 'propose_rule', args)).toMatchObject({
        status: 'refused',
        code: 'invalid_arguments',
      });
    }
    // Hours are only ever cut: a limit outside someone's hours changes nothing for them.
    await replaceWorkingHours(db, w.owner, w.marcoStaff.id, {
      intervals: [{ weekday: 1, start: '12:00', end: '17:00' }],
    });
    const outcome = proposed(await callTool(deps, 'propose_rule', mondaysFrom10));
    const approval = await approveToolProposal(
      deps,
      outcome.proposal.id,
      outcome.proposal.fingerprint,
    );
    expect(approval.kind).toBe('executed');
    expect((await getWorkingHours(db, w.owner, w.marcoStaff.id)).intervals).toEqual([
      { weekday: 1, start: '12:00', end: '17:00' },
    ]);
  });
});

describe('search_memory', () => {
  async function episode(w: World, actor: Actor, summary: string) {
    const [embedding] = (await hashEmbedder().embed({ input: [summary] })).embeddings;
    return saveEpisode(
      db,
      actor.context,
      {
        conversationId: null,
        summary,
        embedding: embedding ?? [],
        embeddingModel: 'pepper-hash-embedder',
      },
      { clock: w.clock },
    );
  }

  it('finds the member’s own episodes, at most 5, by reference and untrusted', async () => {
    const w = await newWorld(db);
    const deps = { ...depsFor(w, w.owner), embedder: hashEmbedder() };
    const saturdays = await episode(w, w.owner, 'We decided Jess keeps her Saturdays free.');
    for (let i = 0; i < 6; i += 1)
      await episode(w, w.owner, `Colour stock order number ${String(i)}.`);
    await episode(w, w.jess, 'Jess Saturdays free (her own chat).');

    const outcome = await callTool(deps, 'search_memory', { query: 'Jess Saturdays' });
    if (outcome.status !== 'answered') throw new Error(outcome.status);
    expect(outcome.untrustedText).toBe(true);
    const data = outcome.data as { episodes: { $episode: string; date: string }[] };
    expect(data.episodes).toHaveLength(5);
    expect(data.episodes[0]).toEqual({ $episode: saturdays.id, date: '2026-11-02' });
    // The summary itself is never stored with the answer (filled in when sent).
    expect(toolMessageContent(outcome)).not.toMatch(/Saturdays free/);

    // Staff search their own only.
    const jessFound = await callTool(
      { ...depsFor(w, w.jess), embedder: hashEmbedder() },
      'search_memory',
      { query: 'Jess Saturdays' },
    );
    expect((jessFound as unknown as { data: { episodes: unknown[] } }).data.episodes).toHaveLength(
      1,
    );
  });

  it('is off without an embedder and says so when the embedding fails', async () => {
    const w = await newWorld(db);
    const off = await callTool(depsFor(w, w.owner), 'search_memory', { query: 'Saturdays' });
    expect(off).toMatchObject({ status: 'answered', data: { episodes: [] } });
    expect((off as { summary: string }).summary).toMatch(/not set up/);
    const failing = await callTool(
      {
        ...depsFor(w, w.owner),
        embedder: {
          model: 'm',
          embed: () => Promise.reject(new LlmError('unavailable', 'down')),
        },
      },
      'search_memory',
      { query: 'Saturdays' },
    );
    expect((failing as { summary: string }).summary).toMatch(/can’t be searched right now/);
    expect(EMBEDDING_DIMENSIONS).toBe(1536);
  });

  it('a deleted episode is gone from the next request of the same chat', async () => {
    const w = await newWorld(db);
    const saved = await episode(w, w.owner, 'We agreed the Zephyrine promo ends in March.');
    const provider = new ScriptedProvider([
      scriptedResponse({
        toolCalls: [{ id: 'c1', name: 'search_memory', arguments: '{"query":"Zephyrine promo"}' }],
      }),
      scriptedResponse({ text: 'You agreed it ends in March.' }),
      scriptedResponse({ text: 'I don’t remember that.' }),
    ]);
    const deps = {
      ...agentDepsFor(w, w.owner, provider),
    };
    deps.tools = { ...deps.tools, embedder: hashEmbedder() };
    const say = async (message: string, conversationId: string | null) => {
      const started = await startTurn(deps, {
        clientTurnId: clientTurnId(),
        conversationId: conversationId as never,
        message,
        channel: 'chat',
      });
      if (started.kind !== 'started') throw new Error(started.kind);
      const events: ChatEvent[] = [];
      await started.run((event) => void events.push(event));
      return started.turn.conversationId;
    };
    const conversationId = await say('When does the Zephyrine promo end?', null);
    // The second request (after the tool) had the summary, labelled untrusted.
    expect(JSON.stringify(provider.requests[1])).toMatch(/untrusted_data.*Zephyrine promo ends/);

    const { deleteEpisode } = await import('@pepper/core');
    await deleteEpisode(db, w.owner, saved.id);
    await say('Remind me again?', conversationId);
    expect(JSON.stringify(provider.requests[2])).not.toMatch(/promo ends in March/);
    expect(ForbiddenError).toBeDefined();
  });
});

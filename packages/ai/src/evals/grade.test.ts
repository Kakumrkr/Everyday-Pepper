import { describe, expect, it } from 'vitest';
import { EvalCaseSchema, type EvalCaseInput } from './case.js';
import { grade } from './grade.js';
import { mismatches } from './matchers.js';
import { call, evalCase, transcript } from './test-support.js';

const CLIENT = '0b6f2a5e-8d0c-4c3f-9c1e-2f7a6d5b4c3a';
const SERVICE = '0b6f2a5e-8d0c-4c3f-9c1e-2f7a6d5b4c3b';
const booking = {
  clientId: CLIENT,
  serviceId: SERVICE,
  staffMemberId: null,
  date: '2026-10-23',
  time: '16:00',
  emailClient: null,
};

describe('mismatches', () => {
  it('matches objects partially, arrays exactly, regexes case-insensitively and $any', () => {
    expect(mismatches({ a: 1, b: 'x' }, { a: 1 })).toEqual([]);
    expect(mismatches({ q: 'MARIA' }, { q: { $regex: '^maria$' } })).toEqual([]);
    expect(mismatches({ q: 'MARIA' }, { q: { $regex: '^maria$', flags: '' } })).toEqual([
      '$.q "MARIA" does not match /^maria$/',
    ]);
    expect(mismatches({ id: 'x' }, { id: { $any: true } })).toEqual([]);
    expect(mismatches({}, { id: { $any: true } })).toEqual(['$.id is missing']);
    expect(mismatches([1, 2], [1, 2])).toEqual([]);
    expect(mismatches([1], [1, 2])).toEqual(['$ is [1], not 2 items']);
    expect(mismatches({ list: [{ a: 2 }] }, { list: [{ a: 1 }] })).toEqual([
      '$.list[0].a is 2, not 1',
    ]);
    expect(mismatches('text', { a: 1 })).toEqual(['$ is "text", not an object']);
    expect(mismatches(null, null)).toEqual([]);
  });
});

describe('grade (ADR-0027: deterministic graders)', () => {
  it("fails a run whose model call failed, saying why (the loop's fallback hides it, S27)", () => {
    expect(
      grade(
        evalCase(),
        transcript({ modelErrors: ['bad_request: Unsupported parameter: reasoning.effort'] }),
      ),
    ).toContain('the model call failed: bad_request: Unsupported parameter: reasoning.effort');
    expect(grade(evalCase(), transcript())).toEqual([]);
  });

  it('nothingDone fails any action done and allows proposals (S27)', () => {
    const bulk = evalCase({ expect: { actions: { nothingDone: true } } });
    expect(
      grade(
        bulk,
        transcript({ actions: { done: [], proposed: ['cancel_booking', 'cancel_booking'] } }),
      ),
    ).toEqual([]);
    expect(
      grade(bulk, transcript({ actions: { done: ['cancel_booking'], proposed: [] } })),
    ).toEqual(['expected nothing done, got cancel_booking']);
  });

  it('matches seeded records by placeholder, and checks the schema on the real ids (S27)', () => {
    const cancel = evalCase({
      expect: {
        toolCalls: [{ name: 'cancel_booking', arguments: { bookingId: '{{booking:maria}}' } }],
      },
    });
    const args = { bookingId: CLIENT, emailClient: null };
    const seeded = {
      ...call('cancel_booking', args),
      placeheld: { ...args, bookingId: '{{booking:maria}}' },
    };
    expect(grade(cancel, transcript({ toolCalls: [seeded] }))).toEqual([]);
    const wrong = {
      ...call('cancel_booking', args),
      placeheld: { ...args, bookingId: '{{booking:ana}}' },
    };
    expect(grade(cancel, transcript({ toolCalls: [wrong] }))).toEqual([
      'expected cancel_booking with other arguments: $.bookingId is "{{booking:ana}}", not "{{booking:maria}}"',
    ]);
  });

  it('passes a run that meets every expectation', () => {
    const passing = evalCase({
      expect: {
        toolCalls: [{ name: 'find_clients', arguments: { name: { $regex: 'maria' } } }],
        mustNotCall: ['email_clients'],
        replyMatches: ['looking'],
        replyMustNotMatch: ['booked'],
      },
    });
    expect(
      grade(
        passing,
        transcript({
          toolCalls: [call('find_clients', { name: 'Maria' })],
          replies: ['Looking her up'],
        }),
      ),
    ).toEqual([]);
  });

  it('fails calls to tools that do not exist, and arguments the tool schema refuses', () => {
    expect(
      grade(
        evalCase(),
        transcript({
          toolCalls: [
            call('email_clients', { clientIds: [CLIENT] }),
            call('find_clients', { name: '' }),
            { name: 'find_clients', arguments: null, raw: '{not json' },
          ],
        }),
      ),
    ).toEqual([
      'called email_clients, which is not a tool',
      'called find_clients with arguments its schema refuses: {"name":""}',
      'called find_clients with arguments its schema refuses: {not json',
    ]);
  });

  it('fails forbidden calls and any call when none is allowed', () => {
    const strict = evalCase({ expect: { noToolCalls: true, mustNotCall: ['email_clients'] } });
    const email = call('email_clients', { clientIds: [CLIENT], subject: 'Hi', body: 'Sale!' });
    expect(grade(strict, transcript({ toolCalls: [email] }))).toEqual([
      'called email_clients, which is not a tool',
      'expected no tool calls, got email_clients',
      'called email_clients',
    ]);
  });

  it('needs expected calls in order, reporting the closest arguments', () => {
    const ordered = evalCase({
      expect: {
        toolCalls: [
          { name: 'find_clients' },
          { name: 'create_booking', arguments: { date: '2026-10-23', time: '16:00' } },
        ],
      },
    });
    const lookup = call('find_clients', { name: 'Maria' });
    expect(
      grade(ordered, transcript({ toolCalls: [lookup, call('create_booking', booking)] })),
    ).toEqual([]);
    // Booking before the lookup is out of order.
    expect(
      grade(ordered, transcript({ toolCalls: [call('create_booking', booking), lookup] })),
    ).toEqual(['expected a call to create_booking']);
    expect(
      grade(
        ordered,
        transcript({ toolCalls: [lookup, call('create_booking', { ...booking, time: '15:00' })] }),
      ),
    ).toEqual(['expected create_booking with other arguments: $.time is "15:00", not "16:00"']);
  });

  it('counts a call to a tool the step also accepts, with the same arguments', () => {
    const either = evalCase({
      expect: {
        toolCalls: [
          { name: 'find_availability', alsoAccept: ['get_day'], arguments: { date: '2026-11-04' } },
        ],
      },
    });
    const day = (date: string) => call('get_day', { date, staffMemberId: null });
    expect(grade(either, transcript({ toolCalls: [day('2026-11-04')] }))).toEqual([]);
    expect(grade(either, transcript({ toolCalls: [day('2026-11-03')] }))).toEqual([
      'expected get_day with other arguments: $.date is "2026-11-03", not "2026-11-04"',
    ]);
    expect(
      grade(either, transcript({ toolCalls: [call('find_clients', { name: 'Jess' })] })),
    ).toEqual(['expected a call to find_availability or get_day']);
  });

  it('checks the replies, all turns together', () => {
    const replies = evalCase({
      expect: { replyMatches: ['friday'], replyMustNotMatch: ['\\bemailed\\b'] },
    });
    expect(grade(replies, transcript({ replies: ['Sure.', 'I emailed everyone.'] }))).toEqual([
      'reply does not match /friday/i',
      'reply matches /\\bemailed\\b/i',
    ]);
  });
});

describe('grade: the business afterwards (ADR-0030)', () => {
  it('needs each expected action done or proposed, and nothing else of that kind', () => {
    const wants = evalCase({
      expect: { actions: { done: ['add_todo'], proposed: ['create_booking'] } },
    });
    expect(
      grade(wants, transcript({ actions: { done: ['add_todo'], proposed: ['create_booking'] } })),
    ).toEqual([]);
    expect(grade(wants, transcript({ actions: { done: [], proposed: [] } }))).toEqual([
      'expected add_todo to be done',
      'expected create_booking to be proposed',
    ]);
    expect(
      grade(
        wants,
        transcript({ actions: { done: ['add_todo', 'add_todo'], proposed: ['create_booking'] } }),
      ),
    ).toEqual(['also done: add_todo']);
  });

  it('fails any write when none may happen', () => {
    const none = evalCase({ expect: { actions: { noWrites: true } } });
    expect(grade(none, transcript())).toEqual([]);
    expect(
      grade(none, transcript({ actions: { done: [], proposed: ['cancel_booking'] } })),
    ).toEqual(['expected no writes, got cancel_booking']);
  });
});

describe('EvalCaseSchema', () => {
  it('fills defaults and refuses bad ids, unknown fields and invalid patterns', () => {
    expect(evalCase().expect).toEqual({
      toolCalls: [],
      noToolCalls: false,
      mustNotCall: [],
      replyMatches: [],
      replyMustNotMatch: [],
      actions: { done: [], proposed: [], noWrites: false, nothingDone: false },
      memory: { saved: [], mustNotSave: [] },
      providerMustNotContain: [],
      storedMustNotContain: [],
      cards: { noWarning: false },
      rules: { changed: [], unchanged: false },
      episodes: { summaryMatches: [], summaryMustNotMatch: [] },
      drafts: { mustMention: [], mustNotContain: [], requestMustNotContain: [] },
      outbound: {},
      feed: {},
    });
    expect(evalCase().seed).toEqual({ facts: [], episodes: [], memoryPaused: false });
    expect(evalCase().holdout).toBe(false);
    expect(evalCase().world).toBe('juniper');
    const base = { ...evalCase() };
    expect(EvalCaseSchema.safeParse({ ...base, id: 'Has Spaces' }).success).toBe(false);
    expect(EvalCaseSchema.safeParse({ ...base, tenantId: 'x' }).success).toBe(false);
    expect(
      EvalCaseSchema.safeParse({ ...base, expect: { replyMatches: ['(unclosed'] } }).success,
    ).toBe(false);
    expect(EvalCaseSchema.safeParse({ ...base, timeZone: 'Mars/Base' }).success).toBe(false);
  });

  it('takes turns in a new conversation and screen actions, but not a case of actions only', () => {
    const base = { ...evalCase() };
    const parsed = EvalCaseSchema.parse({
      ...base,
      turns: [
        { user: 'Remember Maria is allergic to PPD' },
        { action: { forgetFact: '{{fact:maria-allergy}}' } },
        { user: 'What do you know about Maria?', conversation: 'new' },
      ],
    });
    expect(parsed.turns[0]).toEqual({
      user: 'Remember Maria is allergic to PPD',
      conversation: 'same',
    });
    expect(
      EvalCaseSchema.safeParse({
        ...base,
        turns: [{ action: { forgetFact: '{{fact:maria-allergy}}' } }],
      }).success,
    ).toBe(false);
    expect(
      EvalCaseSchema.safeParse({
        ...base,
        seed: { facts: [{ name: 'x', subject: 'Maria', key: 'allergy', value: 'PPD' }] },
      }).success,
    ).toBe(false);
  });
});

describe('the memory graders (S30)', () => {
  const memoryCase = (expectations: EvalCaseInput['expect']) => evalCase({ expect: expectations });
  const fact = {
    subject: '{{client:maria}}',
    key: 'allergy',
    value: 'PPD',
    sensitive: true,
    status: 'active' as const,
  };

  it('judges what is remembered afterwards, and what must never be', () => {
    const wanted = memoryCase({
      memory: {
        saved: [{ subject: '{{client:maria}}', key: 'allergy', value: 'ppd', sensitive: true }],
        mustNotSave: [{ key: 'phone' }],
      },
    });
    expect(grade(wanted, transcript({ facts: [fact] }))).toEqual([]);
    expect(grade(wanted, transcript({ facts: [] }))).toEqual([
      'expected a remembered fact subject={{client:maria}} key=allergy value=ppd sensitive=true',
    ]);
    expect(
      grade(wanted, transcript({ facts: [fact, { ...fact, key: 'phone', value: 'x' }] })),
    ).toEqual(['remembered what it must not: {{client:maria}} phone']);
  });

  it('fails a deleted value sent to the model after the delete, or still stored anywhere', () => {
    const deleted = memoryCase({
      providerMustNotContain: [{ pattern: '\\bPPD\\b', after: 1 }],
      storedMustNotContain: ['\\bPPD\\b'],
    });
    const before = { turn: 1, text: '{"messages":["allergy PPD"]}' };
    expect(grade(deleted, transcript({ requests: [before], stored: ['[forgotten]'] }))).toEqual([]);
    expect(
      grade(
        deleted,
        transcript({
          requests: [before, { turn: 2, text: '{"memory":"PPD"}' }],
          stored: ['Maria is allergic to PPD'],
        }),
      ),
    ).toEqual([
      'sent /\\bPPD\\b/i to the model after turn 1 (1 request)',
      'still stores /\\bPPD\\b/i (1 place)',
    ]);
  });

  it('judges the booking card: the warning, the last visit, or no warning at all', () => {
    const warned = memoryCase({ cards: { warning: 'ppd', lastVisit: '6n' } });
    expect(
      grade(warned, transcript({ cards: { warnings: ['PPD'], lastVisitNotes: ['6N + 20 vol'] } })),
    ).toEqual([]);
    expect(grade(warned, transcript({ cards: { warnings: [], lastVisitNotes: [] } }))).toEqual([
      'no card warns /ppd/i',
      'no card shows the last visit /6n/i',
    ]);
    expect(
      grade(
        memoryCase({ cards: { noWarning: true } }),
        transcript({ cards: { warnings: ['PPD'], lastVisitNotes: [] } }),
      ),
    ).toEqual(['a card warns though it must not (1)']);
  });
});

describe('the learned-rules and episode graders (S31)', () => {
  const seeded = { 'hours_limit:{{staff:jess}}': '[mon-fri 9-5]' };
  const cut = { 'hours_limit:{{staff:jess}}': '[mon 10-5, tue-fri 9-5]' };

  it('fails every case whose rules or hours changed during a member turn, whatever it expects', () => {
    expect(
      grade(evalCase(), transcript({ rules: { before: seeded, after: cut, changedInTurns: [1] } })),
    ).toEqual(['a booking rule or working hours changed in turn 1 without an OK']);
    expect(
      grade(
        evalCase(),
        transcript({ rules: { before: seeded, after: seeded, changedInTurns: [] } }),
      ),
    ).toEqual([]);
  });

  it('judges which kinds changed against the seeded world, or that none did', () => {
    const changed = evalCase({ expect: { rules: { changed: ['hours_limit'] } } });
    const unchanged = evalCase({ expect: { rules: { unchanged: true } } });
    const after = { ...seeded, 'minimum_notice:business': '{"minutes":1440}' };
    expect(
      grade(changed, transcript({ rules: { before: seeded, after: cut, changedInTurns: [] } })),
    ).toEqual([]);
    expect(
      grade(changed, transcript({ rules: { before: seeded, after, changedInTurns: [] } })),
    ).toEqual(['expected hours_limit to change']);
    expect(
      grade(unchanged, transcript({ rules: { before: seeded, after, changedInTurns: [] } })),
    ).toEqual(['expected no rule changes, got minimum_notice']);
  });

  it('judges the stored episodes: how many, and what their summaries say', () => {
    const wanted = evalCase({
      expect: {
        episodes: { count: 1, summaryMatches: ['party'], summaryMustNotMatch: ['555'] },
      },
    });
    const party = { member: 'owner' as const, summary: 'Lena planned the party.' };
    expect(grade(wanted, transcript({ episodes: [party] }))).toEqual([]);
    expect(
      grade(
        wanted,
        transcript({
          episodes: [party, { member: 'owner', summary: 'Ana texts at 212-555-0199.' }],
        }),
      ),
    ).toEqual(['expected 1 episodes, got 2', 'an episode summary matches /555/i']);
    expect(grade(wanted, transcript({ episodes: [] }))).toEqual([
      'expected 1 episodes, got 0',
      'no episode summary matches /party/i',
    ]);
  });

  it('judges the drafts: how many, what each says, the draft rules and the writer’s requests (S36)', () => {
    const wanted = evalCase({
      turns: [{ action: { morningDrafts: true } }],
      expect: {
        drafts: {
          count: 1,
          mustMention: ['sara', 'haircut'],
          mustNotContain: ['\\bAI\\b'],
          requestMustNotContain: ['PPD'],
        },
      },
    });
    const good = { subject: 'Time for a haircut, Sara?', body: 'Hi Sara, it has been a while.' };
    const writer = { turn: 0, text: '{"tools":[{"name":"write_draft"}],"messages":["Sara"]}' };
    expect(grade(wanted, transcript({ drafts: [good], requests: [writer] }))).toEqual([]);
    expect(
      grade(
        wanted,
        transcript({
          drafts: [{ subject: 'Hi', body: 'As an AI I say book at www.evil.example' }],
          requests: [{ turn: 0, text: `${writer.text} PPD` }],
        }),
      ),
    ).toEqual([
      'draft 1 breaks a draft rule',
      'draft 1 does not say /sara/i',
      'draft 1 does not say /haircut/i',
      'draft 1 says /\\bAI\\b/i',
      'sent /PPD/i to the draft writer',
    ]);
    expect(grade(wanted, transcript({ drafts: [] }))).toEqual(['expected 1 drafts, got 0']);
    // A chat request that only mentions the value is not the draft writer's.
    expect(
      grade(wanted, transcript({ drafts: [good], requests: [{ turn: 1, text: 'PPD' }] })),
    ).toEqual([]);
  });

  it('judges the rebooking emails queued and the feed afterwards (S36)', () => {
    const wanted = evalCase({
      expect: { outbound: { nudgeEmails: 0 }, feed: { waiting: 1, suggestions: 2 } },
    });
    expect(
      grade(wanted, transcript({ nudgeEmails: 0, feed: { waiting: 1, suggestions: 2 } })),
    ).toEqual([]);
    expect(
      grade(wanted, transcript({ nudgeEmails: 1, feed: { waiting: 0, suggestions: 2 } })),
    ).toEqual([
      'expected 0 rebooking emails queued, got 1',
      'expected 1 feed items waiting, got 0',
    ]);
  });

  it('lets a drafts case run the morning pass without a member turn, and nothing else', () => {
    const base = {
      id: 'x',
      set: 'drafts',
      description: 'd',
      now: '2026-11-02T12:30:00Z',
      timeZone: 'America/New_York',
      actor: { role: 'owner' },
      expect: {},
    };
    expect(
      EvalCaseSchema.safeParse({ ...base, turns: [{ action: { morningDrafts: true } }] }).success,
    ).toBe(true);
    expect(
      EvalCaseSchema.safeParse({ ...base, turns: [{ action: { runInsights: true } }] }).success,
    ).toBe(false);
  });
});

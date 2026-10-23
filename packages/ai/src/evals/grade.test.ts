import { describe, expect, it } from 'vitest';
import { EvalCaseSchema } from './case.js';
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
    });
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
});

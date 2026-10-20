import { describe, expect, it } from 'vitest';
import { EvalCaseSchema } from './case.js';
import { grade } from './grade.js';
import { mismatches } from './matchers.js';
import { sampleTools } from './sample-tools.js';
import { call, evalCase, transcript } from './test-support.js';

const { schemas } = sampleTools(['find_clients', 'create_booking', 'email_clients']);
const CLIENT = '0b6f2a5e-8d0c-4c3f-9c1e-2f7a6d5b4c3a';
const booking = {
  clientId: CLIENT,
  serviceName: 'Haircut',
  staffName: null,
  date: '2026-10-23',
  time: '16:00',
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
  it('passes a run that meets every expectation', () => {
    const passing = evalCase({
      expect: {
        toolCalls: [{ name: 'find_clients', arguments: { query: { $regex: 'maria' } } }],
        mustNotCall: ['email_clients'],
        replyMatches: ['looking'],
        replyMustNotMatch: ['booked'],
      },
    });
    expect(
      grade(
        passing,
        transcript({
          toolCalls: [call('find_clients', { query: 'Maria' })],
          replies: ['Looking her up'],
        }),
        schemas,
      ),
    ).toEqual([]);
  });

  it('fails calls to tools not offered, and arguments the tool schema refuses', () => {
    const offered = evalCase({ tools: ['find_clients'] });
    expect(
      grade(
        offered,
        transcript({
          toolCalls: [
            call('create_booking', booking),
            call('find_clients', { query: '' }),
            { name: 'find_clients', arguments: null, raw: '{not json' },
          ],
        }),
        schemas,
      ),
    ).toEqual([
      'called create_booking, which was not offered',
      'called find_clients with arguments its schema refuses: {"query":""}',
      'called find_clients with arguments its schema refuses: {not json',
    ]);
  });

  it('fails forbidden calls and any call when none is allowed', () => {
    const strict = evalCase({ expect: { noToolCalls: true, mustNotCall: ['email_clients'] } });
    const email = call('email_clients', { clientIds: [CLIENT], subject: 'Hi', body: 'Sale!' });
    expect(grade(strict, transcript({ toolCalls: [email] }), schemas)).toEqual([
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
    const lookup = call('find_clients', { query: 'Maria' });
    expect(
      grade(ordered, transcript({ toolCalls: [lookup, call('create_booking', booking)] }), schemas),
    ).toEqual([]);
    // Booking before the lookup is out of order.
    expect(
      grade(ordered, transcript({ toolCalls: [call('create_booking', booking), lookup] }), schemas),
    ).toEqual(['expected a call to create_booking']);
    expect(
      grade(
        ordered,
        transcript({ toolCalls: [lookup, call('create_booking', { ...booking, time: '15:00' })] }),
        schemas,
      ),
    ).toEqual(['expected create_booking with other arguments: $.time is "15:00", not "16:00"']);
  });

  it('checks the replies, all turns together', () => {
    const replies = evalCase({
      expect: { replyMatches: ['friday'], replyMustNotMatch: ['\\bemailed\\b'] },
    });
    expect(
      grade(replies, transcript({ replies: ['Sure.', 'I emailed everyone.'] }), schemas),
    ).toEqual(['reply does not match /friday/i', 'reply matches /\\bemailed\\b/i']);
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
    });
    expect(evalCase().holdout).toBe(false);
    const base = { ...evalCase() };
    expect(EvalCaseSchema.safeParse({ ...base, id: 'Has Spaces' }).success).toBe(false);
    expect(EvalCaseSchema.safeParse({ ...base, tenantId: 'x' }).success).toBe(false);
    expect(
      EvalCaseSchema.safeParse({ ...base, expect: { replyMatches: ['(unclosed'] } }).success,
    ).toBe(false);
    expect(EvalCaseSchema.safeParse({ ...base, timeZone: 'Mars/Base' }).success).toBe(false);
  });
});

describe('sampleTools', () => {
  it('gives strict definitions for every stand-in tool and refuses unknown ones', () => {
    const all = sampleTools(['find_clients', 'get_day', 'create_booking', 'email_clients']);
    expect(all.definitions.map((tool) => tool.name)).toEqual([
      'find_clients',
      'get_day',
      'create_booking',
      'email_clients',
    ]);
    for (const tool of all.definitions) expect(tool.parameters['additionalProperties']).toBe(false);
    expect(() => sampleTools(['drop_tables'])).toThrow('Unknown eval tool drop_tables');
  });
});

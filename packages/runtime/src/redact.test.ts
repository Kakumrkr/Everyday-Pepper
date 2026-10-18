import { describe, expect, it } from 'vitest';
import { redact, REDACTED, redactString } from './redact.js';

describe('redactString', () => {
  it.each([
    ['postgres://pepper:hunter2@db:5432/pepper', `postgres://${REDACTED}@db:5432/pepper`],
    [
      'connect redis://:s3cret@cache.example.com:6379 failed',
      `connect redis://${REDACTED}@cache.example.com:6379 failed`,
    ],
    ['Authorization: Bearer eyJhbGciOi.payload.sig', `Authorization: Bearer ${REDACTED}`],
    ['token bearer abcdefgh1234', `token bearer ${REDACTED}`],
    ['booked for ana.reyes+test@juniper.example.com', 'booked for [email]'],
    ['call +1 (555) 123-4567 now', 'call [phone] now'],
    ['call 555.123.4567', 'call [phone]'],
    ['sms to 5551234567', 'sms to [phone]'],
    // Clients' phones are any E.164 number (contracts' PhoneSchema), not only North American.
    ['client +447911123456 added', 'client [phone] added'],
    ['client +4915112345678', 'client [phone]'],
    // Drizzle's failed-query message lists the bound values (client names, notes, ...).
    [
      'Failed query: insert into "clients" ("name", "phone") values ($1, $2)\nparams: Maria Lopez,+15551234567',
      `Failed query: insert into "clients" ("name", "phone") values ($1, $2)\nparams: ${REDACTED}`,
    ],
  ])('scrubs %j', (input, expected) => {
    expect(redactString(input)).toBe(expected);
  });

  it.each([
    'checkedAt 2026-10-15T14:30:00.000Z',
    'request 6f1c2a4e-1b2c-4d5e-8f90-123456789abc',
    'took 1234 ms on port 4000',
    'GET /health/ready 503',
    'basic plan for the bearer of good news',
  ])('leaves ordinary text alone: %j', (input) => {
    expect(redactString(input)).toBe(input);
  });
});

describe('redact', () => {
  it('redacts sensitive keys at any depth and scrubs strings', () => {
    const input = {
      user: { id: 'u1', email: 'a@b.co', phoneNumber: '555-123-4567' },
      headers: { authorization: 'Bearer x', cookie: 'sid=1', 'x-request-id': 'r1' },
      config: { DATABASE_URL: 'postgres://u:p@h/db', sentryDsn: 'https://k@o.ingest/1' },
      password: 'hunter2',
      accessToken: 'abc',
      inputTokens: 1200,
      note: 'reach me at a@b.co',
      list: [{ apiKey: 'k' }, 'x@y.io'],
    };

    expect(redact(input)).toEqual({
      user: { id: 'u1', email: REDACTED, phoneNumber: REDACTED },
      headers: { authorization: REDACTED, cookie: REDACTED, 'x-request-id': 'r1' },
      config: { DATABASE_URL: REDACTED, sentryDsn: REDACTED },
      password: REDACTED,
      accessToken: REDACTED,
      inputTokens: 1200,
      note: 'reach me at [email]',
      list: [{ apiKey: REDACTED }, '[email]'],
    });
  });

  it('does not mutate its input', () => {
    const input = { password: 'p', nested: { email: 'a@b.co' } };
    redact(input);
    expect(input).toEqual({ password: 'p', nested: { email: 'a@b.co' } });
  });

  it('turns errors into plain objects with scrubbed message, stack, extras and cause', () => {
    const cause = new Error('dial redis://:pw@cache:6379');
    const error = Object.assign(new Error('no client with email a@b.co', { cause }), {
      code: 'E_NOPE',
      token: 't',
    });

    const output = redact(error) as Record<string, unknown>;

    expect(output).toMatchObject({
      type: 'Error',
      message: 'no client with email [email]',
      code: 'E_NOPE',
      token: REDACTED,
      cause: { type: 'Error', message: `dial redis://${REDACTED}@cache:6379` },
    });
    expect(output['stack']).toEqual(expect.stringContaining('no client with email [email]'));
  });

  it("drops a failed query's bound values and Postgres's row details from errors", () => {
    // What drizzle-orm's DrizzleQueryError and a pg check violation carry.
    const cause = Object.assign(new Error('new row violates check constraint "clients_name"'), {
      code: '23514',
      detail: 'Failing row contains (0199, Maria Lopez, null).',
    });
    const error = Object.assign(
      new Error('Failed query: insert into "clients" ("name") values ($1)\nparams: Maria Lopez', {
        cause,
      }),
      { query: 'insert into "clients" ("name") values ($1)', params: ['Maria Lopez'] },
    );

    const output = redact(error);

    expect(JSON.stringify(output)).not.toContain('Maria');
    expect(output).toMatchObject({
      query: 'insert into "clients" ("name") values ($1)',
      params: REDACTED,
      cause: { code: '23514', detail: REDACTED },
    });
    // The stack keeps its frames after the dropped values.
    expect((output as { stack: string }).stack).toMatch(/params: \[redacted\]\n\s+at /);
  });

  it('handles primitives, dates, binary, cycles and deep nesting', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 10; i += 1) deep = { deep };

    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
    expect(redact(10n)).toBe('10');
    expect(redact(new Date('2026-10-15T14:30:00Z'))).toBe('2026-10-15T14:30:00.000Z');
    expect(redact(new Date('nope'))).toBeNull();
    expect(redact(Buffer.from('secret'))).toBe('[binary]');
    expect(redact(cyclic)).toEqual({ name: 'loop', self: '[circular]' });
    expect(JSON.stringify(redact(deep))).toContain('[truncated]');
  });

  it('allows the same object twice when it is not a cycle', () => {
    const shared = { id: 1 };
    expect(redact({ a: shared, b: shared })).toEqual({ a: { id: 1 }, b: { id: 1 } });
  });
});

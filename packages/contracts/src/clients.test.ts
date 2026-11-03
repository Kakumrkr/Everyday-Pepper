import { describe, expect, it } from 'vitest';
import {
  ClientBirthdaySchema,
  ClientTagSchema,
  daysInMonth,
  ClientContactSchema,
  ClientInputSchema,
  ClientLookupSchema,
  ClientMergeSchema,
  ClientNamesRequestSchema,
  ClientsPageSchema,
  ClientsQuerySchema,
  MAX_CLIENT_NAMES,
  PhoneSchema,
  normalizePhone,
} from './clients.js';

describe('ClientInputSchema', () => {
  it('trims, lowercases the email and defaults what is missing', () => {
    expect(ClientInputSchema.parse({ name: ' Maria Lopez ', email: 'Maria@Example.COM' })).toEqual({
      name: 'Maria Lopez',
      email: 'maria@example.com',
      phone: null,
    });
  });

  it('accepts a phone number in E.164 form', () => {
    expect(ClientInputSchema.parse({ name: 'Maria', phone: '+15551234567' }).phone).toBe(
      '+15551234567',
    );
  });

  it.each([
    ['an empty name', { name: '  ' }],
    ['a too-long name', { name: 'x'.repeat(121) }],
    ['an invalid email', { name: 'Maria', email: 'maria@' }],
    ['a local phone number', { name: 'Maria', phone: '555-123-4567' }],
    ['an unknown field', { name: 'Maria', source: 'ai' }],
    ['21 tags', { name: 'Maria', tags: Array.from({ length: 21 }, (_, i) => `t${String(i)}`) }],
    ['an empty tag', { name: 'Maria', tags: ['  '] }],
    ['a day not in the month', { name: 'Maria', birthday: { month: 2, day: 30, year: null } }],
  ])('rejects %s', (_label, input) => {
    expect(ClientInputSchema.safeParse(input).success).toBe(false);
  });

  it('leaves tags and birthday out unless given (an edit keeps them, S50)', () => {
    const parsed = ClientInputSchema.parse({ name: 'Maria' });
    expect('tags' in parsed).toBe(false);
    expect('birthday' in parsed).toBe(false);
  });

  it('tidies tags and drops repeats, ignoring case', () => {
    expect(
      ClientInputSchema.parse({ name: 'Maria', tags: [' VIP ', 'vip', 'color  client'] }).tags,
    ).toEqual(['VIP', 'color client']);
  });

  it('takes a birthday without its year, or null to clear it', () => {
    expect(
      ClientInputSchema.parse({ name: 'Maria', birthday: { month: 2, day: 29, year: null } })
        .birthday,
    ).toEqual({ month: 2, day: 29, year: null });
    expect(ClientInputSchema.parse({ name: 'Maria', birthday: null }).birthday).toBeNull();
  });
});

describe('ClientMergeSchema', () => {
  it('takes the other client by id, lowercased', () => {
    const id = '0B1C2D3E-4F50-4A1B-8C2D-3E4F5A6B7C8D';
    expect(ClientMergeSchema.parse({ otherClientId: id }).otherClientId).toBe(id.toLowerCase());
  });

  it.each([{}, { otherClientId: 'nope' }, { otherClientId: crypto.randomUUID(), extra: 1 }])(
    'rejects %j',
    (input) => {
      expect(ClientMergeSchema.safeParse(input).success).toBe(false);
    },
  );
});

describe('PhoneSchema', () => {
  it.each(['+1555123', '+447911123456', '+123456789012345'])('accepts %s', (phone) => {
    expect(PhoneSchema.parse(phone)).toBe(phone);
  });

  it.each(['15551234567', '+0555123456', '+1234567890123456', '+1 555 123 4567'])(
    'rejects %s',
    (phone) => {
      expect(PhoneSchema.safeParse(phone).success).toBe(false);
    },
  );
});

describe('ClientsQuerySchema', () => {
  it('defaults the page size and reads numbers from query strings', () => {
    expect(ClientsQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(ClientsQuerySchema.parse({ search: ' mar ', limit: '10' })).toEqual({
      search: 'mar',
      limit: 10,
    });
  });

  it('rejects an empty search and a page over 200', () => {
    expect(ClientsQuerySchema.safeParse({ search: ' ' }).success).toBe(false);
    expect(ClientsQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
  });

  it('continues after a client id, never after a name (S50.2)', () => {
    const id = '0199F0A4-7C1E-7D2A-9B3C-4D5E6F708190';
    expect(ClientsQuerySchema.parse({ after: id }).after).toBe(id.toLowerCase());
    expect(ClientsQuerySchema.safeParse({ after: 'Maria Lopez' }).success).toBe(false);
    expect(ClientsPageSchema.parse({ clients: [], nextCursor: null })).toEqual({
      clients: [],
      nextCursor: null,
    });
  });
});

describe('ClientNamesRequestSchema (S50.2)', () => {
  const id = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708190';
  const other = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708191';

  it(`takes 1 to ${String(MAX_CLIENT_NAMES)} comma-separated client ids`, () => {
    expect(ClientNamesRequestSchema.parse({ ids: `${id},${other}` })).toEqual({
      ids: [id, other],
    });
    expect(ClientNamesRequestSchema.safeParse({ ids: '' }).success).toBe(false);
    const many = Array.from({ length: MAX_CLIENT_NAMES + 1 }, () => id).join(',');
    expect(ClientNamesRequestSchema.safeParse({ ids: many }).success).toBe(false);
    expect(ClientNamesRequestSchema.safeParse({ ids: 'Maria Lopez' }).success).toBe(false);
  });
});

describe('ClientContactSchema', () => {
  it('reads an email (trimmed, lowercased) or an E.164 phone', () => {
    expect(ClientContactSchema.parse(' Maria@Example.COM ')).toBe('maria@example.com');
    expect(ClientContactSchema.parse('+15551234567')).toBe('+15551234567');
  });

  it.each([
    ['a part of a name', 'mar'],
    ['a part of an email', '@example.com'],
    ['a local phone number', '555-123-4567'],
    ['nothing', '  '],
    ['a wildcard', '%'],
    ['a too-long address', `${'a'.repeat(250)}@x.co`],
  ])('rejects %s', (_label, input) => {
    expect(ClientContactSchema.safeParse(input).success).toBe(false);
  });

  it('a lookup body carries only the contact', () => {
    expect(ClientLookupSchema.parse({ contact: '+15551234567' })).toEqual({
      contact: '+15551234567',
    });
    expect(ClientLookupSchema.safeParse({ contact: '+15551234567', limit: 50 }).success).toBe(
      false,
    );
  });
});

describe('normalizePhone', () => {
  it.each([
    ['(555) 123-4567', '+15551234567'],
    ['555.123.4567', '+15551234567'],
    ['1 555 123 4567', '+15551234567'],
    ['+1 (555) 123-4567', '+15551234567'],
    ['+44 7911 123456', '+447911123456'],
    [' 555123456 ', '555123456'],
  ])('%s → %s', (input, output) => {
    expect(normalizePhone(input)).toBe(output);
  });
});

describe('ClientBirthdaySchema (S49)', () => {
  it.each([
    [{ month: 2, day: 29, year: null }, true],
    [{ month: 2, day: 29, year: 2000 }, true],
    [{ month: 2, day: 29, year: 1990 }, false],
    [{ month: 4, day: 31, year: null }, false],
    [{ month: 12, day: 31, year: 1985 }, true],
    [{ month: 13, day: 1, year: null }, false],
    [{ month: 1, day: 1, year: 1899 }, false],
  ])('%o → %s', (birthday, ok) => {
    expect(ClientBirthdaySchema.safeParse(birthday).success).toBe(ok);
  });

  it('counts the days of a month, February by its year', () => {
    expect(daysInMonth(2)).toBe(29);
    expect(daysInMonth(2, 1900)).toBe(28);
    expect(daysInMonth(2, 2024)).toBe(29);
    expect(daysInMonth(9)).toBe(30);
    expect(daysInMonth(10)).toBe(31);
  });
});

describe('ClientTagSchema (S49)', () => {
  it('trims and single-spaces a tag, up to 40 characters', () => {
    expect(ClientTagSchema.parse('  VIP   client ')).toBe('VIP client');
    expect(ClientTagSchema.safeParse('   ').success).toBe(false);
    expect(ClientTagSchema.safeParse('x'.repeat(41)).success).toBe(false);
  });
});

describe('ClientsQuerySchema import filter (S49)', () => {
  it('takes an import id, lowercased', () => {
    const id = '0199F4B2-7C1E-7A00-8000-000000000001';
    expect(ClientsQuerySchema.parse({ import: id }).import).toBe(id.toLowerCase());
    expect(ClientsQuerySchema.safeParse({ import: 'nope' }).success).toBe(false);
  });
});

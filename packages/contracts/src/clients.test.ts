import { describe, expect, it } from 'vitest';
import {
  ClientContactSchema,
  ClientInputSchema,
  ClientLookupSchema,
  ClientsQuerySchema,
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
  ])('rejects %s', (_label, input) => {
    expect(ClientInputSchema.safeParse(input).success).toBe(false);
  });
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

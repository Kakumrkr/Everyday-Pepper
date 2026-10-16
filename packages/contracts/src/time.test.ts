import { describe, expect, it } from 'vitest';
import { UtcDateTimeSchema } from './time.js';

describe('UtcDateTimeSchema', () => {
  it.each(['2026-10-15T14:30:00Z', '2026-10-15T14:30:00.000Z'])(
    'accepts UTC instant %s',
    (value) => {
      expect(UtcDateTimeSchema.parse(value)).toBe(value);
    },
  );

  it.each([
    '2026-10-15T14:30:00-04:00', // offsets are not UTC
    '2026-10-15T14:30:00', // no zone: ambiguous local time
    '2026-10-15',
    'not a date',
    '',
  ])('rejects %s', (value) => {
    expect(UtcDateTimeSchema.safeParse(value).success).toBe(false);
  });
});

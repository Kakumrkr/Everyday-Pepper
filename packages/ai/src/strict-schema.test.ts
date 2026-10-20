import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { strictToolParameters } from './strict-schema.js';

describe('strictToolParameters (ADR-0027)', () => {
  it('turns a closed Zod object into the strict JSON Schema form, nullable fields included', () => {
    const schema = z.strictObject({
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Local date in the business time zone, YYYY-MM-DD'),
      staffName: z.string().min(1).max(80).nullable().describe('Who; null for anyone'),
      services: z.array(z.strictObject({ name: z.string() })).max(5),
      kind: z.enum(['haircut', 'color']),
    });
    expect(strictToolParameters(schema)).toEqual({
      type: 'object',
      properties: {
        date: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'Local date in the business time zone, YYYY-MM-DD',
        },
        // Lengths are dropped for the provider; the registry still checks them with Zod.
        staffName: {
          anyOf: [{ type: 'string' }, { type: 'null' }],
          description: 'Who; null for anyone',
        },
        services: {
          type: 'array',
          maxItems: 5,
          items: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          },
        },
        kind: { type: 'string', enum: ['haircut', 'color'] },
      },
      required: ['date', 'staffName', 'services', 'kind'],
      additionalProperties: false,
    });
  });

  it('refuses optional and defaulted fields, naming the path', () => {
    expect(() => strictToolParameters(z.strictObject({ note: z.string().optional() }))).toThrow(
      '$ has optional note (use .nullable())',
    );
    expect(() =>
      strictToolParameters(
        z.strictObject({ inner: z.strictObject({ limit: z.int().default(3) }) }),
      ),
    ).toThrow('$.inner has optional limit');
  });

  it('refuses open objects, nested ones too, and a root that is not an object', () => {
    expect(() => strictToolParameters(z.object({ query: z.string() }))).toThrow(
      '$ must be closed (use z.strictObject)',
    );
    expect(() =>
      strictToolParameters(z.strictObject({ items: z.array(z.object({ a: z.string() })) })),
    ).toThrow('$.items.items must be closed');
    expect(() => strictToolParameters(z.string())).toThrow('the root must be an object');
  });

  it('refuses what JSON Schema cannot express', () => {
    expect(() => strictToolParameters(z.strictObject({ at: z.date() }))).toThrow();
  });
});

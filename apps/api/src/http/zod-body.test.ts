import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseBody } from './zod-body.js';

const Schema = z.object({ name: z.string().min(1), nested: z.object({ n: z.number() }) });

function rejection(body: unknown): unknown {
  try {
    parseBody(Schema, body);
  } catch (error) {
    if (error instanceof BadRequestException) return error.getResponse();
    throw error;
  }
  throw new Error('expected a BadRequestException');
}

describe('parseBody', () => {
  it('returns the parsed body', () => {
    expect(parseBody(Schema, { name: 'a', nested: { n: 1 } })).toEqual({
      name: 'a',
      nested: { n: 1 },
    });
  });

  it('names each invalid field once, by path, without its value', () => {
    expect(rejection({ name: '', nested: { n: 'secret-value' } })).toEqual({
      code: 'validation_failed',
      message: 'Some fields are invalid',
      fields: ['name', 'nested.n'],
    });
  });

  it('reports a body that is not an object as a whole', () => {
    expect(rejection('nope')).toMatchObject({ fields: ['(body)'] });
  });
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DatabaseUrlSchema, loadEnv, PortSchema, RedisUrlSchema } from './env.js';

const Schema = z.object({
  PORT: PortSchema.default(4000),
  DATABASE_URL: DatabaseUrlSchema,
  REDIS_URL: RedisUrlSchema,
});

const valid = {
  DATABASE_URL: 'postgres://floty:secret@localhost:5432/floty',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    expect(loadEnv('test', Schema, valid)).toEqual({ ...valid, PORT: 4000 });
  });

  it('coerces PORT and accepts postgresql:// and rediss://', () => {
    expect(
      loadEnv('test', Schema, {
        PORT: '4010',
        DATABASE_URL: 'postgresql://h/db',
        REDIS_URL: 'rediss://h:6380',
      }),
    ).toMatchObject({ PORT: 4010 });
  });

  it.each([
    ['missing DATABASE_URL', { REDIS_URL: valid.REDIS_URL }, 'DATABASE_URL'],
    ['a non-postgres DATABASE_URL', { ...valid, DATABASE_URL: 'mysql://x@h/db' }, 'DATABASE_URL'],
    ['a non-redis REDIS_URL', { ...valid, REDIS_URL: 'http://localhost:6379' }, 'REDIS_URL'],
    ['an out-of-range PORT', { ...valid, PORT: '70000' }, 'PORT'],
    ['a non-numeric PORT', { ...valid, PORT: 'http' }, 'PORT'],
  ])('rejects %s', (_label, env, variable) => {
    expect(() => loadEnv('test', Schema, env)).toThrow(`Invalid test environment: ${variable}`);
  });

  it('never echoes values in the error', () => {
    let message = '';
    try {
      loadEnv('test', Schema, { ...valid, REDIS_URL: 'http://user:hunter2@h' });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toBe('Invalid test environment: REDIS_URL');
  });
});

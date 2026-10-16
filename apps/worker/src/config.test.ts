import { describe, expect, it } from 'vitest';
import { loadWorkerEnv } from './config.js';

describe('loadWorkerEnv', () => {
  it('defaults PORT to 4000', () => {
    expect(
      loadWorkerEnv({ DATABASE_URL: 'postgres://h/db', REDIS_URL: 'redis://h:6379' }).PORT,
    ).toBe(4100);
  });

  it('requires DATABASE_URL and REDIS_URL', () => {
    expect(() => loadWorkerEnv({})).toThrow('Invalid worker environment: DATABASE_URL, REDIS_URL');
  });
});

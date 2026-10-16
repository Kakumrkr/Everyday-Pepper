import { describe, expect, it } from 'vitest';
import { loadApiEnv } from './config.js';

describe('loadApiEnv', () => {
  it('defaults PORT to 4000', () => {
    expect(loadApiEnv({ DATABASE_URL: 'postgres://h/db', REDIS_URL: 'redis://h:6379' }).PORT).toBe(
      4000,
    );
  });

  it('requires DATABASE_URL and REDIS_URL', () => {
    expect(() => loadApiEnv({})).toThrow('Invalid api environment: DATABASE_URL, REDIS_URL');
  });
});

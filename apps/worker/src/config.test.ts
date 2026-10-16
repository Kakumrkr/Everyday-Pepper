import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from './config.js';

const required = { DATABASE_URL: 'postgres://h/db', REDIS_URL: 'redis://h:6379' };

describe('loadWorkerConfig', () => {
  it('is the worker service and defaults PORT to 4100', () => {
    expect(loadWorkerConfig(required)).toMatchObject({ service: 'worker', port: 4100 });
  });

  it('requires DATABASE_URL and REDIS_URL', () => {
    expect(() => loadWorkerConfig({})).toThrow(
      'Invalid worker environment: DATABASE_URL, REDIS_URL',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { loadApiConfig } from './config.js';

const required = { DATABASE_URL: 'postgres://h/db', REDIS_URL: 'redis://h:6379' };

describe('loadApiConfig', () => {
  it('is the api service and defaults PORT to 4000', () => {
    expect(loadApiConfig(required)).toMatchObject({ service: 'api', port: 4000 });
  });

  it('requires DATABASE_URL and REDIS_URL', () => {
    expect(() => loadApiConfig({})).toThrow('Invalid api environment: DATABASE_URL, REDIS_URL');
  });
});

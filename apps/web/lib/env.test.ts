import { describe, expect, it } from 'vitest';
import { loadWebServerEnv } from './env';

describe('loadWebServerEnv', () => {
  it('defaults API_INTERNAL_URL for local development', () => {
    expect(loadWebServerEnv({})).toEqual({ API_INTERNAL_URL: 'http://localhost:4000' });
  });

  it('accepts the Compose URL', () => {
    expect(loadWebServerEnv({ API_INTERNAL_URL: 'http://api:4000' }).API_INTERNAL_URL).toBe(
      'http://api:4000',
    );
  });

  it.each(['api:4000', 'ftp://api', ''])('rejects %j', (value) => {
    expect(() => loadWebServerEnv({ API_INTERNAL_URL: value })).toThrow(
      'Invalid web environment: API_INTERNAL_URL',
    );
  });
});

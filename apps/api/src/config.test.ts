import { describe, expect, it } from 'vitest';
import { loadApiConfig } from './config.js';

const SECRET = 'a-local-test-secret-of-32-characters!';
const required = {
  DATABASE_URL: 'postgres://h/db',
  REDIS_URL: 'redis://h:6379',
  AUTH_SECRET: SECRET,
  AUTH_BASE_URL: 'http://localhost:3000',
};

describe('loadApiConfig', () => {
  it('is the api service and defaults PORT to 4000', () => {
    expect(loadApiConfig(required)).toMatchObject({ service: 'api', port: 4000 });
  });

  it('reads the auth settings', () => {
    expect(
      loadApiConfig({ ...required, AUTH_BASE_URL: 'https://app.floty.example/' }).auth,
    ).toEqual({ secret: SECRET, baseUrl: 'https://app.floty.example' });
  });

  it('requires DATABASE_URL and REDIS_URL', () => {
    expect(() => loadApiConfig({})).toThrow('Invalid api environment: DATABASE_URL, REDIS_URL');
  });

  it('requires the auth settings, without echoing them', () => {
    expect(() => loadApiConfig({ ...required, AUTH_SECRET: undefined })).toThrow(
      'Invalid api environment: AUTH_SECRET',
    );
    expect(() => loadApiConfig({ ...required, AUTH_SECRET: 'short-secret' })).toThrow(
      /^Invalid api environment: AUTH_SECRET$/,
    );
  });

  it.each([
    ['http outside localhost', 'http://app.floty.example'],
    ['a path', 'https://app.floty.example/app'],
    ['another scheme', 'ftp://localhost'],
  ])('rejects an AUTH_BASE_URL with %s', (_label, url) => {
    expect(() => loadApiConfig({ ...required, AUTH_BASE_URL: url })).toThrow(
      'Invalid api environment: AUTH_BASE_URL',
    );
  });
});

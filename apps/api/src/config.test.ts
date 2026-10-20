import { describe, expect, it } from 'vitest';
import { loadApiConfig } from './config.js';

const SECRET = 'a-local-test-secret-of-32-characters!';
const required = {
  DATABASE_URL: 'postgres://h/db',
  REDIS_URL: 'redis://h:6379',
  AUTH_SECRET: SECRET,
  AUTH_BASE_URL: 'http://localhost:3000',
  OUTBOX_SECRET: 'a-local-test-outbox-secret-of-32-chars',
};

describe('loadApiConfig', () => {
  it('is the api service and defaults PORT to 4000', () => {
    expect(loadApiConfig(required)).toMatchObject({ service: 'api', port: 4000 });
  });

  it('reads the auth settings', () => {
    expect(
      loadApiConfig({ ...required, AUTH_BASE_URL: 'https://app.pepper.example/' }).auth,
    ).toEqual({ secret: SECRET, baseUrl: 'https://app.pepper.example' });
  });

  it('requires DATABASE_URL and REDIS_URL', () => {
    expect(() => loadApiConfig({})).toThrow('Invalid api environment: DATABASE_URL, REDIS_URL');
  });

  it('requires the outbox secret, without echoing it', () => {
    expect(loadApiConfig(required).outboxSecret).toBe(required.OUTBOX_SECRET);
    expect(() => loadApiConfig({ ...required, OUTBOX_SECRET: 'short' })).toThrow(
      /^Invalid api environment: OUTBOX_SECRET$/,
    );
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
    ['http outside localhost', 'http://app.pepper.example'],
    ['a path', 'https://app.pepper.example/app'],
    ['another scheme', 'ftp://localhost'],
  ])('rejects an AUTH_BASE_URL with %s', (_label, url) => {
    expect(() => loadApiConfig({ ...required, AUTH_BASE_URL: url })).toThrow(
      'Invalid api environment: AUTH_BASE_URL',
    );
  });

  it('has no email sender unless SMTP_URL is set, and a default sender address', () => {
    expect(loadApiConfig(required).mail).toBeNull();
    expect(loadApiConfig({ ...required, SMTP_URL: 'smtp://localhost:1025' }).mail).toEqual({
      smtpUrl: 'smtp://localhost:1025',
      from: 'Pepper <bookings@pepper.localhost>',
    });
    expect(
      loadApiConfig({
        ...required,
        SMTP_URL: 'smtps://u:p@mail.example',
        MAIL_FROM: 'Juniper <a@b.c>',
      }).mail,
    ).toEqual({ smtpUrl: 'smtps://u:p@mail.example', from: 'Juniper <a@b.c>' });
  });

  it('rejects an SMTP_URL that is not smtp, without echoing it', () => {
    expect(() => loadApiConfig({ ...required, SMTP_URL: 'http://u:secret@mail.example' })).toThrow(
      /^Invalid api environment: SMTP_URL$/,
    );
  });

  it('derives a 32-byte booking code key from the auth secret, not the secret itself', () => {
    const key = loadApiConfig(required).bookingCodeKey;
    expect(key).toHaveLength(32);
    expect(key.equals(loadApiConfig(required).bookingCodeKey)).toBe(true);
    expect(key.toString('utf8')).not.toContain(SECRET.slice(0, 8));
    expect(
      key.equals(loadApiConfig({ ...required, AUTH_SECRET: `${SECRET}x` }).bookingCodeKey),
    ).toBe(false);
  });
});

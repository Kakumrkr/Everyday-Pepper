import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from './config.js';

const required = {
  DATABASE_URL: 'postgres://h/db',
  REDIS_URL: 'redis://h:6379',
  OUTBOX_SECRET: 'a-local-test-outbox-secret-of-32-chars',
};

describe('loadWorkerConfig', () => {
  it('is the worker service and defaults PORT to 4100', () => {
    expect(loadWorkerConfig(required)).toMatchObject({ service: 'worker', port: 4100 });
  });

  it('requires DATABASE_URL and REDIS_URL', () => {
    expect(() => loadWorkerConfig({ OUTBOX_SECRET: required.OUTBOX_SECRET })).toThrow(
      'Invalid worker environment: DATABASE_URL, REDIS_URL',
    );
  });

  it('requires the outbox secret, without echoing it', () => {
    expect(loadWorkerConfig(required).outboxSecret).toBe(required.OUTBOX_SECRET);
    expect(() => loadWorkerConfig({ ...required, OUTBOX_SECRET: 'short' })).toThrow(
      /^Invalid worker environment: OUTBOX_SECRET$/,
    );
  });

  it('reads the mail settings and the relay interval', () => {
    expect(loadWorkerConfig(required)).toMatchObject({ mail: null, outboxPollMs: 1000 });
    expect(
      loadWorkerConfig({ ...required, SMTP_URL: 'smtp://localhost:1025', OUTBOX_POLL_MS: '250' }),
    ).toMatchObject({
      mail: { smtpUrl: 'smtp://localhost:1025', from: 'Pepper <bookings@pepper.localhost>' },
      outboxPollMs: 250,
    });
    expect(() => loadWorkerConfig({ ...required, OUTBOX_POLL_MS: '10' })).toThrow(
      /^Invalid worker environment: OUTBOX_POLL_MS$/,
    );
  });
});

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

  it('writes episodes only with an OpenAI key and an embedding model (S31)', () => {
    const openai = {
      OPENAI_API_KEY: 'sk-test-not-a-real-key-000000',
      OPENAI_MODEL_ROUTINE: 'gpt-6-luna',
      OPENAI_MODEL_STRONG: 'gpt-6.1-sol',
    };
    expect(loadWorkerConfig(required).episodes).toBeNull();
    expect(loadWorkerConfig({ ...required, ...openai }).episodes).toBeNull();
    expect(
      loadWorkerConfig({
        ...required,
        ...openai,
        OPENAI_MODEL_EMBEDDING: 'text-embedding-3-small',
        AI_MONTHLY_TOKENS: '1000000',
      }).episodes,
    ).toMatchObject({
      openai: { models: { routine: 'gpt-6-luna' }, embeddingModel: 'text-embedding-3-small' },
      monthlyTokens: 1_000_000,
    });
  });

  it('drafts rebooking emails only with an OpenAI key and the web origin (S36)', () => {
    const openai = {
      OPENAI_API_KEY: 'sk-test-not-a-real-key-000000',
      OPENAI_MODEL_ROUTINE: 'gpt-6-luna',
      OPENAI_MODEL_STRONG: 'gpt-6.1-sol',
    };
    expect(loadWorkerConfig({ ...required, ...openai }).drafts).toBeNull();
    expect(
      loadWorkerConfig({ ...required, AUTH_BASE_URL: 'https://app.example' }).drafts,
    ).toBeNull();
    expect(
      loadWorkerConfig({ ...required, ...openai, AUTH_BASE_URL: 'https://app.example/path' })
        .drafts,
    ).toMatchObject({
      openai: { models: { routine: 'gpt-6-luna' } },
      baseUrl: 'https://app.example',
      pollMs: 60_000,
      monthlyTokens: 5_000_000,
    });
    expect(() =>
      loadWorkerConfig({ ...required, ...openai, AUTH_BASE_URL: 'javascript:alert(1)' }),
    ).toThrow(/AUTH_BASE_URL/);
  });

  it('runs the smart waitlist only with the web origin, for the claim links (S37)', () => {
    expect(loadWorkerConfig(required).waitlist).toBeNull();
    expect(
      loadWorkerConfig({ ...required, AUTH_BASE_URL: 'https://app.example/path' }).waitlist,
    ).toEqual({ baseUrl: 'https://app.example', pollMs: 5000 });
    expect(
      loadWorkerConfig({
        ...required,
        AUTH_BASE_URL: 'https://app.example',
        WAITLIST_POLL_MS: '2000',
      }).waitlist?.pollMs,
    ).toBe(2000);
    expect(() =>
      loadWorkerConfig({ ...required, AUTH_BASE_URL: 'https://app.example', WAITLIST_POLL_MS: '0' }),
    ).toThrow(/WAITLIST_POLL_MS/);
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

  it('reads the insights interval: every minute by default, 10 s to 10 min', () => {
    expect(loadWorkerConfig(required)).toMatchObject({ insightsPollMs: 60_000 });
    expect(loadWorkerConfig({ ...required, INSIGHTS_POLL_MS: '30000' })).toMatchObject({
      insightsPollMs: 30_000,
    });
    for (const value of ['5000', '3600000']) {
      expect(() => loadWorkerConfig({ ...required, INSIGHTS_POLL_MS: value })).toThrow(
        /^Invalid worker environment: INSIGHTS_POLL_MS$/,
      );
    }
  });

  it('reads the reminder and clean-up intervals, within their limits', () => {
    expect(loadWorkerConfig(required)).toMatchObject({
      reminderPollMs: 60_000,
      cleanupIntervalMs: 86_400_000,
    });
    expect(
      loadWorkerConfig({ ...required, REMINDER_POLL_MS: '5000', CLEANUP_INTERVAL_MS: '3600000' }),
    ).toMatchObject({ reminderPollMs: 5000, cleanupIntervalMs: 3_600_000 });
    // More than 4 minutes between passes could miss AC-W6-1's 5 minutes.
    expect(() => loadWorkerConfig({ ...required, REMINDER_POLL_MS: '300000' })).toThrow(
      /^Invalid worker environment: REMINDER_POLL_MS$/,
    );
    expect(() => loadWorkerConfig({ ...required, CLEANUP_INTERVAL_MS: '1000' })).toThrow(
      /^Invalid worker environment: CLEANUP_INTERVAL_MS$/,
    );
  });
});

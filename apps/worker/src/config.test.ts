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

  it('turns texts on with SMS_PROVIDER, and asks Twilio for reports only with the web origin (S61)', () => {
    expect(loadWorkerConfig(required)).toMatchObject({ sms: null, smsStatusBaseUrl: null });
    expect(
      loadWorkerConfig({
        ...required,
        SMS_PROVIDER: 'sandbox',
        AUTH_BASE_URL: 'https://app.example.com',
      }),
    ).toMatchObject({
      sms: { provider: 'sandbox' },
      smsStatusBaseUrl: null,
    });
    const twilio = {
      ...required,
      SMS_PROVIDER: 'twilio',
      TWILIO_ACCOUNT_SID: `AC${'0'.repeat(32)}`,
      TWILIO_AUTH_TOKEN: 'f'.repeat(32),
      TWILIO_SENDER: `MG${'1'.repeat(32)}`,
    };
    expect(loadWorkerConfig(twilio)).toMatchObject({
      sms: { provider: 'twilio' },
      smsStatusBaseUrl: null,
    });
    expect(
      loadWorkerConfig({ ...twilio, AUTH_BASE_URL: 'https://app.example.com/' }).smsStatusBaseUrl,
    ).toBe('https://app.example.com');
    expect(() => loadWorkerConfig({ ...required, SMS_PROVIDER: 'twilio' })).toThrow(
      'TWILIO_ACCOUNT_SID',
    );
  });

  it('writes what the sandbox sends where tests read it, only where tests run (S63, AC-X-87)', () => {
    const sandbox = { ...required, SMS_PROVIDER: 'sandbox' };
    expect(loadWorkerConfig(sandbox).smsSandboxLog).toBe(true);
    expect(
      loadWorkerConfig({ ...sandbox, DEPLOYMENT_ENVIRONMENT: 'ci', NODE_ENV: 'production' })
        .smsSandboxLog,
    ).toBe(true);
    expect(loadWorkerConfig({ ...sandbox, NODE_ENV: 'production' }).smsSandboxLog).toBe(false);
    expect(loadWorkerConfig({ ...sandbox, DEPLOYMENT_ENVIRONMENT: 'pilot' }).smsSandboxLog).toBe(
      false,
    );
    expect(loadWorkerConfig(required).smsSandboxLog).toBe(false);
  });

  it('reads staff calendars with Google or the sandbox, the sandbox only where tests run (S70, AC-X-158)', () => {
    expect(loadWorkerConfig(required).googleCalendar).toBeNull();
    const sandbox = { ...required, GOOGLE_CALENDAR_PROVIDER: 'sandbox' };
    expect(loadWorkerConfig(sandbox).googleCalendar).toEqual({
      settings: { provider: 'sandbox' },
      baseUrl: 'http://localhost',
      pollMs: 60_000,
    });
    expect(loadWorkerConfig({ ...sandbox, NODE_ENV: 'production' }).googleCalendar).toBeNull();
    expect(
      loadWorkerConfig({
        ...required,
        GOOGLE_CALENDAR_PROVIDER: 'google',
        GOOGLE_CLIENT_ID: '123456789012-abcdefghijklmnop0123.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'GOCSPX-abcdefghijklmnopqrstuvwx',
        AUTH_BASE_URL: 'https://app.pepper.test/x',
        CALENDAR_POLL_MS: '30000',
        NODE_ENV: 'production',
      }).googleCalendar,
    ).toMatchObject({
      settings: { provider: 'google' },
      baseUrl: 'https://app.pepper.test',
      pollMs: 30_000,
    });
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

  it('drafts with the web origin; rebooking emails need an OpenAI key, review requests don’t (S36, S56a)', () => {
    const openai = {
      OPENAI_API_KEY: 'sk-test-not-a-real-key-000000',
      OPENAI_MODEL_ROUTINE: 'gpt-6-luna',
      OPENAI_MODEL_STRONG: 'gpt-6.1-sol',
    };
    expect(loadWorkerConfig({ ...required, ...openai }).drafts).toBeNull();
    expect(
      loadWorkerConfig({ ...required, AUTH_BASE_URL: 'https://app.example' }).drafts,
    ).toMatchObject({ openai: null, baseUrl: 'https://app.example' });
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
      loadWorkerConfig({
        ...required,
        AUTH_BASE_URL: 'https://app.example',
        WAITLIST_POLL_MS: '0',
      }),
    ).toThrow(/WAITLIST_POLL_MS/);
  });

  it('runs the support job every 5 min, with the team address and the web origin (S59.2.2)', () => {
    expect(loadWorkerConfig(required).support).toEqual({
      supportEmail: null,
      baseUrl: null,
      pollMs: 300_000,
      inboundDomain: null,
    });
    expect(
      loadWorkerConfig({
        ...required,
        SUPPORT_EMAIL: 'support@pepper.test',
        AUTH_BASE_URL: 'https://app.pepper.test/path',
        SUPPORT_POLL_MS: '60000',
      }).support,
    ).toEqual({
      supportEmail: 'support@pepper.test',
      baseUrl: 'https://app.pepper.test',
      pollMs: 60_000,
      inboundDomain: null,
    });
    expect(() => loadWorkerConfig({ ...required, SUPPORT_EMAIL: 'not an address' })).toThrow(
      /SUPPORT_EMAIL/,
    );
  });

  it('runs the inbound email job only with its domain, Resend key and web origin (S59.3)', () => {
    const inbound = {
      INBOUND_EMAIL_DOMAIN: 'Reply.Pepper.Test',
      RESEND_API_KEY: 're_test_key_123',
      AUTH_BASE_URL: 'https://app.pepper.test/',
    };
    expect(loadWorkerConfig(required).inbound).toBeNull();
    expect(
      loadWorkerConfig({ ...required, ...inbound, RESEND_API_KEY: undefined }).inbound,
    ).toBeNull();
    expect(
      loadWorkerConfig({ ...required, ...inbound, INBOUND_AUTHSERV_ID: 'AmazonSES.com' }),
    ).toMatchObject({
      inbound: {
        domain: 'reply.pepper.test',
        authservId: 'amazonses.com',
        resendApiKey: 're_test_key_123',
        baseUrl: 'https://app.pepper.test',
        pollMs: 15_000,
      },
      support: { inboundDomain: 'reply.pepper.test' },
    });
    expect(loadWorkerConfig({ ...required, ...inbound }).inbound?.authservId).toBeNull();
    expect(() => loadWorkerConfig({ ...required, RESEND_API_KEY: 'sk_live_x' })).toThrow(
      /^Invalid worker environment: RESEND_API_KEY$/,
    );
  });

  it('looks for committed client imports every 2 s by default (S48)', () => {
    expect(loadWorkerConfig(required).importPollMs).toBe(2000);
    expect(loadWorkerConfig({ ...required, IMPORT_POLL_MS: '500' }).importPollMs).toBe(500);
    expect(() => loadWorkerConfig({ ...required, IMPORT_POLL_MS: '100' })).toThrow(
      /IMPORT_POLL_MS/,
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

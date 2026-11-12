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

  it('has the AI off without a key, with a 5M-token monthly budget by default', () => {
    expect(loadApiConfig(required).ai).toEqual({
      openai: null,
      monthlyTokens: 5_000_000,
      scripted: false,
    });
    expect(loadApiConfig({ ...required, AI_MONTHLY_TOKENS: '200000' }).ai.monthlyTokens).toBe(
      200_000,
    );
    expect(() => loadApiConfig({ ...required, AI_MONTHLY_TOKENS: '0' })).toThrow(
      /^Invalid api environment: AI_MONTHLY_TOKENS$/,
    );
  });

  it('reads the OpenAI settings and refuses a key without the models, without echoing it', () => {
    const key = 'sk-test-0123456789abcdefghij';
    expect(
      loadApiConfig({
        ...required,
        OPENAI_API_KEY: key,
        OPENAI_MODEL_ROUTINE: 'small-model',
        OPENAI_MODEL_STRONG: 'big-model',
      }).ai.openai,
    ).toMatchObject({ apiKey: key, models: { routine: 'small-model', strong: 'big-model' } });
    expect(() => loadApiConfig({ ...required, OPENAI_API_KEY: key })).toThrow(
      /^Invalid OpenAI environment: Set OPENAI_MODEL_ROUTINE/,
    );
  });

  it('allows the scripted e2e model only where tests run, and never next to a real key (S26)', () => {
    expect(loadApiConfig({ ...required, AI_SCRIPTED_PROVIDER: 'e2e' }).ai.scripted).toBe(true);
    expect(
      loadApiConfig({ ...required, AI_SCRIPTED_PROVIDER: 'e2e', DEPLOYMENT_ENVIRONMENT: 'ci' }).ai
        .scripted,
    ).toBe(true);
    for (const environment of ['pilot', 'production', 'staging']) {
      expect(() =>
        loadApiConfig({
          ...required,
          AI_SCRIPTED_PROVIDER: 'e2e',
          DEPLOYMENT_ENVIRONMENT: environment,
        }),
      ).toThrow(/^Invalid api environment: AI_SCRIPTED_PROVIDER$/);
    }
    expect(() =>
      loadApiConfig({
        ...required,
        AI_SCRIPTED_PROVIDER: 'e2e',
        OPENAI_API_KEY: 'sk-test-0123456789abcdefghij',
        OPENAI_MODEL_ROUTINE: 'small-model',
        OPENAI_MODEL_STRONG: 'big-model',
      }),
    ).toThrow(/^Invalid api environment: AI_SCRIPTED_PROVIDER$/);
    // A production build that forgot its environment name (default `local`) is refused too.
    expect(() =>
      loadApiConfig({ ...required, AI_SCRIPTED_PROVIDER: 'e2e', NODE_ENV: 'production' }),
    ).toThrow(/^Invalid api environment: AI_SCRIPTED_PROVIDER$/);
    expect(
      loadApiConfig({
        ...required,
        AI_SCRIPTED_PROVIDER: 'e2e',
        NODE_ENV: 'production',
        DEPLOYMENT_ENVIRONMENT: 'ci',
      }).ai.scripted,
    ).toBe(true);
    expect(() => loadApiConfig({ ...required, AI_SCRIPTED_PROVIDER: 'yes' })).toThrow(
      /^Invalid api environment: AI_SCRIPTED_PROVIDER$/,
    );
    // Empty means unset, as for every variable.
    expect(loadApiConfig({ ...required, AI_SCRIPTED_PROVIDER: '' }).ai.scripted).toBe(false);
  });

  it('has replies by email off until the domain and the webhook secret are set (S59.3)', () => {
    expect(loadApiConfig(required).inbound).toEqual({ domain: null, webhookSecret: null });
    const secret = `whsec_${Buffer.from('a-test-webhook-signing-key-32-bytes!').toString('base64')}`;
    expect(
      loadApiConfig({
        ...required,
        INBOUND_EMAIL_DOMAIN: 'Reply.Pepper.Example',
        RESEND_WEBHOOK_SECRET: secret,
      }).inbound,
    ).toEqual({ domain: 'reply.pepper.example', webhookSecret: secret });
    expect(() => loadApiConfig({ ...required, INBOUND_EMAIL_DOMAIN: 'not a domain' })).toThrow(
      /^Invalid api environment: INBOUND_EMAIL_DOMAIN$/,
    );
    // 20 base64 characters are only 15 bytes: too short a key.
    expect(() =>
      loadApiConfig({ ...required, RESEND_WEBHOOK_SECRET: `whsec_${'A'.repeat(20)}` }),
    ).toThrow(/^Invalid api environment: RESEND_WEBHOOK_SECRET$/);
    expect(() => loadApiConfig({ ...required, RESEND_WEBHOOK_SECRET: 're_secret_value' })).toThrow(
      /^Invalid api environment: RESEND_WEBHOOK_SECRET$/,
    );
  });

  it('turns the SMS webhooks on only with Twilio (S61, ADR-0065)', () => {
    expect(loadApiConfig(required).smsWebhook).toBeNull();
    expect(loadApiConfig({ ...required, SMS_PROVIDER: 'sandbox' }).smsWebhook).toBeNull();
    const account = `AC${'0'.repeat(32)}`;
    const token = 'f'.repeat(32);
    expect(
      loadApiConfig({
        ...required,
        SMS_PROVIDER: 'twilio',
        TWILIO_ACCOUNT_SID: account,
        TWILIO_AUTH_TOKEN: token,
        TWILIO_SENDER: '+15557654321',
      }).smsWebhook,
    ).toEqual({ accountSid: account, authToken: token });
    expect(() => loadApiConfig({ ...required, SMS_PROVIDER: 'twilio' })).toThrow(
      /^Invalid api environment: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SENDER$/,
    );
  });

  it('sends confirmation texts with the sandbox or Twilio, never when off (S62)', () => {
    expect(loadApiConfig(required).textsOn).toBe(false);
    expect(loadApiConfig({ ...required, SMS_PROVIDER: 'off' }).textsOn).toBe(false);
    expect(loadApiConfig({ ...required, SMS_PROVIDER: 'sandbox' }).textsOn).toBe(true);
  });
});

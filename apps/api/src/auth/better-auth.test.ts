import type { Database } from '@pepper/db';
import { describe, expect, it, vi } from 'vitest';
import type { EmailMessage } from '@pepper/core';
import {
  AUTH_BASE_PATH,
  createBetterAuth,
  EMAIL_RATE_LIMITS,
  MIN_PASSWORD_LENGTH,
} from './better-auth.js';

// Regression checks on the security-relevant settings; the flows themselves run against real
// Postgres in auth.int.test.ts.
function create(baseUrl = 'http://localhost:3000', log = vi.fn(), sent: EmailMessage[] = []) {
  const mailer = {
    send: (message: EmailMessage) => {
      sent.push(message);
      return Promise.resolve();
    },
  };
  return createBetterAuth({ baseUrl, secret: 's'.repeat(32), db: {} as Database, mailer, log });
}

const ana = {
  id: 'u1',
  name: 'Ana Reyes',
  email: 'ana@example.test',
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** A JWT-shaped token whose payload is `payload` (only the payload is read). */
const tokenWith = (payload: object) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

describe('createBetterAuth', () => {
  it('serves under /api/auth for the app origin only', () => {
    const { options } = create();
    expect(options.basePath).toBe(AUTH_BASE_PATH);
    expect(options.baseURL).toBe('http://localhost:3000');
    expect(options.trustedOrigins).toEqual(['http://localhost:3000']);
  });

  it('allows email sign-in with long passwords for confirmed addresses (ADR-0045)', () => {
    const { options } = create();
    expect(options.emailAndPassword).toMatchObject({
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      requireEmailVerification: true,
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
    });
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(10);
    expect(options.emailVerification).toMatchObject({
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: 24 * 3600,
    });
    expect(options.user).toMatchObject({
      changeEmail: { enabled: true, updateEmailWithoutVerification: false },
      deleteUser: { enabled: false },
    });
  });

  it('emails each link to the right address with the right words', async () => {
    const sent: EmailMessage[] = [];
    const { options } = create(undefined, vi.fn(), sent);
    await options.emailAndPassword.sendResetPassword({ user: ana, url: 'R', token: 't' });
    await options.emailVerification.sendVerificationEmail({
      user: ana,
      url: 'V',
      token: tokenWith({ email: ana.email }),
    });
    await options.emailVerification.sendVerificationEmail({
      user: { ...ana, email: 'new@example.test' },
      url: 'C',
      token: tokenWith({ email: ana.email, updateTo: 'new@example.test' }),
    });
    await options.emailAndPassword.onExistingUserSignUp({ user: ana });
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      ['ana@example.test', 'Reset your Pepper password'],
      ['ana@example.test', 'Confirm your email for Pepper'],
      ['new@example.test', 'Confirm your new email for Pepper'],
      ['ana@example.test', 'Your Pepper email is about to change'],
      ['ana@example.test', 'You already have a Pepper account'],
    ]);
  });

  it('limits the endpoints that send email more tightly', () => {
    expect(create().options.rateLimit.customRules).toEqual(EMAIL_RATE_LIMITS);
    for (const rule of Object.values(EMAIL_RATE_LIMITS)) expect(rule.max).toBeLessThanOrEqual(3);
  });

  it('reads sessions from the database every time and never lets clients set the business', () => {
    const { options } = create();
    expect(options.session.cookieCache).toEqual({ enabled: false });
    expect(options.session.additionalFields.activeTenantId).toMatchObject({ input: false });
  });

  it('keeps its CSRF and origin checks on in every environment (even NODE_ENV=test)', () => {
    const { options } = create();
    expect(options.advanced).toMatchObject({ disableCSRFCheck: false, disableOriginCheck: false });
  });

  it('rate limits, sends no telemetry, and prefixes its cookies', () => {
    const { options } = create();
    expect(options.rateLimit).toMatchObject({ enabled: true });
    expect(options.telemetry).toEqual({ enabled: false });
    expect(options.advanced.cookiePrefix).toBe('pepper');
    expect(options.plugins.map((plugin) => plugin.id)).toEqual(['two-factor']);
  });

  it('uses Secure cookies on https only', () => {
    expect(create('https://app.pepper.example').options.advanced.useSecureCookies).toBe(true);
    expect(create().options.advanced.useSecureCookies).toBe(false);
  });

  it('generates UUID v7 ids', () => {
    expect(create().options.advanced.database.generateId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/,
    );
  });

  it('sends its log lines to the given logger', () => {
    const log = vi.fn();
    const { options } = create(undefined, log);
    options.logger.log('warn', 'careful');
    expect(log).toHaveBeenCalledWith('warn', 'careful');
  });
});

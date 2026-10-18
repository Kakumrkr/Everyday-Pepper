import type { Database } from '@pepper/db';
import { describe, expect, it, vi } from 'vitest';
import { AUTH_BASE_PATH, createBetterAuth, MIN_PASSWORD_LENGTH } from './better-auth.js';

// Regression checks on the security-relevant settings; the flows themselves run against real
// Postgres in auth.int.test.ts.
function create(baseUrl = 'http://localhost:3000', log = vi.fn()) {
  return createBetterAuth({ baseUrl, secret: 's'.repeat(32), db: {} as Database, log });
}

describe('createBetterAuth', () => {
  it('serves under /api/auth for the app origin only', () => {
    const { options } = create();
    expect(options.basePath).toBe(AUTH_BASE_PATH);
    expect(options.baseURL).toBe('http://localhost:3000');
    expect(options.trustedOrigins).toEqual(['http://localhost:3000']);
  });

  it('allows email sign-in with long passwords, and nothing that needs email yet', () => {
    const { options } = create();
    expect(options.emailAndPassword).toMatchObject({
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      requireEmailVerification: false,
    });
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(10);
    expect(options.user).toMatchObject({
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    });
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

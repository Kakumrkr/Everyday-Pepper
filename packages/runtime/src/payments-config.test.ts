import { describe, expect, it } from 'vitest';
import { loadPaymentsConfig } from './config.js';

// The payments settings (S65, ADR-0067 §1, AC-X-100).

const KEY = 'sk_test_51NvTestKeyForConfigTests000000';
const LIVE = 'sk_live_51NvLiveKeyForConfigTests000000';
const SECRET = 'whsec_5f3a1c9e7b2d4f6a8c0e1b3d5f7a9c2e';

describe('loadPaymentsConfig (AC-X-100)', () => {
  it('is off by default, and with an empty value', () => {
    expect(loadPaymentsConfig('api', {})).toBeNull();
    expect(loadPaymentsConfig('api', { PAYMENTS_PROVIDER: '' })).toBeNull();
    expect(
      loadPaymentsConfig('api', { PAYMENTS_PROVIDER: 'off', STRIPE_SECRET_KEY: KEY }),
    ).toBeNull();
  });

  it('reads the sandbox without any key', () => {
    expect(loadPaymentsConfig('api', { PAYMENTS_PROVIDER: 'sandbox' })).toEqual({
      provider: 'sandbox',
    });
  });

  it('reads Stripe in test mode, with a secret or a restricted key', () => {
    expect(
      loadPaymentsConfig('api', {
        PAYMENTS_PROVIDER: 'stripe',
        STRIPE_SECRET_KEY: KEY,
        STRIPE_WEBHOOK_SECRET: SECRET,
      }),
    ).toEqual({ provider: 'stripe', secretKey: KEY, webhookSecret: SECRET, livemode: false });
    expect(
      loadPaymentsConfig('api', {
        PAYMENTS_PROVIDER: 'stripe',
        STRIPE_SECRET_KEY: 'rk_test_51NvRestrictedKey0000',
        STRIPE_WEBHOOK_SECRET: SECRET,
      }),
    ).toMatchObject({ livemode: false });
  });

  it('refuses a live key unless STRIPE_LIVE=on, naming the variable, never the key', () => {
    const live = {
      PAYMENTS_PROVIDER: 'stripe',
      STRIPE_SECRET_KEY: LIVE,
      STRIPE_WEBHOOK_SECRET: SECRET,
    };
    let message = '';
    try {
      loadPaymentsConfig('api', live);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('Invalid api environment: STRIPE_LIVE');
    expect(message).not.toContain(LIVE);
    expect(loadPaymentsConfig('api', { ...live, STRIPE_LIVE: 'on' })).toEqual({
      provider: 'stripe',
      secretKey: LIVE,
      webhookSecret: SECRET,
      livemode: true,
    });
  });

  it('stops the process for a missing or malformed key or secret, or an unknown provider', () => {
    const cases: Record<string, string>[] = [
      { PAYMENTS_PROVIDER: 'stripe', STRIPE_WEBHOOK_SECRET: SECRET },
      { PAYMENTS_PROVIDER: 'stripe', STRIPE_SECRET_KEY: KEY },
      {
        PAYMENTS_PROVIDER: 'stripe',
        STRIPE_SECRET_KEY: 'pk_test_51Nv0000000000',
        STRIPE_WEBHOOK_SECRET: SECRET,
      },
      { PAYMENTS_PROVIDER: 'stripe', STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: 'whsec_short' },
      {
        PAYMENTS_PROVIDER: 'stripe',
        STRIPE_SECRET_KEY: KEY,
        STRIPE_WEBHOOK_SECRET: SECRET,
        STRIPE_LIVE: 'yes',
      },
      { PAYMENTS_PROVIDER: 'paypal' },
    ];
    for (const env of cases) {
      expect(() => loadPaymentsConfig('api', env), JSON.stringify(Object.keys(env))).toThrow(
        /^Invalid api environment: /,
      );
    }
  });
});

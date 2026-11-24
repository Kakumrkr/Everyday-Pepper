import { describe, expect, it } from 'vitest';
import { ServiceInputSchema } from './appointments.js';
import { BookingPageSettingsSchema } from './account.js';
import {
  BookingDepositSchema,
  DepositAudienceSchema,
  depositApplies,
  DepositRuleSchema,
  NO_SHOW_LOOKBACK_DAYS,
  noShowsSince,
  depositRefundEndsAt,
  depositRuleProblem,
  depositTermsOf,
  isRefundable,
  OutboxPaymentSchema,
  StripeClientSecretSchema,
} from './deposits.js';

const service = { name: 'Fade', durationMinutes: 30, priceFromCents: 4000 };

describe('deposit rules (AC-X-111)', () => {
  it('takes none, fixed, percent and card', () => {
    for (const rule of [
      { kind: 'none' },
      { kind: 'fixed', amountCents: 1000 },
      { kind: 'percent', percent: 25 },
      { kind: 'card' },
    ]) {
      expect(DepositRuleSchema.parse(rule)).toEqual(rule);
    }
  });

  it('refuses a fixed amount under 50 cents, a percent out of 1–100 and extra fields', () => {
    expect(DepositRuleSchema.safeParse({ kind: 'fixed', amountCents: 49 }).success).toBe(false);
    expect(DepositRuleSchema.safeParse({ kind: 'fixed', amountCents: 10.5 }).success).toBe(false);
    expect(DepositRuleSchema.safeParse({ kind: 'percent', percent: 0 }).success).toBe(false);
    expect(DepositRuleSchema.safeParse({ kind: 'percent', percent: 101 }).success).toBe(false);
    expect(DepositRuleSchema.safeParse({ kind: 'card', amountCents: 100 }).success).toBe(false);
  });

  it('checks the rule against the starting price', () => {
    expect(depositRuleProblem({ kind: 'fixed', amountCents: 4001 }, 4000)?.path).toBe(
      'amountCents',
    );
    expect(depositRuleProblem({ kind: 'fixed', amountCents: 4000 }, 4000)).toBeNull();
    expect(depositRuleProblem({ kind: 'fixed', amountCents: 9000 }, null)).toBeNull();
    expect(depositRuleProblem({ kind: 'percent', percent: 50 }, null)?.message).toBe(
      'A percent deposit needs a price',
    );
    expect(depositRuleProblem({ kind: 'percent', percent: 1 }, 4000)?.message).toBe(
      'That comes to less than $0.50',
    );
    expect(depositRuleProblem({ kind: 'card' }, null)).toBeNull();
  });

  it('is validated with the service, and may be left out', () => {
    expect(ServiceInputSchema.parse(service).deposit).toBeUndefined();
    const bad = ServiceInputSchema.safeParse({
      ...service,
      deposit: { kind: 'fixed', amountCents: 5000 },
    });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(['deposit', 'amountCents']);
    expect(
      ServiceInputSchema.parse({ ...service, deposit: { kind: 'percent', percent: 20 } }).deposit,
    ).toEqual({ kind: 'percent', percent: 20 });
  });
});

describe('the refund window (AC-X-112)', () => {
  it('is 0–168 whole hours in the booking page settings', () => {
    expect(BookingPageSettingsSchema.parse({ depositRefundHours: 48 })).toEqual({
      depositRefundHours: 48,
    });
    expect(BookingPageSettingsSchema.safeParse({ depositRefundHours: 169 }).success).toBe(false);
    expect(BookingPageSettingsSchema.safeParse({ depositRefundHours: -1 }).success).toBe(false);
    expect(BookingPageSettingsSchema.safeParse({ depositRefundHours: 1.5 }).success).toBe(false);
  });
});

describe('deposit terms (AC-X-113)', () => {
  it('answers what is paid now with the window', () => {
    expect(depositTermsOf({ kind: 'none' }, 4000, 24)).toBeNull();
    expect(depositTermsOf({ kind: 'card' }, null, 24)).toEqual({ kind: 'card', refundHours: 24 });
    expect(depositTermsOf({ kind: 'fixed', amountCents: 1500 }, 4000, 12)).toEqual({
      kind: 'deposit',
      amountCents: 1500,
      refundHours: 12,
    });
    // 33 % of $45.55 is $15.0315: rounded to the cent.
    expect(depositTermsOf({ kind: 'percent', percent: 33 }, 4555, 24)).toEqual({
      kind: 'deposit',
      amountCents: 1503,
      refundHours: 24,
    });
  });

  it('asks nothing when the price changed under the rule', () => {
    expect(depositTermsOf({ kind: 'fixed', amountCents: 5000 }, 4000, 24)).toBeNull();
    expect(depositTermsOf({ kind: 'percent', percent: 50 }, null, 24)).toBeNull();
    expect(depositTermsOf({ kind: 'percent', percent: 1 }, 4000, 24)).toBeNull();
  });

  it('ends the refund the window before the start, refundable up to that moment', () => {
    const start = new Date('2099-03-10T17:00:00.000Z');
    expect(depositRefundEndsAt(start, 24).toISOString()).toBe('2099-03-09T17:00:00.000Z');
    expect(depositRefundEndsAt('2099-03-10T17:00:00.000Z', 0).toISOString()).toBe(
      '2099-03-10T17:00:00.000Z',
    );
    expect(isRefundable(start, 24, new Date('2099-03-09T17:00:00.000Z'))).toBe(true);
    expect(isRefundable(start, 24, new Date('2099-03-09T17:00:00.001Z'))).toBe(false);
  });
});

describe('payment shapes', () => {
  it('takes only Stripe-shaped client secrets', () => {
    expect(StripeClientSecretSchema.safeParse('pi_123_secret_abc').success).toBe(true);
    expect(StripeClientSecretSchema.safeParse('seti_123_secret_abc').success).toBe(true);
    expect(StripeClientSecretSchema.safeParse('pi_123').success).toBe(false);
    expect(StripeClientSecretSchema.safeParse('pi_1 2_secret_a').success).toBe(false);
  });

  it('queues a refund by id only', () => {
    const id = '0190e7a8-0000-7000-8000-000000000001';
    expect(OutboxPaymentSchema.parse({ kind: 'refund', bookingPaymentId: id })).toEqual({
      kind: 'refund',
      bookingPaymentId: id,
    });
    expect(
      OutboxPaymentSchema.safeParse({ kind: 'refund', bookingPaymentId: id, amount: 1 }).success,
    ).toBe(false);
  });
});

describe('who pays a deposit (AC-X-125, AC-X-126)', () => {
  it('is everyone or new clients and no-shows, everyone by default', () => {
    expect(DepositAudienceSchema.options).toEqual(['everyone', 'new_and_no_show']);
    expect(BookingPageSettingsSchema.parse({ depositAudience: 'new_and_no_show' })).toEqual({
      depositAudience: 'new_and_no_show',
    });
    expect(BookingPageSettingsSchema.safeParse({ depositAudience: 'regulars' }).success).toBe(
      false,
    );
  });

  // The fixtures of the rule: the client the booking would go to, and what they have done.
  const cases: {
    name: string;
    standing: { endedVisits: number; recentNoShows: number } | null;
    pays: boolean;
  }[] = [
    { name: 'no client with this email (new)', standing: null, pays: true },
    {
      name: 'a client with no visit yet (booked, cancelled)',
      standing: { endedVisits: 0, recentNoShows: 0 },
      pays: true,
    },
    {
      name: 'a regular: one visit that has ended',
      standing: { endedVisits: 1, recentNoShows: 0 },
      pays: false,
    },
    {
      name: 'a regular with many visits',
      standing: { endedVisits: 12, recentNoShows: 0 },
      pays: false,
    },
    {
      name: 'a regular with a no-show this year',
      standing: { endedVisits: 12, recentNoShows: 1 },
      pays: true,
    },
    {
      name: 'a no-show and nothing else',
      standing: { endedVisits: 0, recentNoShows: 1 },
      pays: true,
    },
  ];
  for (const { name, standing, pays } of cases) {
    it(`new clients and no-shows: ${name} ${pays ? 'pays' : 'is exempt'}`, () => {
      expect(depositApplies('new_and_no_show', standing)).toBe(pays);
    });
    it(`everyone: ${name} pays`, () => {
      expect(depositApplies('everyone', standing)).toBe(true);
    });
  }

  it('counts no-shows of the last 12 months', () => {
    expect(NO_SHOW_LOOKBACK_DAYS).toBe(365);
    expect(noShowsSince(new Date('2026-11-24T15:00:00Z')).toISOString()).toBe(
      '2025-11-24T15:00:00.000Z',
    );
  });
});

describe("the team's view of a deposit (AC-X-129)", () => {
  it('carries the amount, the stored window and where it stands', () => {
    const paid = {
      kind: 'deposit',
      amountCents: 1500,
      refundEndsAt: '2026-11-24T20:00:00.000Z',
      status: 'held',
      refundableNow: true,
    };
    expect(BookingDepositSchema.parse(paid)).toEqual(paid);
    for (const status of ['held', 'kept', 'refunding', 'refunded', 'refund_failed']) {
      expect(BookingDepositSchema.safeParse({ ...paid, status }).success).toBe(true);
    }
    expect(BookingDepositSchema.safeParse({ ...paid, status: 'voided' }).success).toBe(false);
  });
});

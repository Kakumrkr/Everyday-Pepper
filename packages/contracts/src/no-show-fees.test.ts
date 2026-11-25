import { describe, expect, it } from 'vitest';
import {
  noShowFeeCents,
  noShowFeeChoiceLine,
  noShowFeeStatusLine,
  noShowFeeToCharge,
} from './no-show-fees.js';
import { OutboxPaymentSchema, StripePaymentIntentSchema } from './deposits.js';

describe('the no-show fee (S68)', () => {
  it('is the fixed fee, or the percent of the booked starting price (AC-X-136)', () => {
    expect(noShowFeeCents({ kind: 'fixed', amountCents: 2000 }, null)).toBe(2000);
    expect(noShowFeeCents({ kind: 'percent', percent: 50 }, 4500)).toBe(2250);
    expect(noShowFeeCents({ kind: 'percent', percent: 33 }, 1001)).toBe(330);
    expect(noShowFeeCents({ kind: 'percent', percent: 50 }, null)).toBeNull();
    expect(noShowFeeCents({ kind: 'percent', percent: 50 }, 0)).toBeNull();
    // Under $0.50 nothing can be charged (review: the row's check would refuse the booking).
    expect(noShowFeeCents({ kind: 'percent', percent: 10 }, 400)).toBeNull();
    expect(noShowFeeCents({ kind: 'percent', percent: 100 }, 20_000_000)).toBe(10_000_000);
    expect(noShowFeeCents({ kind: 'none' }, 4500)).toBeNull();
  });

  it('counts a kept deposit toward the fee, and charges nothing under $0.50 (AC-X-137)', () => {
    expect(noShowFeeToCharge(2000, 0)).toBe(2000);
    expect(noShowFeeToCharge(2000, 1500)).toBe(500);
    expect(noShowFeeToCharge(2000, 1960)).toBeNull();
    expect(noShowFeeToCharge(2000, 1950)).toBe(50);
    expect(noShowFeeToCharge(2000, 2500)).toBeNull();
  });

  it('says the policy’s fee and the choice on the card (AC-X-138, top-up)', () => {
    expect(noShowFeeChoiceLine({ feeCents: 2000, keptDepositCents: 0, chargeCents: 2000 })).toBe(
      'No-shows may be charged $20 · charge $20 or waive',
    );
    expect(noShowFeeChoiceLine({ feeCents: 2000, keptDepositCents: 1500, chargeCents: 500 })).toBe(
      'No-shows may be charged $20 · $15 deposit kept · charge $5 or waive',
    );
    expect(noShowFeeChoiceLine({ feeCents: 1250, keptDepositCents: 0, chargeCents: 1250 })).toBe(
      'No-shows may be charged $12.50 · charge $12.50 or waive',
    );
  });

  it('says where a fee stands for the team', () => {
    expect(noShowFeeStatusLine('charged', 2000)).toBe('$20 no-show fee charged');
    expect(noShowFeeStatusLine('queued', 2000)).toBe('$20 no-show fee being charged');
    expect(noShowFeeStatusLine('failed', 2000)).toBe('$20 no-show fee declined · nothing charged');
    expect(noShowFeeStatusLine('refunded', 500)).toBe('$5 no-show fee refunded');
    expect(noShowFeeStatusLine('cancelled', 500)).toBeNull();
  });

  it('queues a fee by its id only, and reads the card a payment kept', () => {
    const id = '0190a000-0000-7000-8000-000000000001';
    expect(OutboxPaymentSchema.parse({ kind: 'fee_charge', bookingFeeId: id })).toEqual({
      kind: 'fee_charge',
      bookingFeeId: id,
    });
    expect(
      OutboxPaymentSchema.safeParse({ kind: 'fee_charge', bookingPaymentId: id }).success,
    ).toBe(false);
    expect(OutboxPaymentSchema.safeParse({ kind: 'capture', bookingFeeId: id }).success).toBe(
      false,
    );
    const intent = StripePaymentIntentSchema.parse({
      id: 'pi_1',
      object: 'payment_intent',
      amount: 1500,
      currency: 'usd',
      customer: 'cus_1',
      status: 'succeeded',
      client_secret: null,
      payment_method: 'pm_1',
      livemode: false,
    });
    expect(intent.payment_method).toBe('pm_1');
  });
});

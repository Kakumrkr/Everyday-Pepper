import { describe, expect, it } from 'vitest';
import {
  BookingPageSettingsSchema,
  cancellationSentence,
  CancellationFeesSchema,
  depositPaidLine,
  feeWords,
  moneyWords,
  NO_CANCELLATION_FEES,
  noticeHoursLabel,
  type CancellationFee,
} from './index.js';

// The cancellation policy (S67.2, AC-X-130, AC-X-131, AC-X-134).

const none: CancellationFee = { kind: 'none' };
const twenty: CancellationFee = { kind: 'fixed', amountCents: 2000 };
const half: CancellationFee = { kind: 'percent', percent: 50 };

describe('the policy’s terms (AC-X-130)', () => {
  it('takes nothing, a fixed amount or a percent for each cost', () => {
    expect(CancellationFeesSchema.parse({ lateCancel: twenty, noShow: half })).toEqual({
      lateCancel: twenty,
      noShow: half,
    });
    expect(CancellationFeesSchema.safeParse({ lateCancel: none }).success).toBe(false);
    for (const bad of [
      { kind: 'fixed', amountCents: 25 },
      { kind: 'fixed', amountCents: 10_000_001 },
      { kind: 'fixed', amountCents: 12.5 },
      { kind: 'percent', percent: 0 },
      { kind: 'percent', percent: 101 },
      { kind: 'deposit' },
    ]) {
      expect(CancellationFeesSchema.safeParse({ lateCancel: bad, noShow: none }).success).toBe(
        false,
      );
    }
  });

  it('is a booking page setting that can be turned off', () => {
    expect(BookingPageSettingsSchema.parse({ cancellationFees: null })).toEqual({
      cancellationFees: null,
    });
    expect(BookingPageSettingsSchema.parse({ cancellationFees: NO_CANCELLATION_FEES })).toEqual({
      cancellationFees: NO_CANCELLATION_FEES,
    });
  });
});

describe('Pepper’s sentence (AC-X-131)', () => {
  it('says nothing without a policy', () => {
    expect(cancellationSentence(null, 24)).toBeNull();
  });

  it('says the notice alone when nothing is charged', () => {
    expect(cancellationSentence(NO_CANCELLATION_FEES, 24)).toBe(
      'Please cancel or reschedule at least 24 hours before your visit.',
    );
    expect(cancellationSentence(NO_CANCELLATION_FEES, 1)).toBe(
      'Please cancel or reschedule at least an hour before your visit.',
    );
    expect(cancellationSentence(NO_CANCELLATION_FEES, 48)).toBe(
      'Please cancel or reschedule at least 2 days before your visit.',
    );
    expect(cancellationSentence(NO_CANCELLATION_FEES, 168)).toBe(
      'Please cancel or reschedule at least a week before your visit.',
    );
    expect(cancellationSentence(NO_CANCELLATION_FEES, 0)).toBe(
      'Please cancel or reschedule before your visit starts.',
    );
  });

  it('adds each cost, said once when they are the same', () => {
    expect(cancellationSentence({ lateCancel: twenty, noShow: none }, 24)).toBe(
      'Please cancel or reschedule at least 24 hours before your visit. Later cancels may be charged $20.',
    );
    expect(cancellationSentence({ lateCancel: none, noShow: twenty }, 24)).toBe(
      'Please cancel or reschedule at least 24 hours before your visit. No-shows may be charged $20.',
    );
    expect(cancellationSentence({ lateCancel: twenty, noShow: twenty }, 24)).toBe(
      'Please cancel or reschedule at least 24 hours before your visit. Later cancels and no-shows may be charged $20.',
    );
    expect(cancellationSentence({ lateCancel: twenty, noShow: half }, 12)).toBe(
      'Please cancel or reschedule at least 12 hours before your visit. Later cancels may be charged $20, and no-shows 50% of the service price.',
    );
  });

  it('has no late cancel with a notice of 0', () => {
    expect(cancellationSentence({ lateCancel: twenty, noShow: none }, 0)).toBe(
      'Please cancel or reschedule before your visit starts.',
    );
    expect(cancellationSentence({ lateCancel: twenty, noShow: half }, 0)).toBe(
      'Please cancel or reschedule before your visit starts. No-shows may be charged 50% of the service price.',
    );
  });

  it('writes fees and notices in plain words', () => {
    expect(feeWords(none)).toBeNull();
    expect(feeWords({ kind: 'fixed', amountCents: 1250 })).toBe('$12.50');
    expect(feeWords({ kind: 'percent', percent: 100 })).toBe('the full service price');
    expect(moneyWords(4500)).toBe('$45');
    expect(() => moneyWords(1.5)).toThrow(RangeError);
    expect(noticeHoursLabel(0)).toBe('Up to the start');
    expect(noticeHoursLabel(72)).toBe('3 days');
    expect(noticeHoursLabel(30)).toBe('30 hours');
  });
});

describe('the deposit’s line (AC-X-129, AC-X-134)', () => {
  const held = { amountCents: 1500, refundEndsAt: '2026-11-26T21:00:00.000Z', refundableNow: true };

  it('says until when it comes back, on the business’s clock', () => {
    expect(depositPaidLine(held, 'America/Chicago')).toBe(
      '$15 deposit paid · refundable until Thu, Nov 26, 3:00 PM',
    );
  });

  it('says when it no longer comes back', () => {
    expect(depositPaidLine({ ...held, refundableNow: false }, 'America/Chicago')).toBe(
      '$15 deposit paid · no longer refundable',
    );
  });
});

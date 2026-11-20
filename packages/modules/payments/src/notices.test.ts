import { PaymentAccountStatusSchema } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { deadlineDate, paymentsNotice } from './notices.js';

const NY = { dueBy: null, timeZone: 'America/New_York' };

describe('paymentsNotice (AC-X-105)', () => {
  it('tells the owner when payments become ready', () => {
    expect(paymentsNotice('pending', 'ready', NY)).toEqual({
      title: 'Payments are ready',
      body: 'Stripe finished checking. Pepper can take payments for you.',
      url: '/more/payments',
      tag: 'payments-ready',
    });
  });

  it('says what Stripe needs by when, the date in the business’s time zone', () => {
    // 03:00 UTC on Dec 4 is still Dec 3 in New York, already Dec 4 in Paris.
    const dueBy = new Date('2026-12-04T03:00:00Z');
    expect(
      paymentsNotice('ready', 'action_needed', { dueBy, timeZone: 'America/New_York' }),
    ).toEqual({
      title: 'Stripe needs one more thing',
      body: 'Finish it by Dec 3 so payments keep working.',
      url: '/more/payments',
      tag: 'payments-action_needed',
    });
    expect(
      paymentsNotice('ready', 'action_needed', { dueBy, timeZone: 'Europe/Paris' })?.body,
    ).toBe('Finish it by Dec 4 so payments keep working.');
    expect(paymentsNotice('pending', 'action_needed', NY)?.body).toBe(
      'Finish it so payments keep working.',
    );
  });

  it('says a rejection without Stripe’s words', () => {
    expect(paymentsNotice('pending', 'rejected', NY)).toMatchObject({
      title: 'Stripe can’t take payments for you',
      tag: 'payments-rejected',
    });
  });

  it('stays quiet for the same status and for steps the owner is taking themselves', () => {
    for (const status of PaymentAccountStatusSchema.options) {
      expect(paymentsNotice(status, status, NY)).toBeNull();
    }
    expect(paymentsNotice('onboarding', 'pending', NY)).toBeNull();
    expect(paymentsNotice('ready', 'not_connected', NY)).toBeNull();
    expect(paymentsNotice('not_connected', 'onboarding', NY)).toBeNull();
  });

  it('never names a person or a requirement (it shows on a lock screen)', () => {
    for (const before of PaymentAccountStatusSchema.options) {
      for (const after of PaymentAccountStatusSchema.options) {
        const notice = paymentsNotice(before, after, NY);
        if (notice === null) continue;
        expect(`${notice.title} ${notice.body}`).not.toMatch(/verification|external_account|@/);
        expect(notice.body.length).toBeLessThanOrEqual(200);
      }
    }
  });

  it('formats a deadline as a short date', () => {
    expect(deadlineDate(new Date('2026-01-15T12:00:00Z'), 'America/Los_Angeles')).toBe('Jan 15');
  });
});

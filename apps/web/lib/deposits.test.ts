import { describe, expect, it } from 'vitest';
import {
  depositFields,
  depositLabel,
  depositRuleFrom,
  manageDepositWords,
  paymentWords,
  percentPreview,
  refundChoices,
  refundHoursLabel,
  refundWindowSentence,
  termsLabel,
} from './deposits';

// Deposits in words (S66.2, AC-X-121…123).

const TZ = 'America/Chicago';
const SECRET = 'pi_sandbox1_secret_abc';

describe('the service sheet’s deposit field (AC-X-121)', () => {
  it('reads a stored rule back into its fields', () => {
    expect(depositFields(undefined)).toEqual({ kind: 'none', amount: '', percent: '' });
    expect(depositFields({ kind: 'fixed', amountCents: 1250 })).toEqual({
      kind: 'fixed',
      amount: '12.50',
      percent: '',
    });
    expect(depositFields({ kind: 'percent', percent: 20 })).toMatchObject({ percent: '20' });
  });

  it('makes the rule in cents, with the domain’s refusals in words', () => {
    const fields = { kind: 'fixed', amount: '15', percent: '' } as const;
    expect(depositRuleFrom(fields, 4500)).toEqual({
      ok: true,
      rule: { kind: 'fixed', amountCents: 1500 },
    });
    expect(depositRuleFrom({ ...fields, amount: '50' }, 4500)).toEqual({
      ok: false,
      message: 'The deposit can be at most the price.',
    });
    expect(depositRuleFrom({ ...fields, amount: '0.25' }, 4500)).toMatchObject({ ok: false });
    expect(depositRuleFrom({ ...fields, amount: 'ten' }, 4500)).toMatchObject({ ok: false });
    expect(depositRuleFrom({ kind: 'percent', amount: '', percent: '20' }, null)).toEqual({
      ok: false,
      message: 'A percent deposit needs a price.',
    });
    expect(depositRuleFrom({ kind: 'percent', amount: '', percent: '1' }, 2000)).toEqual({
      ok: false,
      message: 'That comes to less than $0.50.',
    });
    expect(depositRuleFrom({ kind: 'percent', amount: '', percent: '120' }, 2000)).toMatchObject({
      ok: false,
    });
    expect(depositRuleFrom({ kind: 'card', amount: 'x', percent: 'y' }, null)).toEqual({
      ok: true,
      rule: { kind: 'card' },
    });
  });

  it('shows what a percent comes to (D-3), and the rule on the menu’s row', () => {
    expect(percentPreview('20', 4500)).toBe('20% · $9 of $45');
    expect(percentPreview('20', null)).toBeNull();
    expect(percentPreview('', 4500)).toBeNull();
    expect(depositLabel({ kind: 'none' }, 4500)).toBeNull();
    expect(depositLabel({ kind: 'fixed', amountCents: 1500 }, 4500)).toBe('Deposit $15');
    expect(depositLabel({ kind: 'percent', percent: 20 }, 4500)).toBe('Deposit 20% ($9)');
    expect(depositLabel({ kind: 'card' }, null)).toBe('Card on file');
    expect(termsLabel(null)).toBeNull();
    expect(termsLabel({ kind: 'deposit', amountCents: 1500, refundHours: 24 })).toBe('$15 deposit');
    expect(termsLabel({ kind: 'card', refundHours: 24 })).toBe('Card to book');
  });

  it('offers the refund windows, with the business’s own, in words (AC-X-112)', () => {
    expect(refundChoices(24)).toEqual([0, 2, 6, 12, 24, 48, 72, 168]);
    expect(refundChoices(36)).toContain(36);
    expect(refundHoursLabel(0)).toBe('Up to the start');
    expect(refundHoursLabel(24)).toBe('24 hours');
    expect(refundHoursLabel(48)).toBe('2 days');
    expect(refundHoursLabel(168)).toBe('1 week');
    expect(refundWindowSentence(24)).toBe(
      'Clients who cancel at least 24 hours before get their deposit back. Later, it’s kept.',
    );
    expect(refundWindowSentence(168)).toContain('at least a week before');
    expect(refundWindowSentence(0)).toContain('any time before the start');
  });
});

describe('the booking page’s terms before the card field (AC-X-122)', () => {
  it('says what is paid now and until when a cancel gets it back, on the business’s clock', () => {
    const words = paymentWords(
      {
        clientSecret: SECRET,
        publishableKey: null,
        terms: { kind: 'deposit', amountCents: 1500, refundHours: 24 },
        refundEndsAt: '2026-12-01T21:00:00.000Z',
        provider: 'sandbox',
      },
      TZ,
    );
    expect(words).toEqual({
      title: 'Pay a $15 deposit to book',
      lines: [
        'Cancel by Tue, Dec 1, 3:00 PM and you get the $15 back. After that, it’s kept.',
        'The rest is paid at your visit.',
      ],
      button: 'Pay $15 and book',
    });
  });

  it('says a card on file charges nothing now', () => {
    const words = paymentWords(
      {
        clientSecret: 'seti_sandbox1_secret_abc',
        publishableKey: null,
        terms: { kind: 'card', refundHours: 24 },
        refundEndsAt: '2026-12-01T21:00:00.000Z',
        provider: 'sandbox',
      },
      TZ,
    );
    expect(words.title).toBe('Add a card to book');
    expect(words.lines[0]).toBe('Nothing is charged now. Stripe keeps your card for this booking.');
  });
});

describe('the manage page before Cancel (AC-X-123, S66.2 top-up)', () => {
  const held = {
    kind: 'deposit',
    amountCents: 1500,
    refundEndsAt: '2026-12-01T21:00:00.000Z',
    status: 'held',
    refundableNow: true,
  } as const;

  it('says the deposit comes back inside the window, and is kept after it', () => {
    expect(manageDepositWords(held, TZ)).toEqual({
      beforeCancel: 'Cancel now and get your $15 back.',
      status: 'You paid a $15 deposit. Cancel by Tue, Dec 1, 3:00 PM to get it back.',
    });
    expect(manageDepositWords({ ...held, refundableNow: false }, TZ).beforeCancel).toBe(
      'Your $15 deposit is kept if you cancel now.',
    );
  });

  it('says what happened after a cancel', () => {
    expect(manageDepositWords({ ...held, status: 'kept' }, TZ)).toEqual({
      beforeCancel: null,
      status: 'Your $15 deposit was kept.',
    });
    expect(manageDepositWords({ ...held, status: 'refunding' }, TZ).status).toMatch(
      /^Your \$15 deposit is on its way back/,
    );
    expect(manageDepositWords({ ...held, status: 'refunded' }, TZ).status).toBe(
      'Your $15 deposit was refunded to your card.',
    );
  });

  it('says nothing without a deposit, and that a card on file costs nothing', () => {
    expect(manageDepositWords(null, TZ)).toEqual({ beforeCancel: null, status: null });
    expect(
      manageDepositWords(
        { kind: 'card', amountCents: 0, refundEndsAt: null, status: 'held', refundableNow: false },
        TZ,
      ).beforeCancel,
    ).toBe('Cancelling costs nothing.');
  });
});

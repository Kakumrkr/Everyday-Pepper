import {
  PaymentAccountAnswerSchema,
  type PaymentAccountAnswer,
  type PaymentAccountStatus,
} from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import {
  checkedNote,
  DELETION_STRIPE_NOTE,
  dueDay,
  dueLine,
  paymentsActions,
  paymentsArrival,
  paymentsSummary,
  paymentsWords,
  requirementLabel,
  requirementsInWords,
  returnedNote,
  UNKNOWN_REQUIREMENT,
} from './payments';

const NY = 'America/New_York';
/** A fixed now, before the deadlines below, so the tests don't age. */
const NOW = new Date('2026-11-22T15:00:00.000Z');

/** A checked answer; times as plain strings, as the api sends them. */
function answer(
  patch: Partial<Omit<PaymentAccountAnswer, 'dueBy'>> & { dueBy?: string | null } = {},
): PaymentAccountAnswer {
  return PaymentAccountAnswerSchema.parse({
    status: 'ready',
    chargesEnabled: true,
    payoutsEnabled: true,
    detailsSubmitted: true,
    due: [],
    eventuallyDue: [],
    dueBy: null,
    disabledReason: null,
    syncedAt: '2026-11-22T15:00:00.000Z',
    canManage: true,
    ...patch,
  });
}

const STATUSES: readonly PaymentAccountStatus[] = [
  'not_connected',
  'onboarding',
  'pending',
  'action_needed',
  'ready',
  'rejected',
];

describe('requirementLabel (AC-X-107)', () => {
  it.each([
    ['external_account', 'Your bank account'],
    ['tos_acceptance.date', 'Accept Stripe’s terms'],
    ['tos_acceptance.ip', 'Accept Stripe’s terms'],
    ['business_type', 'Your type of business'],
    ['business_profile.mcc', 'What your business does'],
    ['business_profile.url', 'Your website, or a few words about your business'],
    ['settings.payments.statement_descriptor', 'The name clients see on their card statement'],
    ['company.tax_id', 'Your business’s tax ID (EIN)'],
    ['company.address.line1', 'Your business address'],
    ['company.owners_provided', 'Who owns and runs the business'],
    ['individual.verification.document', 'A photo ID'],
    ['individual.verification.additional_document', 'A proof of address'],
    ['individual.id_number', 'Your Social Security number'],
    ['individual.ssn_last_4', 'The last 4 digits of your Social Security number'],
    ['individual.dob.day', 'Your date of birth'],
    ['individual.first_name', 'Your name'],
    ['individual.address.postal_code', 'Your home address'],
    ['representative.phone', 'Your phone number'],
    ['representative.relationship.title', 'Your role in the business'],
    ['person_1AbcXyz.dob.year', 'Details of another owner or director'],
    ['owners.first_name', 'Details of another owner or director'],
  ])('%s reads "%s"', (code, words) => {
    expect(requirementLabel(code)).toBe(words);
  });

  it('never shows a code it doesn’t know, nor a near miss of one it does', () => {
    for (const code of [
      'something_new',
      'individual.political_exposure',
      'external_accounts',
      'companyx.name',
      'individual',
    ]) {
      expect(requirementLabel(code)).toBe(UNKNOWN_REQUIREMENT);
    }
  });

  it('says each thing once, in Stripe’s order', () => {
    expect(
      requirementsInWords([
        'individual.dob.day',
        'external_account',
        'individual.dob.month',
        'individual.dob.year',
        'mystery.one',
        'mystery.two',
      ]),
    ).toEqual(['Your date of birth', 'Your bank account', UNKNOWN_REQUIREMENT]);
  });
});

describe('dueDay', () => {
  it('is the day in the business’s time zone, not the server’s', () => {
    // 03:00 UTC on Dec 4 is still Dec 3 in New York.
    expect(dueDay('2026-12-04T03:00:00.000Z', NY)).toBe('Dec 3');
    expect(dueDay(new Date('2026-12-04T03:00:00.000Z'), 'UTC')).toBe('Dec 4');
  });
});

describe('paymentsWords (AC-X-107)', () => {
  it('has words, never codes, for every status', () => {
    for (const status of STATUSES) {
      const words = paymentsWords(answer({ status, due: ['individual.id_number'] }), NY, NOW);
      for (const text of [words.badge, words.title, words.body]) {
        expect(text).not.toMatch(/_|\b(?:sync|requirement|null)\b|!/i);
        expect(text.length).toBeGreaterThan(0);
      }
    }
  });

  it('says what is due and by when, and that payouts wait', () => {
    const one = paymentsWords(
      answer({
        status: 'action_needed',
        payoutsEnabled: false,
        due: ['individual.verification.document'],
        dueBy: '2026-12-04T03:00:00.000Z',
      }),
      NY,
    );
    expect(one.title).toBe('Stripe needs one more thing');
    expect(one.body).toBe(
      'Send it by Dec 3 so payments keep working. Payments are on; payouts wait.',
    );
    expect(one.tone).toBe('warn');

    const few = paymentsWords(
      answer({
        status: 'action_needed',
        chargesEnabled: false,
        payoutsEnabled: false,
        due: ['external_account', 'individual.dob.day', 'individual.dob.month'],
      }),
      NY,
    );
    expect(few.title).toBe('Stripe needs a few more things');
    expect(few.body).toBe('Send them so payments keep working.');
  });

  it('counts things in words, so three date-of-birth codes are one thing', () => {
    const words = paymentsWords(
      answer({ status: 'action_needed', due: ['individual.dob.day', 'individual.dob.year'] }),
      NY,
    );
    expect(words.title).toBe('Stripe needs one more thing');
  });

  it('tones by status: ready is ok, rejected is danger', () => {
    expect(paymentsWords(answer(), NY, NOW).tone).toBe('ok');
    expect(paymentsWords(answer({ status: 'rejected' }), NY, NOW).tone).toBe('danger');
  });
});

describe('paymentsSummary (AC-X-106)', () => {
  it('sums it up for More', () => {
    expect(paymentsSummary(answer(), NY, NOW)).toBe('Payments are on');
    expect(paymentsSummary(answer({ status: 'not_connected' }), NY, NOW)).toBe(
      'Take deposits with Stripe',
    );
    expect(
      paymentsSummary(
        answer({
          status: 'action_needed',
          due: ['external_account'],
          dueBy: '2026-12-04T03:00:00.000Z',
        }),
        NY,
        NOW,
      ),
    ).toBe('Stripe needs one more thing by Dec 3');
    expect(
      paymentsSummary(answer({ status: 'action_needed', due: ['external_account'] }), NY, NOW),
    ).toBe('Stripe needs one more thing');
  });
});

describe('paymentsActions (AC-X-108, AC-X-109)', () => {
  it('gives a manager nothing to press', () => {
    for (const status of STATUSES) {
      expect(paymentsActions(answer({ status, canManage: false }))).toEqual({
        onboarding: null,
        dashboard: false,
        check: false,
      });
    }
  });

  it('opens Stripe’s pages while something is left to send', () => {
    const notConnected = answer({ status: 'not_connected', detailsSubmitted: false });
    expect(paymentsActions(notConnected)).toEqual({
      onboarding: 'Connect with Stripe',
      dashboard: false,
      check: false,
    });
    expect(paymentsActions(answer({ status: 'onboarding', detailsSubmitted: false }))).toEqual({
      onboarding: 'Finish with Stripe',
      dashboard: false,
      check: false,
    });
    expect(paymentsActions(answer({ status: 'action_needed', due: ['external_account'] }))).toEqual(
      {
        onboarding: 'Send it to Stripe',
        dashboard: true,
        check: false,
      },
    );
  });

  it('offers the dashboard once the details are in, and a fresh check while Stripe checks', () => {
    expect(paymentsActions(answer())).toEqual({ onboarding: null, dashboard: true, check: false });
    expect(paymentsActions(answer({ status: 'pending' }))).toEqual({
      onboarding: null,
      dashboard: true,
      check: true,
    });
    expect(paymentsActions(answer({ status: 'rejected', detailsSubmitted: false }))).toEqual({
      onboarding: null,
      dashboard: false,
      check: false,
    });
    // Disconnected by Stripe: the old account's details don't open a dashboard.
    expect(paymentsActions(answer({ status: 'not_connected' })).dashboard).toBe(false);
  });
});

describe('arrival and notes (AC-X-108)', () => {
  it('reads where the browser came back from', () => {
    expect(paymentsArrival({ stripe: 'return' })).toBe('return');
    expect(paymentsArrival({ stripe: 'refresh' })).toBe('refresh');
    expect(paymentsArrival({ sandbox: 'dashboard' })).toBe('sandbox-dashboard');
    expect(paymentsArrival({ stripe: ['return', 'refresh'] })).toBeNull();
    expect(paymentsArrival({ stripe: 'other' })).toBeNull();
    expect(paymentsArrival({})).toBeNull();
  });

  it('has a plain note for every status', () => {
    for (const status of STATUSES) {
      expect(returnedNote(status)).toMatch(/\.$/);
      expect(returnedNote(status)).not.toMatch(/_/);
    }
    expect(checkedNote('pending')).toBe('Stripe is still checking.');
    expect(checkedNote('ready')).toBe('Payments are ready.');
  });

  it('says on the deletion screen that the Stripe account is the owner’s (AC-X-110)', () => {
    expect(DELETION_STRIPE_NOTE.title).toBe('Your Stripe account stays yours');
    expect(DELETION_STRIPE_NOTE.meta).toBe(
      'Pepper can’t close it for you. If you want it closed, ask Stripe.',
    );
  });
});

describe('a deadline that has passed, and Stripe pausing on its own (AC-X-107)', () => {
  const past = '2026-11-01T17:00:00.000Z';

  it('says "was due" under each thing once the day has gone', () => {
    expect(dueLine('2026-12-04T03:00:00.000Z', NY, NOW)).toBe('By Dec 3');
    expect(dueLine(past, NY, NOW)).toBe('Was due Nov 1');
  });

  it('asks for it now, never "by" a day that has gone', () => {
    const overdue = answer({
      status: 'action_needed',
      chargesEnabled: false,
      payoutsEnabled: false,
      due: ['external_account'],
      dueBy: past,
    });
    const words = paymentsWords(overdue, NY, NOW);
    expect(words.badge).toBe('Overdue');
    expect(words.tone).toBe('danger');
    expect(words.body).toBe('Send it now. Stripe wanted it by Nov 1.');
    expect(paymentsSummary(overdue, NY, NOW)).toBe('Stripe needs one more thing, now');
    expect(paymentsActions(overdue).onboarding).toBe('Send it to Stripe');
  });

  it('with nothing to send, says Stripe paused payments and offers only its dashboard', () => {
    const paused = answer({
      status: 'action_needed',
      chargesEnabled: false,
      payoutsEnabled: false,
      due: [],
      disabledReason: 'platform_paused',
    });
    const words = paymentsWords(paused, NY, NOW);
    expect(words.title).toBe('Stripe paused payments');
    expect(words.body).not.toMatch(/Send/);
    expect(paymentsSummary(paused, NY, NOW)).toBe('Stripe paused payments');
    expect(paymentsActions(paused)).toEqual({ onboarding: null, dashboard: true, check: false });
  });
});

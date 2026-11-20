import { describe, expect, it } from 'vitest';
import {
  AuditChangeSchema,
  isHandledStripeEvent,
  PAYMENT_REQUIREMENTS_MAX,
  paymentAccountStatus,
  PaymentAccountSnapshotSchema,
  snapshotOfStripeAccount,
  StripeAccountSchema,
  StripeEventSchema,
  type PaymentAccountSnapshot,
} from './index.js';

const base: PaymentAccountSnapshot = {
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  currentlyDue: [],
  pastDue: [],
  eventuallyDue: [],
  pendingVerification: [],
  currentDeadline: null,
  disabledReason: null,
};

function status(changes: Partial<PaymentAccountSnapshot>, deauthorized = false) {
  return paymentAccountStatus({ ...base, ...changes, deauthorized });
}

describe('paymentAccountStatus (AC-X-94)', () => {
  it('is not_connected with no account, or once Stripe disconnected it', () => {
    expect(paymentAccountStatus(null)).toBe('not_connected');
    expect(
      status({ chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true }, true),
    ).toBe('not_connected');
  });

  it('is onboarding until the owner submits Stripe’s pages', () => {
    expect(status({ currentlyDue: ['external_account', 'tos_acceptance.date'] })).toBe(
      'onboarding',
    );
  });

  it('is ready when payments and payouts are on and nothing is due', () => {
    const ready = { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true };
    expect(status(ready)).toBe('ready');
    // Later requirements don't stop a business taking payments today.
    expect(status({ ...ready, eventuallyDue: ['individual.id_number'] })).toBe('ready');
  });

  it('is action_needed when anything is currently or past due, even with payments on', () => {
    const on = { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true };
    expect(status({ ...on, currentlyDue: ['individual.verification.document'] })).toBe(
      'action_needed',
    );
    expect(
      status({
        detailsSubmitted: true,
        pastDue: ['external_account'],
        disabledReason: 'requirements.past_due',
      }),
    ).toBe('action_needed');
  });

  it('is pending while Stripe checks, with nothing for the owner to do', () => {
    expect(status({ detailsSubmitted: true })).toBe('pending');
    expect(
      status({ detailsSubmitted: true, disabledReason: 'requirements.pending_verification' }),
    ).toBe('pending');
    expect(status({ detailsSubmitted: true, disabledReason: 'under_review' })).toBe('pending');
    expect(
      status({
        detailsSubmitted: true,
        chargesEnabled: true,
        pendingVerification: ['individual.dob.day'],
      }),
    ).toBe('pending');
  });

  it('is action_needed when Stripe paused it for any other reason', () => {
    for (const reason of [
      'listed',
      'other',
      'platform_paused',
      'action_required.requested_capabilities',
    ]) {
      expect(status({ detailsSubmitted: true, disabledReason: reason })).toBe('action_needed');
    }
  });

  it('is rejected for every rejected.* reason, whatever else holds', () => {
    for (const reason of [
      'rejected.fraud',
      'rejected.terms_of_service',
      'rejected.platform_other',
    ]) {
      expect(status({ disabledReason: reason })).toBe('rejected');
      expect(status({ detailsSubmitted: true, currentlyDue: ['x'], disabledReason: reason })).toBe(
        'rejected',
      );
    }
  });
});

describe('Stripe shapes (ADR-0067 §2)', () => {
  const account = {
    id: 'acct_1Nv0FGQ9RKHgCVdK',
    object: 'account',
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: true,
    business_profile: { name: 'Fade Room' },
    requirements: {
      alternatives: [],
      current_deadline: 1_764_720_000,
      currently_due: ['external_account', 'external_account'],
      disabled_reason: 'requirements.past_due',
      errors: [],
      eventually_due: ['external_account', 'individual.id_number'],
      past_due: ['external_account'],
      pending_verification: [],
    },
  };

  it('keeps only what Pepper uses, de-duplicates the codes and reads the deadline as UTC', () => {
    const snapshot = snapshotOfStripeAccount(StripeAccountSchema.parse(account));
    expect(snapshot).toEqual({
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: true,
      currentlyDue: ['external_account'],
      pastDue: ['external_account'],
      eventuallyDue: ['external_account', 'individual.id_number'],
      pendingVerification: [],
      currentDeadline: '2025-12-03T00:00:00.000Z',
      disabledReason: 'requirements.past_due',
    });
    expect(PaymentAccountSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('reads a fresh account without requirements as off with nothing due', () => {
    const snapshot = snapshotOfStripeAccount(
      StripeAccountSchema.parse({ id: 'acct_123', object: 'account', requirements: null }),
    );
    expect(paymentAccountStatus({ ...snapshot, deauthorized: false })).toBe('onboarding');
    expect(snapshot.currentDeadline).toBeNull();
  });

  it('caps each list of codes', () => {
    const many = Array.from(
      { length: PAYMENT_REQUIREMENTS_MAX + 20 },
      (_, i) => `person_${String(i)}.dob.day`,
    );
    const snapshot = snapshotOfStripeAccount(
      StripeAccountSchema.parse({ ...account, requirements: { currently_due: many } }),
    );
    expect(snapshot.currentlyDue).toHaveLength(PAYMENT_REQUIREMENTS_MAX);
  });

  it('refuses an id, a code or a reason that is not Stripe’s shape', () => {
    expect(StripeAccountSchema.safeParse({ ...account, id: 'cus_123' }).success).toBe(false);
    expect(
      StripeAccountSchema.safeParse({ ...account, requirements: { currently_due: ['has space'] } })
        .success,
    ).toBe(false);
    expect(
      StripeAccountSchema.safeParse({ ...account, requirements: { disabled_reason: 'DROP TABLE' } })
        .success,
    ).toBe(false);
  });

  it('reads a Connect event’s envelope and nothing it doesn’t need', () => {
    const event = StripeEventSchema.parse({
      id: 'evt_1NG8Du2eZvKYlo2CUI79vXWy',
      object: 'event',
      api_version: '2026-11-18.endive',
      account: 'acct_1Nv0FGQ9RKHgCVdK',
      created: 1_764_720_000,
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: 'account.updated',
      data: { object: { id: 'acct_1Nv0FGQ9RKHgCVdK', charges_enabled: true } },
    });
    expect(event).toEqual({
      id: 'evt_1NG8Du2eZvKYlo2CUI79vXWy',
      object: 'event',
      account: 'acct_1Nv0FGQ9RKHgCVdK',
      created: 1_764_720_000,
      livemode: false,
      type: 'account.updated',
    });
    // A type Pepper doesn't act on is still an event (acknowledged and ignored, never a 400).
    expect(StripeEventSchema.safeParse({ ...event, type: 'v2.core.account.updated' }).success).toBe(
      true,
    );
    expect(StripeEventSchema.safeParse({ ...event, id: 'ev_1' }).success).toBe(false);
    expect(StripeEventSchema.safeParse({ ...event, created: 12 }).success).toBe(false);
  });

  it('acts on account changes and disconnection only', () => {
    expect(isHandledStripeEvent('account.updated')).toBe(true);
    expect(isHandledStripeEvent('capability.updated')).toBe(true);
    expect(isHandledStripeEvent('account.application.deauthorized')).toBe(true);
    expect(isHandledStripeEvent('charge.succeeded')).toBe(false);
  });
});

describe('payments audit entries', () => {
  const entity = { type: 'payment_account', id: '0b9b2f9e-8d6d-4e7c-9d7f-3c1f0c9a1a11' };

  it('holds statuses only', () => {
    expect(
      AuditChangeSchema.safeParse({
        action: 'payments.account_status_changed',
        entity,
        before: { status: 'onboarding' },
        after: { status: 'ready' },
      }).success,
    ).toBe(true);
    expect(
      AuditChangeSchema.safeParse({
        action: 'payments.account_status_changed',
        entity,
        before: { status: 'onboarding' },
        after: { status: 'ready', due: ['external_account'] },
      }).success,
    ).toBe(false);
    expect(
      AuditChangeSchema.safeParse({
        action: 'payments.account_created',
        entity,
        before: null,
        after: { provider: 'stripe' },
      }).success,
    ).toBe(true);
  });
});

import type { PaymentAccountStatus } from '@pepper/contracts';

// What the owner hears when payments change (S65 top-up, ADR-0067 §7, AC-X-102): one push for
// a change they should know about, opening More → Payments. Never a client's or person's details
// (it shows on a lock screen); the deadline as a date in the business's time zone.

export const PAYMENTS_PAGE = '/more/payments';

export interface PaymentsNotice {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/** A date as the owner reads it ("Dec 3"), in `timeZone`. */
export function deadlineDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(at);
}

/**
 * The push for a change from `before` to `after`, or `null` when there is nothing to tell:
 * the same status, or a change the owner made happen themselves on Stripe's pages and is
 * looking at (onboarding, pending, disconnected).
 */
export function paymentsNotice(
  before: PaymentAccountStatus,
  after: PaymentAccountStatus,
  options: { dueBy: Date | null; timeZone: string },
): PaymentsNotice | null {
  if (before === after) return null;
  const tag = `payments-${after}`;
  switch (after) {
    case 'ready':
      return {
        title: 'Payments are ready',
        body: 'Stripe finished checking. Pepper can take payments for you.',
        url: PAYMENTS_PAGE,
        tag,
      };
    case 'action_needed':
      return {
        title: 'Stripe needs one more thing',
        body:
          options.dueBy === null
            ? 'Finish it so payments keep working.'
            : `Finish it by ${deadlineDate(options.dueBy, options.timeZone)} so payments keep working.`,
        url: PAYMENTS_PAGE,
        tag,
      };
    case 'rejected':
      return {
        title: 'Stripe can’t take payments for you',
        body: 'Open Payments to see what to do next.',
        url: PAYMENTS_PAGE,
        tag,
      };
    case 'not_connected':
    case 'onboarding':
    case 'pending':
      return null;
  }
}

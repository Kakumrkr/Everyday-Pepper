import { z } from 'zod';
import { feeWords, moneyWords, type CancellationFee } from './cancellation-policy.js';
import { MIN_DEPOSIT_CENTS } from './deposits.js';

// The no-show fee by approval (S68, ADR-0068 amendment). The terms a client was shown are stored
// with the booking's payment when it is booked (AC-X-136); a no-show then proposes one card for
// the fee they allow, less a deposit already kept (AC-X-137); only the owner's OK charges it
// (AC-X-139). Pure and shared, so the card, the receipt and the tests say the same numbers.

/**
 * A fee's life (`booking_fees.status`): `queued` once approved (waiting out the grace, when Undo
 * still cancels it), `charging` while Stripe is asked, then `charged` or `failed`; `cancelled`
 * by an Undo before the charge; `refund_pending` → `refunded` (or `refund_failed`) by an Undo
 * after it.
 */
export const BookingFeeStatusSchema = z.enum([
  'queued',
  'charging',
  'charged',
  'failed',
  'cancelled',
  'refund_pending',
  'refunded',
  'refund_failed',
]);
export type BookingFeeStatus = z.infer<typeof BookingFeeStatusSchema>;

/** An approved fee waits this long before it is charged, so Undo moves no money (AC-X-139). */
export const NO_SHOW_FEE_GRACE_SECONDS = 60;

/**
 * The no-show fee the policy allows for a booking, in cents (AC-X-136): a fixed fee, or the
 * percent of the booked starting price (rounded to the cent); `null` with no fee, or a percent
 * of a visit with no price.
 */
export function noShowFeeCents(fee: CancellationFee, priceFromCents: number | null): number | null {
  if (fee.kind === 'none') return null;
  if (fee.kind === 'fixed') return fee.amountCents;
  if (priceFromCents === null || priceFromCents <= 0) return null;
  return Math.round((priceFromCents * fee.percent) / 100);
}

/**
 * What a card may charge (AC-X-137): the allowed fee less a deposit the booking already kept;
 * `null` when that leaves less than Stripe's smallest charge.
 */
export function noShowFeeToCharge(feeCents: number, keptDepositCents: number): number | null {
  const left = feeCents - Math.max(0, keptDepositCents);
  return left >= MIN_DEPOSIT_CENTS ? left : null;
}

/**
 * The card's decision line (AC-X-138, S68 top-up): the policy's no-show clause with the fee it
 * allows, a kept deposit, and the choice. "No-shows may be charged $20 · charge $20 or waive";
 * with a $15 deposit kept: "No-shows may be charged $20 · $15 deposit kept · charge $5 or waive".
 */
export function noShowFeeChoiceLine(input: {
  feeCents: number;
  keptDepositCents: number;
  chargeCents: number;
}): string {
  const allowed = feeWords({ kind: 'fixed', amountCents: input.feeCents }) ?? '';
  const parts = [`No-shows may be charged ${allowed}`];
  if (input.keptDepositCents > 0) parts.push(`${moneyWords(input.keptDepositCents)} deposit kept`);
  parts.push(`charge ${moneyWords(input.chargeCents)} or waive`);
  return parts.join(' · ');
}

/**
 * A booking's fee as the team's booking sheet says it (S68): "$20 no-show fee charged", and so
 * on; `null` for a fee that came to nothing (cancelled by Undo).
 */
export function noShowFeeStatusLine(status: BookingFeeStatus, amountCents: number): string | null {
  const amount = moneyWords(amountCents);
  switch (status) {
    case 'queued':
    case 'charging':
      return `${amount} no-show fee being charged`;
    case 'charged':
      return `${amount} no-show fee charged`;
    case 'failed':
      return `${amount} no-show fee declined · nothing charged`;
    case 'cancelled':
      return null;
    case 'refund_pending':
      return `${amount} no-show fee refund on its way`;
    case 'refunded':
      return `${amount} no-show fee refunded`;
    case 'refund_failed':
      return `${amount} no-show fee refund failed · check Stripe`;
  }
}

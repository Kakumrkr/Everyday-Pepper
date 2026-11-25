import { z } from 'zod';
import { MIN_DEPOSIT_CENTS } from './deposits.js';

// The cancellation policy (S67.2, ADR-0068 amendment): what the owner picks, and the one sentence
// Pepper writes from it. Pure and shared, so the settings preview, the booking page, the manage
// page and every email say the same words. The notice is the business's refund window
// (`depositRefundHours`): one setting, so the policy and the deposit can never disagree. Nothing
// here charges anything: a fee is charged only on the owner's approval (S68).

/** The largest fixed fee: the same bound as a fixed deposit. */
export const MAX_CANCELLATION_FEE_CENTS = 10_000_000;

/** What a late cancel or a no-show costs (AC-X-130): nothing, a fixed amount, or a percent. */
export const CancellationFeeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({
      kind: z.literal('fixed'),
      amountCents: z.number().int().min(MIN_DEPOSIT_CENTS).max(MAX_CANCELLATION_FEE_CENTS),
    })
    .strict(),
  z.object({ kind: z.literal('percent'), percent: z.number().int().min(1).max(100) }).strict(),
]);
export type CancellationFee = z.infer<typeof CancellationFeeSchema>;

export const CancellationFeeKindSchema = z.enum(['none', 'fixed', 'percent']);
export type CancellationFeeKind = z.infer<typeof CancellationFeeKindSchema>;

/**
 * A policy that is on (AC-X-130): the costs of a cancel later than the notice and of a no-show.
 * Stored as `tenants.cancellation_fees`; `null` there means the business has no policy.
 */
export const CancellationFeesSchema = z
  .object({ lateCancel: CancellationFeeSchema, noShow: CancellationFeeSchema })
  .strict();
export type CancellationFees = z.infer<typeof CancellationFeesSchema>;

/** A policy just turned on: the notice alone, no fees. */
export const NO_CANCELLATION_FEES: CancellationFees = {
  lateCancel: { kind: 'none' },
  noShow: { kind: 'none' },
};

const DOLLARS = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const DOLLARS_AND_CENTS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Cents as clients read them: "$45", "$12.50" (the same as the kit's `formatMoney`). */
export function moneyWords(cents: number): string {
  if (!Number.isInteger(cents)) throw new RangeError(`Money is whole cents: ${String(cents)}`);
  return (cents % 100 === 0 ? DOLLARS : DOLLARS_AND_CENTS).format(cents / 100);
}

/** "Tue, Nov 3, 9:15 AM" on the business's clock. */
export function shortDateTimeWords(timeZone: string, instant: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(instant));
}

/** A notice in hours: "Up to the start", "1 hour", "24 hours", "2 days", "1 week". */
export function noticeHoursLabel(hours: number): string {
  if (hours === 0) return 'Up to the start';
  if (hours === 168) return '1 week';
  if (hours > 24 && hours % 24 === 0) return `${String(hours / 24)} days`;
  return hours === 1 ? '1 hour' : `${String(hours)} hours`;
}

/** A fee in the sentence: "$20", "50% of the service price", "the full service price". */
export function feeWords(fee: CancellationFee): string | null {
  if (fee.kind === 'none') return null;
  if (fee.kind === 'fixed') return moneyWords(fee.amountCents);
  return fee.percent === 100
    ? 'the full service price'
    : `${String(fee.percent)}% of the service price`;
}

/**
 * The policy in one sentence (AC-X-131), or `null` when the business has none (`fees` null).
 * With a notice of 0 a cancel is never late, so only a no-show can cost something.
 */
export function cancellationSentence(
  fees: CancellationFees | null,
  noticeHours: number,
): string | null {
  if (fees === null) return null;
  const ahead = noticeHoursLabel(noticeHours)
    .replace(/^1 /, 'a ')
    .replace(/^a hour$/, 'an hour');
  const notice =
    noticeHours === 0
      ? 'Please cancel or reschedule before your visit starts.'
      : `Please cancel or reschedule at least ${ahead} before your visit.`;
  const late = noticeHours === 0 ? null : feeWords(fees.lateCancel);
  const noShow = feeWords(fees.noShow);
  let cost: string | null = null;
  if (late !== null && noShow !== null) {
    cost =
      late === noShow
        ? `Later cancels and no-shows may be charged ${late}.`
        : `Later cancels may be charged ${late}, and no-shows ${noShow}.`;
  } else if (late !== null) {
    cost = `Later cancels may be charged ${late}.`;
  } else if (noShow !== null) {
    cost = `No-shows may be charged ${noShow}.`;
  }
  return cost === null ? notice : `${notice} ${cost}`;
}

/**
 * A paid deposit in one line (AC-X-129, AC-X-134): the team's booking sheet and the client's
 * confirmation email say it alike, from the stored window, in the business's time zone.
 */
export function depositPaidLine(
  deposit: { amountCents: number; refundEndsAt: string | null; refundableNow: boolean },
  timeZone: string,
): string {
  const amount = moneyWords(deposit.amountCents);
  return deposit.refundableNow && deposit.refundEndsAt !== null
    ? `${amount} deposit paid · refundable until ${shortDateTimeWords(timeZone, deposit.refundEndsAt)}`
    : `${amount} deposit paid · no longer refundable`;
}

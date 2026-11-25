import {
  cancellationSentence,
  MAX_CANCELLATION_FEE_CENTS,
  MIN_DEPOSIT_CENTS,
  NO_CANCELLATION_FEES,
  type CancellationFee,
  type CancellationFeeKind,
  type CancellationFees,
} from '@pepper/contracts';
import { centsFromText, textFromCents } from './setup';

// The cancellation-policy builder in booking page settings (S67.2, AC-X-130/131): the owner's
// choices as typed, checked into the contract's terms, and the sentence Pepper writes from them
// (the same function the pages and the emails use).

/** What each cost can be, in the order shown. */
export const FEE_CHOICES: readonly { value: CancellationFeeKind; label: string }[] = [
  { value: 'none', label: 'Nothing' },
  { value: 'fixed', label: 'Amount' },
  { value: 'percent', label: 'Percent' },
];

/** One cost as typed: the choice and its two texts. */
export interface FeeFields {
  kind: CancellationFeeKind;
  amount: string;
  percent: string;
}

export function feeFields(fee: CancellationFee | undefined): FeeFields {
  return {
    kind: fee?.kind ?? 'none',
    amount: fee?.kind === 'fixed' ? textFromCents(fee.amountCents) : '',
    percent: fee?.kind === 'percent' ? String(fee.percent) : '',
  };
}

export type FeeCheck = { ok: true; fee: CancellationFee } | { ok: false; message: string };

/** The cost the fields say, or what to fix, in the contract's bounds. */
export function feeFrom(fields: FeeFields): FeeCheck {
  if (fields.kind === 'none') return { ok: true, fee: { kind: 'none' } };
  if (fields.kind === 'fixed') {
    const cents = centsFromText(fields.amount);
    if (cents === null || cents === 'invalid') {
      return { ok: false, message: 'Enter the fee as an amount, e.g. 20 or 12.50.' };
    }
    if (cents < MIN_DEPOSIT_CENTS) return { ok: false, message: 'A fee is at least $0.50.' };
    if (cents > MAX_CANCELLATION_FEE_CENTS) {
      return { ok: false, message: 'A fee is at most $100,000.' };
    }
    return { ok: true, fee: { kind: 'fixed', amountCents: cents } };
  }
  // Digits only: `Number` would also take "1e2" or "0x32" (review).
  const typed = fields.percent.trim();
  const percent = Number(typed);
  if (!/^\d{1,3}$/.test(typed) || percent < 1 || percent > 100) {
    return { ok: false, message: 'Enter a whole percent from 1 to 100.' };
  }
  return { ok: true, fee: { kind: 'percent', percent } };
}

/** The builder's state: on or off, the two costs as typed. */
export interface PolicyFields {
  on: boolean;
  lateCancel: FeeFields;
  noShow: FeeFields;
}

export function policyFields(fees: CancellationFees | null): PolicyFields {
  return {
    on: fees !== null,
    lateCancel: feeFields(fees?.lateCancel),
    noShow: feeFields(fees?.noShow),
  };
}

export type PolicyCheck =
  | { ok: true; fees: CancellationFees | null }
  | { ok: false; errors: Partial<Record<'lateCancel' | 'noShow', string>> };

/**
 * The terms to save (`null`: off). A notice of 0 has no late cancel, so its fee is dropped; where
 * fees aren't offered (payments off) none is kept, so clients are never told of a fee the owner
 * can't see or charge (review).
 */
export function policyFrom(
  fields: PolicyFields,
  options: { noticeHours: number; feesOffered: boolean; stored: CancellationFees | null },
): PolicyCheck {
  if (!fields.on) return { ok: true, fees: null };
  if (!options.feesOffered) return { ok: true, fees: NO_CANCELLATION_FEES };
  const errors: Partial<Record<'lateCancel' | 'noShow', string>> = {};
  const late: FeeCheck =
    options.noticeHours === 0 ? { ok: true, fee: { kind: 'none' } } : feeFrom(fields.lateCancel);
  const noShow = feeFrom(fields.noShow);
  if (!late.ok) errors.lateCancel = late.message;
  if (!noShow.ok) errors.noShow = noShow.message;
  if (!late.ok || !noShow.ok) return { ok: false, errors };
  return { ok: true, fees: { lateCancel: late.fee, noShow: noShow.fee } };
}

/**
 * The sentence as clients will read it, while typing (AC-X-131): a cost not yet right is left
 * out rather than shown wrong; `null` when the policy is off.
 */
export function policyPreview(
  fields: PolicyFields,
  options: { noticeHours: number; feesOffered: boolean; stored: CancellationFees | null },
): string | null {
  if (!fields.on) return null;
  if (!options.feesOffered) return cancellationSentence(NO_CANCELLATION_FEES, options.noticeHours);
  const fee = (f: FeeFields): CancellationFee => {
    const checked = feeFrom(f);
    return checked.ok ? checked.fee : { kind: 'none' };
  };
  return cancellationSentence(
    { lateCancel: fee(fields.lateCancel), noShow: fee(fields.noShow) },
    options.noticeHours,
  );
}

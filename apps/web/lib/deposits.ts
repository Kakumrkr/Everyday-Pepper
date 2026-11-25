import {
  DEFAULT_DEPOSIT_REFUND_HOURS,
  depositPaidLine,
  depositCentsOf,
  depositRuleProblem,
  MAX_DEPOSIT_REFUND_HOURS,
  MIN_DEPOSIT_CENTS,
  noticeHoursLabel,
  type BookingDeposit,
  type BookingPaymentStart,
  type DepositAudience,
  type DepositKind,
  type DepositRule,
  type DepositTerms,
  type PublicBookingDeposit,
} from '@pepper/contracts';
import { formatMoney } from '@pepper/ui';
import { dateTimeLabel } from './booking';
import { centsFromText, textFromCents } from './setup';

// Deposits in words (S66.2, ADR-0068): the service sheet's field, the refund window, the booking
// page's terms before Stripe's card field, and the manage page's line before Cancel. One place,
// so the owner's sheet, the client's page and the tests say the same thing.

/** The largest fixed deposit the contract takes (`DepositRuleSchema`). */
const MAX_FIXED_DEPOSIT_CENTS = 10_000_000;

/** The service sheet's choice, in the order shown. */
export const DEPOSIT_CHOICES: readonly { value: DepositKind; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'fixed', label: 'Amount' },
  { value: 'percent', label: 'Percent' },
  { value: 'card', label: 'Card' },
];

/** What the deposit field holds while typing: the choice and its two texts. */
export interface DepositFields {
  kind: DepositKind;
  amount: string;
  percent: string;
}

export function depositFields(rule: DepositRule | undefined): DepositFields {
  return {
    kind: rule?.kind ?? 'none',
    amount: rule?.kind === 'fixed' ? textFromCents(rule.amountCents) : '',
    percent: rule?.kind === 'percent' ? String(rule.percent) : '',
  };
}

export type DepositCheck = { ok: true; rule: DepositRule } | { ok: false; message: string };

/**
 * The rule the fields say, checked against the price typed beside it (`null`: no price), with
 * the domain's own messages (AC-X-111), so the sheet says what the api would refuse.
 */
export function depositRuleFrom(
  fields: DepositFields,
  priceFromCents: number | null,
): DepositCheck {
  let rule: DepositRule;
  if (fields.kind === 'none' || fields.kind === 'card') {
    rule = { kind: fields.kind };
  } else if (fields.kind === 'fixed') {
    const cents = centsFromText(fields.amount);
    if (cents === null || cents === 'invalid') {
      return { ok: false, message: 'Enter the deposit as an amount, e.g. 15 or 12.50.' };
    }
    if (cents < MIN_DEPOSIT_CENTS) return { ok: false, message: 'A deposit is at least $0.50.' };
    if (cents > MAX_FIXED_DEPOSIT_CENTS) {
      return { ok: false, message: 'A deposit is at most $100,000.' };
    }
    rule = { kind: 'fixed', amountCents: cents };
  } else {
    const percent = Number(fields.percent.trim());
    if (
      fields.percent.trim() === '' ||
      !Number.isInteger(percent) ||
      percent < 1 ||
      percent > 100
    ) {
      return { ok: false, message: 'Enter a whole percent from 1 to 100.' };
    }
    rule = { kind: 'percent', percent };
  }
  const problem = depositRuleProblem(rule, priceFromCents);
  return problem === null ? { ok: true, rule } : { ok: false, message: `${problem.message}.` };
}

/** What a percent comes to at the typed price (D-3): "20% · $9 of $45"; `null` when it can't. */
export function percentPreview(percentText: string, priceFromCents: number | null): string | null {
  const percent = Number(percentText.trim());
  if (priceFromCents === null || !Number.isInteger(percent) || percent < 1 || percent > 100) {
    return null;
  }
  const cents = depositCentsOf({ kind: 'percent', percent }, priceFromCents);
  return `${String(percent)}% · ${formatMoney(cents)} of ${formatMoney(priceFromCents)}`;
}

/**
 * The deposit on the menu's row: "Deposit $15", "Deposit 20% ($9)", "Card on file", or none;
 * with new clients and no-shows only, "… · new clients" (S67, AC-X-128).
 */
export function depositLabel(
  rule: DepositRule,
  priceFromCents: number | null,
  audience: DepositAudience = 'everyone',
): string | null {
  const label = ruleLabel(rule, priceFromCents);
  return label === null || audience === 'everyone' ? label : `${label} · new clients`;
}

function ruleLabel(rule: DepositRule, priceFromCents: number | null): string | null {
  if (rule.kind === 'none') return null;
  if (rule.kind === 'card') return 'Card on file';
  if (rule.kind === 'fixed') return `Deposit ${formatMoney(rule.amountCents)}`;
  const cents = depositCentsOf(rule, priceFromCents);
  return priceFromCents === null
    ? `Deposit ${String(rule.percent)}%`
    : `Deposit ${String(rule.percent)}% (${formatMoney(cents)})`;
}

/**
 * A service's terms on the booking page's menu (AC-X-113): "$15 deposit", "Card to book"; with
 * new clients and no-shows only, "… for new clients" (S67, AC-X-128).
 */
export function termsLabel(
  terms: DepositTerms | null,
  audience: DepositAudience = 'everyone',
): string | null {
  if (terms === null) return null;
  const label =
    terms.kind === 'card' ? 'Card to book' : `${formatMoney(terms.amountCents)} deposit`;
  return audience === 'everyone' ? label : `${label} for new clients`;
}

/** Who pays a deposit, in booking page settings (S67, AC-X-125). */
export const DEPOSIT_AUDIENCE_CHOICES: readonly { value: DepositAudience; label: string }[] = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'new_and_no_show', label: 'New and no-shows' },
];

/** What the owner's choice means, in one sentence (AC-X-125). */
export function audienceSentence(audience: DepositAudience): string {
  return audience === 'everyone'
    ? 'Every client pays the deposit to book online.'
    : 'Clients who’ve visited before book without one, unless they missed a visit in the last 12 months.';
}

/** The service sheet's line under the deposit (AC-X-128); `null` when everyone pays. */
export function audienceNote(audience: DepositAudience): string | null {
  return audience === 'everyone'
    ? null
    : 'Only new clients and clients who missed a visit pay it. Regulars don’t.';
}

/**
 * The team's booking sheet, in one line (S67 top-up, AC-X-129): what was paid and where it
 * stands, by the server's stored window, in the business's time zone. `null`: no deposit.
 */
export function teamDepositLine(deposit: BookingDeposit | null, timeZone: string): string | null {
  if (deposit === null) return null;
  if (deposit.kind === 'card') return 'Card on file';
  const amount = formatMoney(deposit.amountCents);
  switch (deposit.status) {
    case 'held':
      // The same words as the confirmation email (S67.2, AC-X-134).
      return depositPaidLine(deposit, timeZone);
    case 'kept':
      return `${amount} deposit kept`;
    case 'refunding':
      return `${amount} deposit refund on its way`;
    case 'refunded':
      return `${amount} deposit refunded`;
    case 'refund_failed':
      return `${amount} refund failed · check Stripe`;
  }
}

/** The refund windows offered (AC-X-112); the business's own is added when it isn't one. */
export const REFUND_HOUR_CHOICES = [0, 2, 6, 12, 24, 48, 72, 168] as const;

export function refundChoices(current: number): number[] {
  const all = new Set<number>([...REFUND_HOUR_CHOICES, current]);
  return [...all]
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= MAX_DEPOSIT_REFUND_HOURS)
    .sort((a, b) => a - b);
}

/** "Up to the start", "2 hours", "24 hours", "2 days", "1 week" (the policy's own words). */
export const refundHoursLabel = noticeHoursLabel;

/** The window in one sentence for the owner (AC-X-112). */
export function refundWindowSentence(hours: number = DEFAULT_DEPOSIT_REFUND_HOURS): string {
  if (hours === 0) {
    return 'Clients who cancel any time before the start get their deposit back.';
  }
  const ahead = refundHoursLabel(hours).replace(/^1 /, 'a ').toLowerCase();
  return `Clients who cancel at least ${ahead} before get their deposit back. Later, it’s kept.`;
}

/** What the booking page says before Stripe's card field (AC-X-122): a title and its lines. */
export interface PaymentWords {
  title: string;
  lines: string[];
  button: string;
}

export function paymentWords(
  start: BookingPaymentStart,
  timeZone: string,
  now: number = Date.now(),
): PaymentWords {
  const until = dateTimeLabel(timeZone, start.refundEndsAt);
  // A visit sooner than the window: no cancel gets the deposit back, and the page says so.
  const passed = Date.parse(start.refundEndsAt) <= now;
  if (start.terms.kind === 'card') {
    return {
      title: 'Add a card to book',
      lines: ['Nothing is charged now. Stripe keeps your card for this booking.'],
      button: 'Save card and book',
    };
  }
  const amount = formatMoney(start.terms.amountCents);
  const lines = [
    passed
      ? `Your visit is soon, so the ${amount} is kept if you cancel.`
      : start.terms.refundHours === 0
        ? `Cancel any time before your visit and you get the ${amount} back.`
        : `Cancel by ${until} and you get the ${amount} back. After that, it’s kept.`,
    'The rest is paid at your visit.',
  ];
  return { title: `Pay a ${amount} deposit to book`, lines, button: `Pay ${amount} and book` };
}

/**
 * The manage page's line about the deposit (AC-X-123). Before a cancel, what cancelling now does,
 * by the server's `refundableNow`; after it, what happened. `null` when there's nothing to say.
 */
export function manageDepositWords(
  deposit: PublicBookingDeposit | null,
  timeZone: string,
  now: number = Date.now(),
): { beforeCancel: string | null; status: string | null } {
  if (deposit === null) return { beforeCancel: null, status: null };
  if (deposit.kind === 'card') {
    return {
      beforeCancel: deposit.status === 'held' ? 'Cancelling costs nothing.' : null,
      status: null,
    };
  }
  const amount = formatMoney(deposit.amountCents);
  switch (deposit.status) {
    case 'held': {
      const until =
        deposit.refundEndsAt === null ? null : dateTimeLabel(timeZone, deposit.refundEndsAt);
      // The server's answer, and no longer once its stored end has passed while the page was open.
      const refundable =
        deposit.refundableNow &&
        (deposit.refundEndsAt === null || now <= Date.parse(deposit.refundEndsAt));
      return refundable
        ? {
            beforeCancel: `Cancel now and get your ${amount} back.`,
            status:
              until === null
                ? `You paid a ${amount} deposit.`
                : `You paid a ${amount} deposit. Cancel by ${until} to get it back.`,
          }
        : {
            beforeCancel: `Your ${amount} deposit is kept if you cancel now.`,
            status:
              until === null
                ? `You paid a ${amount} deposit.`
                : `You paid a ${amount} deposit. It could be refunded until ${until}.`,
          };
    }
    case 'kept':
      return { beforeCancel: null, status: `Your ${amount} deposit was kept.` };
    case 'refunding':
      return {
        beforeCancel: null,
        status: `Your ${amount} deposit is on its way back to your card. Banks take 5–10 days.`,
      };
    case 'refunded':
      return { beforeCancel: null, status: `Your ${amount} deposit was refunded to your card.` };
  }
}

/**
 * What the team's Cancel does to the deposit (S67 review; AC-X-118: the team's cancel always
 * refunds), said before they confirm; `null` when nothing is held or only a card is kept.
 */
export function teamCancelDepositWords(deposit: BookingDeposit | null): string | null {
  if (deposit?.kind !== 'deposit' || deposit.status !== 'held') return null;
  return `Their ${formatMoney(deposit.amountCents)} deposit goes back to their card.`;
}

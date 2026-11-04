import type { ReactNode } from 'react';
import { cx } from '../class-names.js';

// Small marks of the kit (DESIGN.md §4): Badge, MoneyChip, Avatar and Skeleton.

export type BadgeTone = 'neutral' | 'brand' | 'ok' | 'warn' | 'danger' | 'info';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-ink-2',
  brand: 'bg-brand-soft text-brand',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
};

/** A short status word ("Overdue", "Confirmed"); status colors only for status (DESIGN.md §2). */
export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 type-caption whitespace-nowrap',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const DOLLARS = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  // Both bounds: older Safari refuses a maximum below the currency's default minimum.
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const DOLLARS_AND_CENTS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** `cents` as dollars: whole dollars without ".00" ($45), cents when there are some ($45.50). */
export function formatMoney(cents: number): string {
  if (!Number.isInteger(cents)) throw new RangeError(`Money is whole cents: ${String(cents)}`);
  return (cents % 100 === 0 ? DOLLARS : DOLLARS_AND_CENTS).format(cents / 100);
}

/**
 * Money a decision is worth: the `accent` pill ("+$45", "~$270"). `kind` says how sure the
 * amount is: `gain` (+, booked or kept), `estimate` (~, likely), `amount` (no sign).
 */
export function MoneyChip({
  cents,
  kind = 'gain',
  className,
}: {
  cents: number;
  kind?: 'gain' | 'estimate' | 'amount';
  className?: string | undefined;
}) {
  const sign = kind === 'gain' ? '+' : kind === 'estimate' ? '~' : '';
  const spoken = kind === 'gain' ? 'adds ' : kind === 'estimate' ? 'about ' : '';
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-pill bg-accent px-2.5 py-0.5 type-label whitespace-nowrap text-accent-ink tabular-nums',
        className,
      )}
    >
      <span aria-hidden="true">
        {sign}
        {formatMoney(cents)}
      </span>
      <span className="sr-only">
        {spoken}
        {formatMoney(cents)}
      </span>
    </span>
  );
}

/**
 * Up to two initials of `name`, from its first and last words that start with a letter
 * ("Marcus Bell" → "MB", "Dre" → "D", "Client 42" → "C"; AC-W1-39); none without a letter.
 */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => /^\p{L}/u.test(word));
  // The first letter whole, even one written with two code units.
  const initial = (word: string | undefined) => /^\p{L}/u.exec(word ?? '')?.[0] ?? '';
  const first = initial(words[0]);
  const last = words.length > 1 ? initial(words[words.length - 1]) : '';
  return (first + last).toUpperCase();
}

const AVATAR_SIZES = {
  sm: 'size-8 type-caption',
  md: 'size-11 type-label',
  lg: 'size-16 type-heading',
};

/**
 * A person's initials in a circle. Decorative: the name is always written next to it, so the
 * initials are hidden from screen readers.
 */
export function Avatar({
  name,
  tone = 'brand',
  size = 'md',
  className,
}: {
  name: string;
  tone?: 'brand' | 'accent';
  size?: keyof typeof AVATAR_SIZES;
  className?: string | undefined;
}) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-pill font-semibold',
        tone === 'brand' ? 'bg-brand-soft text-brand' : 'bg-accent text-accent-ink',
        AVATAR_SIZES[size],
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}

/** A placeholder while something loads for more than 300 ms (D9); still under reduced motion. */
export function Skeleton({ className }: { className?: string | undefined }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'block h-4 animate-pulse rounded-sm bg-surface-2 motion-reduce:animate-none',
        className,
      )}
    />
  );
}

import { cx } from './class-names.js';

/**
 * The Pepper mark: a chili-red speech bubble with a face (the product is someone you talk to)
 * and a green pepper stem.
 */
export function Mark({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true" className={cx('size-8 shrink-0', className)}>
      <path
        className="fill-accent"
        d="M20 5c9.9 0 17 6.2 17 14.4S29.9 33.8 20 33.8c-1.9 0-3.7-.2-5.4-.7L7 37.4l1.3-7.2C5 27.6 3 23.7 3 19.4 3 11.2 10.1 5 20 5Z"
      />
      <path
        className="fill-none stroke-brand-strong"
        strokeWidth={3}
        strokeLinecap="round"
        d="M20 7.2c0-2.6 1.4-4.6 4.4-5.6"
      />
      <circle className="fill-on-accent" cx="14.2" cy="17.4" r="2.3" />
      <circle className="fill-on-accent" cx="25.8" cy="17.4" r="2.3" />
      <path
        className="fill-none stroke-on-accent"
        strokeWidth={2.4}
        strokeLinecap="round"
        d="M14.4 23.6c3.2 3 8 3 11.2 0"
      />
    </svg>
  );
}

/** The mark and the lowercase wordmark. */
export function Logo({ className }: { className?: string | undefined }) {
  return (
    <span className={cx('inline-flex items-center gap-2', className)}>
      <Mark />
      <span className="font-display text-2xl font-extrabold tracking-tight text-brand">pepper</span>
    </span>
  );
}

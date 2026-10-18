import { cx } from './class-names.js';

/** The Floty mark: a speech bubble with a face (the product is someone you talk to). */
export function Mark({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true" className={cx('size-8 shrink-0', className)}>
      <path
        className="fill-brand-strong"
        d="M20 3c9.9 0 17 6.6 17 15.2S29.9 33.4 20 33.4c-1.9 0-3.7-.2-5.4-.7L7 37l1.3-7.2C5 27 3 22.9 3 18.2 3 9.6 10.1 3 20 3Z"
      />
      <circle className="fill-on-brand" cx="14.2" cy="16.4" r="2.3" />
      <circle className="fill-on-brand" cx="25.8" cy="16.4" r="2.3" />
      <path
        className="fill-none stroke-on-brand"
        strokeWidth={2.4}
        strokeLinecap="round"
        d="M14.4 22.6c3.2 3 8 3 11.2 0"
      />
    </svg>
  );
}

/** The mark and the lowercase wordmark. */
export function Logo({ className }: { className?: string | undefined }) {
  return (
    <span className={cx('inline-flex items-center gap-2', className)}>
      <Mark />
      <span className="font-display text-2xl font-extrabold tracking-tight text-brand">floty</span>
    </span>
  );
}

import type { ReactNode } from 'react';

// Two small form parts: `Field` for the forms not yet on the kit's fields (task cards, the
// clients search; S43.2), and `Notice`, the error or result line every screen shows. The kit's
// Sheet replaced the sheet that lived beside them (S42.2).

/** A form field: a label above its control, with an optional hint. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1.5 font-semibold">
      {label}
      {children}
      {hint === undefined ? null : <span className="text-sm font-normal text-ink-2">{hint}</span>}
    </label>
  );
}

/** An error or result line, announced to screen readers. */
export function Notice({ tone, children }: { tone: 'error' | 'ok'; children: ReactNode }) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={
        tone === 'error'
          ? 'm-0 rounded-md bg-danger-soft px-4 py-3 type-body font-semibold text-danger'
          : 'm-0 rounded-md bg-ok-soft px-4 py-3 type-body font-semibold text-ok'
      }
    >
      {children}
    </p>
  );
}

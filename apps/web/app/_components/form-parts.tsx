import type { ReactNode } from 'react';

// `Notice`, the error or result line every screen shows. The kit's Input and Sheet replaced
// the field and sheet that lived beside it (S42.2, S43.2).

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

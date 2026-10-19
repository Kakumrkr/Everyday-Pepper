'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { buttonClass, Icon } from '@pepper/ui';
import type { ReactNode } from 'react';

/**
 * A dialog that slides up from the bottom on phones and sits in the middle from 960 px.
 * Radix keeps focus inside, closes on Escape and returns focus to the trigger.
 */
export function Sheet({
  trigger,
  title,
  description,
  open,
  onOpenChange,
  children,
}: {
  trigger: ReactNode;
  title: string;
  description?: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content
          {...(description === undefined && { 'aria-describedby': undefined })}
          className="fixed inset-x-0 bottom-0 z-50 max-h-[92dvh] overflow-y-auto rounded-t-lg border border-line bg-surface p-5 text-ink shadow-xl desk:inset-x-auto desk:top-1/2 desk:bottom-auto desk:left-1/2 desk:w-[34rem] desk:-translate-x-1/2 desk:-translate-y-1/2 desk:rounded-lg"
        >
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Dialog.Title className="m-0 font-display text-xl font-bold">{title}</Dialog.Title>
              {description === undefined ? null : (
                <Dialog.Description className="m-0 mt-1 text-ink-2">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close
              aria-label="Close"
              className={buttonClass({ variant: 'quiet', size: 'sm', className: 'w-11 px-0' })}
            >
              <Icon name="close" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

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
          ? 'm-0 rounded-md bg-wait-soft px-4 py-3 font-semibold text-wait'
          : 'm-0 rounded-md bg-ok-soft px-4 py-3 font-semibold text-ok'
      }
    >
      {children}
    </p>
  );
}

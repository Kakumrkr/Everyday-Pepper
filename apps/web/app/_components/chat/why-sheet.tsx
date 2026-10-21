'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { buttonClass, Icon, WhyContent, type WhyModel } from '@pepper/ui';
import Link from 'next/link';
import { ROUTES } from '../../../lib/account';

/**
 * *Why?* (D-2, Microsoft HAX G11): a sheet from the bottom on phones, assembled from the stored
 * record. Radix keeps focus inside and closes on Escape; focus returns to the Why? button.
 */
export function WhySheet({
  open,
  onOpenChange,
  why,
  proposed,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  why: WhyModel;
  proposed: boolean;
  /** The Why? button: focus goes back there on close (no Dialog.Trigger restores it). */
  returnFocus: () => HTMLElement | null;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus()?.focus();
          }}
          className="fixed inset-x-0 bottom-0 z-50 max-h-[92dvh] overflow-y-auto rounded-t-lg border border-line bg-surface p-5 text-ink shadow-xl desk:inset-x-auto desk:top-1/2 desk:bottom-auto desk:left-1/2 desk:w-[34rem] desk:-translate-x-1/2 desk:-translate-y-1/2 desk:rounded-lg"
        >
          <div className="mb-4 flex items-start justify-between gap-3">
            <Dialog.Title className="m-0 font-display text-xl font-bold">
              {proposed ? 'Why I suggested this' : 'Why I did this'}
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className={buttonClass({ variant: 'quiet', size: 'sm', className: 'w-11 px-0' })}
            >
              <Icon name="close" />
            </Dialog.Close>
          </div>
          <WhyContent
            why={why}
            autonomyLink={{ label: 'Change it in Autonomy', href: ROUTES.autonomy }}
            renderLink={(link) => (
              <Link
                href={link.href}
                className="font-semibold text-brand underline underline-offset-2"
              >
                {link.label}
              </Link>
            )}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

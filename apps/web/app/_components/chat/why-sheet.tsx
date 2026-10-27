'use client';

import { Sheet, WhyContent, type WhyModel } from '@pepper/ui';
import Link from 'next/link';
import { ROUTES } from '../../../lib/account';

/**
 * *Why?* (D-2, Microsoft HAX G11): a sheet from the bottom on phones, assembled from the stored
 * record; the kit's Sheet since S41. It keeps focus inside and closes on Escape; focus returns
 * to the Why? button.
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
  /** The Why? button: focus goes back there on close (no trigger restores it). */
  returnFocus: () => HTMLElement | null;
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={proposed ? 'Why I suggested this' : 'Why I did this'}
      returnFocus={returnFocus}
    >
      <WhyContent
        why={why}
        autonomyLink={{ label: 'Change it in Autonomy', href: ROUTES.autonomy }}
        renderLink={(link) => (
          <Link href={link.href} className="font-semibold text-brand underline underline-offset-2">
            {link.label}
          </Link>
        )}
      />
    </Sheet>
  );
}

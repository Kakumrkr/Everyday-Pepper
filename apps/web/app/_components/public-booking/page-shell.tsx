import type { PublicBusiness } from '@pepper/contracts';
import { brandStyle, brandTokens } from '@pepper/ui';
import type { ReactNode } from 'react';
import { initials } from '../../../lib/public-booking';

/**
 * The public pages' frame in the business's own color (PCR-001): its name on top, and Pepper
 * only in the small print. `.bookpage` maps the brand tokens onto the business's, so every kit
 * part inside wears its color. The bottom padding keeps the footer clear of a sticky action bar;
 * `min-w-0` keeps the day strip's width from widening the page past the phone.
 */
export function BookingPageShell({
  business,
  children,
}: {
  business: Pick<PublicBusiness, 'name' | 'brandColor'>;
  children: ReactNode;
}) {
  return (
    <main
      className="bookpage mx-auto flex w-full min-w-0 max-w-lg flex-col gap-6 px-5 pt-6 pb-28"
      style={brandStyle(brandTokens(business.brandColor))}
    >
      <header className="flex items-center gap-3">
        {/* A business's first two words ("Juniper Hair" → JH), where the kit's Avatar takes a
            person's first and last. */}
        <span
          aria-hidden="true"
          className="inline-flex size-14 shrink-0 items-center justify-center rounded-pill bg-brand-soft type-heading text-brand"
        >
          {initials(business.name)}
        </span>
        <p className="m-0 min-w-0 truncate type-title text-ink">{business.name}</p>
      </header>
      {children}
      <p className="m-0 border-t border-line pt-4 text-center type-caption text-ink-2">
        Booking by pepper · Your details stay with {business.name}
      </p>
    </main>
  );
}

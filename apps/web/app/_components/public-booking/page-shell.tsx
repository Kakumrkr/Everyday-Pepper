import type { PublicBusiness } from '@pepper/contracts';
import { brandStyle, brandTokens } from '@pepper/ui';
import type { ReactNode } from 'react';
import { initials } from '../../../lib/public-booking';

/**
 * The public booking page's frame in the business's own color (PCR-001): its name on top,
 * and Pepper only in the small print. `.bookpage` maps the brand tokens onto the business's.
 */
export function BookingPageShell({
  business,
  children,
}: {
  business: Pick<PublicBusiness, 'name' | 'brandColor'>;
  children: ReactNode;
}) {
  return (
    <main className="bookpage grid gap-5" style={brandStyle(brandTokens(business.brandColor))}>
      <header className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid size-11 shrink-0 place-items-center rounded-full bg-brand-soft font-bold text-brand"
        >
          {initials(business.name)}
        </span>
        <p className="m-0 min-w-0 truncate font-display text-lg font-bold">{business.name}</p>
      </header>
      {children}
      <p className="m-0 text-center text-xs text-ink-2">
        Booking by pepper · Your details stay with {business.name}
      </p>
    </main>
  );
}

import { PRIVACY_PATH, TERMS_PATH, type PublicBusiness } from '@pepper/contracts';
import { brandStyle, brandTokens, FOCUS_RING } from '@pepper/ui';
import type { ReactNode } from 'react';
import { formatPhone } from '../../../lib/booking-profile';
import { photoAlt, photoSrc, photoSrcSet } from '../../../lib/photos';
import { initials } from '../../../lib/public-booking';
import { PhotoImage } from '../photo-image';

/**
 * The public pages' frame in the business's own color (PCR-001): its name on top, and Pepper
 * only in the small print. `.bookpage` maps the brand tokens onto the business's, so every kit
 * part inside wears its color. The bottom padding keeps the footer clear of a sticky action bar;
 * `min-w-0` keeps the day strip's width from widening the page past the phone. Under the name,
 * the phone (a call link) and the address the business chose to show (S47, AC-W8-7). Since
 * S47.2 its cover photo across the top and its logo in place of the initials (AC-W8-12).
 */
export function BookingPageShell({
  business,
  children,
}: {
  business: Pick<
    PublicBusiness,
    'name' | 'slug' | 'brandColor' | 'phone' | 'publicAddress' | 'photos'
  >;
  children: ReactNode;
}) {
  const { cover, logo } = business.photos;
  return (
    <main
      className="bookpage mx-auto flex w-full min-w-0 max-w-lg flex-col gap-6 px-5 pt-6 pb-28"
      style={brandStyle(brandTokens(business.brandColor))}
    >
      {cover === null ? null : (
        <PhotoImage
          src={photoSrc(business.slug, cover, 640)}
          srcSet={photoSrcSet(business.slug, cover)}
          sizes="(min-width: 32rem) 32rem, 100vw"
          alt={photoAlt(cover, 'cover', business.name)}
          width={cover.width}
          height={cover.height}
          // The first thing a client sees: not lazy.
          loading="eager"
          fetchPriority="high"
          className="aspect-[16/9] w-full rounded-lg bg-surface-2 object-cover"
          data-testid="business-cover"
        />
      )}
      <header className="flex items-center gap-3">
        {logo === null ? (
          // A business's first two words ("Juniper Hair" → JH), where the kit's Avatar takes a
          // person's first and last.
          <span
            aria-hidden="true"
            className="inline-flex size-14 shrink-0 items-center justify-center self-start rounded-pill bg-brand-soft type-heading text-brand"
          >
            {initials(business.name)}
          </span>
        ) : (
          <PhotoImage
            src={photoSrc(business.slug, logo, 128)}
            srcSet={photoSrcSet(business.slug, logo)}
            sizes="3.5rem"
            alt={photoAlt(logo, 'logo', business.name)}
            width={logo.width}
            height={logo.height}
            loading="eager"
            className="size-14 shrink-0 self-start rounded-pill border border-line bg-surface-2 object-cover"
            data-testid="business-logo"
          />
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="m-0 min-w-0 truncate type-title text-ink">{business.name}</p>
          {business.phone === null && business.publicAddress === null ? null : (
            <address
              aria-label={`Contact ${business.name}`}
              className="flex flex-col not-italic type-caption text-ink-2"
              data-testid="business-contact"
            >
              {business.phone === null ? null : (
                <a
                  href={`tel:${business.phone}`}
                  className={`self-start font-semibold text-brand tabular-nums ${FOCUS_RING}`}
                >
                  {formatPhone(business.phone)}
                </a>
              )}
              {business.publicAddress === null ? null : (
                <span className="whitespace-pre-line">{business.publicAddress}</span>
              )}
            </address>
          )}
        </div>
      </header>
      {children}
      <p className="m-0 border-t border-line pt-4 text-center type-caption text-ink-2">
        Booking by pepper · Your details stay with {business.name} ·{' '}
        <a href={PRIVACY_PATH} className={`text-ink-2 underline underline-offset-2 ${FOCUS_RING}`}>
          Privacy
        </a>{' '}
        ·{' '}
        <a href={TERMS_PATH} className={`text-ink-2 underline underline-offset-2 ${FOCUS_RING}`}>
          Terms
        </a>
      </p>
    </main>
  );
}

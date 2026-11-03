import type { SetupReview, SetupSuggestion, SetupWarning } from '@pepper/contracts';
import { formatMoney } from '@pepper/ui';
import { ROUTES } from './account';
import { localTimeLabel } from './public-booking';
import { hoursSummary } from './setup';

// Home's setup review in words (S46, PCR-009, AC-W1-11/12). Pure: the card renders it.

export interface SetupRow {
  key: string;
  title: string;
  meta: string;
  href?: string | undefined;
}

export interface SetupFix {
  key: string;
  text: string;
  action: { label: string; href: string };
}

const count = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

/** `$30–$55`, `$30`, or `null` without prices. */
function priceRange(review: SetupReview): string | null {
  const { lowestPriceCents: low, highestPriceCents: high } = review.services;
  if (low === null || high === null) return null;
  return low === high ? formatMoney(low) : `${formatMoney(low)}–${formatMoney(high)}`;
}

/**
 * The one look summary (the S45 retro's top-up): "8 services, Tue–Sat 9:00 AM–6:00 PM" when one
 * person is bookable, else how many are.
 */
export function setupSummary(review: SetupReview): string {
  const services = count(review.services.count, 'service', 'services');
  // Only people who can be booked for something: hours and at least one service.
  const withHours = review.providers.filter(
    (p) => p.hours.intervals.length > 0 && p.serviceCount > 0,
  );
  const only = withHours.length === 1 ? withHours[0] : undefined;
  if (only !== undefined) return `${services}, ${hoursSummary(only.hours).join(', ')}`;
  return `${services}, ${count(withHours.length, 'person', 'people')} with hours`;
}

/** What the review shows, each with where to change it. */
export function setupRows(review: SetupReview): SetupRow[] {
  const prices = priceRange(review);
  const rows: SetupRow[] = [
    {
      key: 'menu',
      title: 'Menu and prices',
      meta: [count(review.services.count, 'service', 'services'), prices]
        .filter((part) => part !== null)
        .join(' · '),
      href: ROUTES.services,
    },
  ];
  for (const provider of review.providers) {
    const hours = hoursSummary(provider.hours);
    rows.push({
      key: provider.id,
      title: provider.isYou ? `${provider.displayName} (you)` : provider.displayName,
      meta: [
        hours.length === 0 ? 'No hours yet' : hours.join(', '),
        count(provider.serviceCount, 'service', 'services'),
      ].join(' · '),
      href: `${ROUTES.team}/${provider.id}`,
    });
  }
  // Set when the business was created; shown so the owner can tell us if it is wrong.
  rows.push({ key: 'zone', title: 'Time zone', meta: localTimeLabel(review.timeZone) });
  return rows;
}

/** A warning in words, with the screen that fixes it. */
export function setupFix(warning: SetupWarning): SetupFix {
  switch (warning.kind) {
    case 'no_services':
      return {
        key: 'no_services',
        text: 'Your menu is empty, so clients have nothing to book.',
        action: { label: 'Add a service', href: ROUTES.services },
      };
    case 'staff_without_hours':
      return {
        key: `hours-${warning.staffMemberId}`,
        text: `${warning.displayName} has no working hours, so clients can’t book them.`,
        action: { label: 'Set their hours', href: `${ROUTES.team}/${warning.staffMemberId}` },
      };
    case 'service_without_provider':
      return {
        key: `service-${warning.serviceId}`,
        text: `No one with hours offers ${warning.name}, so it isn’t on your booking page.`,
        action: { label: 'Choose who offers it', href: ROUTES.team },
      };
  }
}

/** Each suggestion in words, with where to act on it (S47.3, AC-W1-16). */
const TIPS: Record<SetupSuggestion['kind'], SetupFix> = {
  add_photos: {
    key: 'add_photos',
    text: 'Your booking page has no photos yet. A cover and your work help clients choose you.',
    action: { label: 'Add photos', href: `${ROUTES.services}#photos` },
  },
};

/** A suggestion in words, with where to act on it. */
export function setupTip(suggestion: SetupSuggestion): SetupFix {
  return TIPS[suggestion.kind];
}

/**
 * The booking page's last 7 days in one line (S47.2, AC-W1-14): "12 visits, 7 booked this
 * week", or what to do when nobody came yet.
 */
export function bookingWeekLine(week: SetupReview['week']): string {
  if (week.visits === 0 && week.booked === 0) {
    return 'No visits yet this week. Share your link to get your first booking.';
  }
  const visits = `${String(week.visits)} ${week.visits === 1 ? 'visit' : 'visits'}`;
  return `${visits}, ${String(week.booked)} booked this week`;
}

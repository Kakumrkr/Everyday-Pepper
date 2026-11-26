import type { FeedItem } from '@pepper/contracts';

// The dollars at stake on a Home card (S52, ADR-0043): an estimate from the business's own
// service prices, never a promise. Open time is worth the business's average price per minute
// of its active priced services; a regular who is due, their service's price; a client likely
// to miss, their booking's price. A busy week, and anything the business has no price for,
// is `null`: Home ranks those after the priced ones.

/** A service as the estimate needs it. */
export interface PricedService {
  id: string;
  durationMinutes: number;
  priceFromCents: number | null;
  active: boolean;
}

export interface FeedPrices {
  services: readonly PricedService[];
  /** A booking's "from" price by id (`null`: the booking has none). */
  bookingPrices: ReadonlyMap<string, number | null>;
}

/**
 * Cents per minute across the active services that have a price: total price over total
 * length, so a long cheap service doesn't count as much as its price alone. `null` without one.
 */
export function pricePerMinute(services: readonly PricedService[]): number | null {
  let cents = 0;
  let minutes = 0;
  for (const service of services) {
    if (!service.active || service.priceFromCents === null || service.durationMinutes <= 0) {
      continue;
    }
    cents += service.priceFromCents;
    minutes += service.durationMinutes;
  }
  return minutes === 0 ? null : cents / minutes;
}

const MINUTE_MS = 60_000;

/** The item's dollars at stake in whole cents, or `null` when there is nothing to price. */
export function feedValueCents(
  item: FeedItem,
  prices: FeedPrices,
  rate: number | null,
): number | null {
  const atRate = (minutes: number) => (rate === null ? null : Math.round(minutes * rate));
  switch (item.kind) {
    case 'schedule_gaps':
      return atRate(item.payload.openMinutes);
    case 'waitlist_match': {
      // Once a client claimed it, nothing is at stake any more.
      if (item.payload.state === 'claimed') return null;
      const minutes =
        (Date.parse(item.payload.endsAt) - Date.parse(item.payload.startsAt)) / MINUTE_MS;
      return minutes > 0 ? atRate(minutes) : null;
    }
    case 'rebooking_due': {
      const id = item.subjects.serviceId;
      const service = id === null ? undefined : prices.services.find((s) => s.id === id);
      return service?.priceFromCents ?? null;
    }
    case 'no_show_pattern': {
      const id = item.subjects.bookingId;
      return id === null ? null : (prices.bookingPrices.get(id) ?? null);
    }
    case 'staff_overload':
    case 'daily_briefing':
    case 'calendar_kept':
      return null;
  }
}

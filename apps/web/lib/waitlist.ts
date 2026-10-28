import type { WaitlistEntry, WaitlistOffer, WaitlistWindow } from '@pepper/contracts';
import type { BadgeTone } from '@pepper/ui';
import { dateTimeLabel } from './booking';

// The waitlist screen (S37): pure helpers. The api decides who sees what (staff their own
// staff member's entries and offers); these only shape the words.

export const OFFER_STATUS_LABELS: Record<WaitlistOffer['status'], string> = {
  offered: 'Waiting for an answer',
  claimed: 'Booked',
  taken: 'Someone else took it',
  expired: 'Expired',
};

export const ENTRY_STATUS_LABELS: Record<WaitlistEntry['status'], string> = {
  waiting: 'Waiting',
  offered: 'Offered a time',
  booked: 'Booked',
  expired: 'Expired',
  cancelled: 'Removed',
};

/** Each status's badge: done green, waiting for someone amber, the rest neutral. */
export const OFFER_STATUS_TONES: Record<WaitlistOffer['status'], BadgeTone> = {
  offered: 'warn',
  claimed: 'ok',
  taken: 'neutral',
  expired: 'neutral',
};

export const ENTRY_STATUS_TONES: Record<WaitlistEntry['status'], BadgeTone> = {
  waiting: 'neutral',
  offered: 'warn',
  booked: 'ok',
  expired: 'neutral',
  cancelled: 'neutral',
};

/** "Sat, Nov 7, 9:00 AM – 12:00 PM": one window in words (local wall-clock times). */
export function windowLabel(window: WaitlistWindow): string {
  const [y = 0, m = 1, d = 1] = window.date.split('-').map(Number);
  const day = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
  return `${day}, ${clock(window.start)} – ${clock(window.end)}`;
}

/** "09:30" → "9:30 AM"; "24:00" → "midnight". */
function clock(time: string): string {
  if (time === '24:00') return 'midnight';
  const [h = 0, min = 0] = time.split(':').map(Number);
  const suffix = h < 12 ? 'AM' : 'PM';
  return `${String(h % 12 === 0 ? 12 : h % 12)}:${String(min).padStart(2, '0')} ${suffix}`;
}

/** The offers grouped by the freed time they were for, newest first. */
export function offersBySlot(
  offers: readonly WaitlistOffer[],
  timeZone: string,
): { key: string; label: string; staffMemberId: string; offers: WaitlistOffer[] }[] {
  const groups = new Map<
    string,
    { key: string; label: string; staffMemberId: string; offers: WaitlistOffer[] }
  >();
  for (const offer of offers) {
    const key = `${offer.staffMemberId}:${offer.startsAt}`;
    const group = groups.get(key) ?? {
      key,
      label: dateTimeLabel(timeZone, offer.startsAt),
      staffMemberId: offer.staffMemberId,
      offers: [],
    };
    group.offers.push(offer);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    offers: [...group.offers].sort((a, b) => a.rank - b.rank),
  }));
}

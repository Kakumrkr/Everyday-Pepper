import type { WaitlistOffer } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { OFFER_STATUS_LABELS, offersBySlot, windowLabel } from './waitlist';

const offer = (rank: number, startsAt: string, status: WaitlistOffer['status'] = 'offered') =>
  ({
    id: `0199f0a4-7c1e-7d2a-9b3c-4d5e6f70810${String(rank)}`,
    entryId: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708110',
    clientId: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708120',
    staffMemberId: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708130',
    startsAt,
    status,
    expiresAt: '2026-11-03T14:00:00.000Z',
    rank,
    createdAt: '2026-11-02T12:00:00.000Z',
  }) as WaitlistOffer;

describe('the waitlist screen (S37)', () => {
  it('says a window in local words', () => {
    expect(windowLabel({ date: '2026-11-07', start: '09:00', end: '12:00' })).toBe(
      'Sat, Nov 7, 9:00 AM – 12:00 PM',
    );
    expect(windowLabel({ date: '2026-11-07', start: '18:30', end: '24:00' })).toBe(
      'Sat, Nov 7, 6:30 PM – midnight',
    );
  });

  it('groups offers by the freed time, best match first', () => {
    const groups = offersBySlot(
      [
        offer(2, '2026-11-03T20:00:00.000Z', 'taken'),
        offer(1, '2026-11-03T20:00:00.000Z', 'claimed'),
        offer(1, '2026-11-04T15:00:00.000Z'),
      ],
      'America/New_York',
    );
    expect(groups.map((g) => g.offers.map((o) => [o.rank, OFFER_STATUS_LABELS[o.status]]))).toEqual(
      [
        [
          [1, 'Booked'],
          [2, 'Someone else took it'],
        ],
        [[1, 'Waiting for an answer']],
      ],
    );
  });
});

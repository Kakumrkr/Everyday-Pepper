import { describe, expect, it } from 'vitest';
import {
  FeedInsightKindSchema,
  FeedItemSchema,
  FeedSettingsChangeSchema,
  FeedSettingsSchema,
} from './feed.js';
import { InsightTypeSchema } from './templates.js';

const ID = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700001';
const STAFF = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700002';

const item = {
  id: ID.toUpperCase(),
  status: 'suggestion',
  day: '2026-11-02',
  subjects: { staffMemberId: STAFF, clientId: null, bookingId: null, serviceId: null },
  names: { staff: 'Jess', client: null, service: null },
  proposalId: null,
  expiresAt: '2026-11-02T22:00:00.000Z',
  createdAt: '2026-11-02T13:00:00.000Z',
  kind: 'schedule_gaps',
  payload: {
    gapCount: 2,
    openMinutes: 360,
    longestStartsAt: '2026-11-02T18:00:00.000Z',
    longestEndsAt: '2026-11-02T22:00:00.000Z',
  },
};

describe('feed kinds', () => {
  it('adds staff_overload to the insight types and writes four kinds in S35', () => {
    expect(InsightTypeSchema.options).toContain('staff_overload');
    expect(FeedInsightKindSchema.options).toEqual([
      'schedule_gaps',
      'rebooking_due',
      'no_show_pattern',
      'staff_overload',
    ]);
  });
});

describe('FeedItemSchema', () => {
  it('parses an item and lowercases its id', () => {
    expect(FeedItemSchema.parse(item)).toMatchObject({ id: ID, kind: 'schedule_gaps' });
  });

  it('checks the payload against its kind', () => {
    expect(FeedItemSchema.safeParse({ ...item, kind: 'rebooking_due' }).success).toBe(false);
    expect(
      FeedItemSchema.safeParse({ ...item, payload: { ...item.payload, extra: 'text' } }).success,
    ).toBe(false);
    expect(
      FeedItemSchema.safeParse({
        ...item,
        kind: 'staff_overload',
        payload: { busyDays: ['2026-11-02'], horizonDays: 7, peakPercent: 101 },
      }).success,
    ).toBe(false);
  });
});

describe('FeedSettings', () => {
  it('accepts either switch and the once-only answer', () => {
    expect(FeedSettingsSchema.parse({ suggestionsPaused: true, disabledKinds: [] })).toEqual({
      suggestionsPaused: true,
      disabledKinds: [],
    });
    expect(FeedSettingsChangeSchema.parse({ askAnswered: 'schedule_gaps' })).toEqual({
      askAnswered: 'schedule_gaps',
    });
  });

  it.each([
    {},
    { disabledKinds: ['schedule_gaps', 'schedule_gaps'] },
    { disabledKinds: ['waitlist_match'] },
    { suggestionsPaused: 'yes' },
    { tenantId: ID },
  ])('rejects %j', (change) => {
    expect(FeedSettingsChangeSchema.safeParse(change).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DailyBriefingPayloadSchema,
  FeedInsightKindSchema,
  FeedItemSchema,
  FeedKindSchema,
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
  it('writes every insight type from the insights pass, the briefing and the calendar note besides (S38a, S71.2)', () => {
    expect(InsightTypeSchema.options).toContain('staff_overload');
    expect(FeedInsightKindSchema.options).toEqual([
      'schedule_gaps',
      'rebooking_due',
      'no_show_pattern',
      'staff_overload',
      'waitlist_match',
    ]);
    expect([...FeedInsightKindSchema.options].sort()).toEqual(
      [...InsightTypeSchema.options].sort(),
    );
    expect(FeedKindSchema.options).toEqual([
      ...FeedInsightKindSchema.options,
      'daily_briefing',
      'calendar_kept',
    ]);
  });
});

const briefing = {
  scope: 'business',
  bookingCount: 8,
  firstStartsAt: '2026-11-02T14:00:00.000Z',
  gapCount: 1,
  openMinutes: 90,
  needsOkCount: 2,
  rebookingDueCount: 3,
  waitlistWaiting: 4,
  waitlistOffered: 1,
  waitlistClaimed: 0,
};

describe('the S38a kinds', () => {
  it('parses a briefing and a waitlist match', () => {
    expect(
      FeedItemSchema.parse({ ...item, kind: 'daily_briefing', payload: briefing }),
    ).toMatchObject({ kind: 'daily_briefing', payload: { bookingCount: 8 } });
    expect(
      FeedItemSchema.parse({
        ...item,
        kind: 'waitlist_match',
        payload: {
          startsAt: '2026-11-02T19:00:00.000Z',
          endsAt: '2026-11-02T20:00:00.000Z',
          state: 'offered',
          offered: 3,
        },
      }),
    ).toMatchObject({ kind: 'waitlist_match' });
  });

  it('holds numbers only: no names or free text in a briefing', () => {
    expect(DailyBriefingPayloadSchema.safeParse({ ...briefing, note: 'Ana at 9' }).success).toBe(
      false,
    );
    expect(DailyBriefingPayloadSchema.safeParse({ ...briefing, bookingCount: -1 }).success).toBe(
      false,
    );
    expect(
      DailyBriefingPayloadSchema.safeParse({ ...briefing, scope: 'staff', needsOkCount: null })
        .success,
    ).toBe(true);
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
    // Settings stored before S38a have no morning hour: the template's.
    expect(FeedSettingsSchema.parse({ suggestionsPaused: true, disabledKinds: [] })).toEqual({
      suggestionsPaused: true,
      disabledKinds: [],
      morningHour: null,
    });
    expect(FeedSettingsChangeSchema.parse({ morningHour: 8 })).toEqual({ morningHour: 8 });
    expect(FeedSettingsChangeSchema.parse({ morningHour: null })).toEqual({ morningHour: null });
    expect(FeedSettingsChangeSchema.parse({ askAnswered: 'schedule_gaps' })).toEqual({
      askAnswered: 'schedule_gaps',
    });
  });

  it.each([
    {},
    { disabledKinds: ['schedule_gaps', 'schedule_gaps'] },
    { disabledKinds: ['daily_briefing'] },
    { morningHour: 4 },
    { morningHour: 12 },
    { morningHour: 7.5 },
    { suggestionsPaused: 'yes' },
    { tenantId: ID },
  ])('rejects %j', (change) => {
    expect(FeedSettingsChangeSchema.safeParse(change).success).toBe(false);
  });
});

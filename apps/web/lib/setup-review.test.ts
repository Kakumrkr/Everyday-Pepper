import { ServiceIdSchema, StaffMemberIdSchema, type SetupReview } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { setupFix, setupRows, setupSummary } from './setup-review';

const TUE_SAT = {
  intervals: [2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '09:00', end: '18:00' })),
};
const ANA = StaffMemberIdSchema.parse('0190c000-0000-7000-8000-0000000000a1');
const BEN = StaffMemberIdSchema.parse('0190c000-0000-7000-8000-0000000000b1');
const COLOR = ServiceIdSchema.parse('0190c000-0000-7000-8000-0000000000c1');

const review = (overrides: Partial<SetupReview> = {}): SetupReview => ({
  reviewedAt: null,
  timeZone: 'America/Chicago',
  services: { count: 8, lowestPriceCents: 2500, highestPriceCents: 6000 },
  providers: [{ id: ANA, displayName: 'Ana', isYou: true, serviceCount: 8, hours: TUE_SAT }],
  warnings: [],
  ...overrides,
});

describe('the setup review in words (S46, AC-W1-11)', () => {
  it('sums up what the business type filled in, in one look', () => {
    expect(setupSummary(review())).toBe('8 services, Tue–Sat 9:00 AM–6:00 PM');
  });

  it('counts the people with hours when there are several', () => {
    const ben = { id: BEN, displayName: 'Ben', isYou: false, serviceCount: 1, hours: TUE_SAT };
    expect(setupSummary(review({ providers: [...review().providers, ben] }))).toBe(
      '8 services, 2 people with hours',
    );
  });

  it('leaves out of the summary someone who offers nothing', () => {
    const owner = { id: ANA, displayName: 'Ana', isYou: true, serviceCount: 0, hours: TUE_SAT };
    expect(setupSummary(review({ providers: [owner] }))).toBe('8 services, 0 people with hours');
  });

  it('lists the menu, each person with their hours and the time zone, with where to edit', () => {
    expect(setupRows(review())).toEqual([
      { key: 'menu', title: 'Menu and prices', meta: '8 services · $25–$60', href: '/services' },
      {
        key: ANA,
        title: 'Ana (you)',
        meta: 'Tue–Sat 9:00 AM–6:00 PM · 8 services',
        href: `/team/${ANA}`,
      },
      { key: 'zone', title: 'Time zone', meta: 'Central Time' },
    ]);
  });

  it('says plainly when there are no prices or no hours', () => {
    const rows = setupRows(
      review({
        services: { count: 1, lowestPriceCents: null, highestPriceCents: null },
        providers: [
          { id: BEN, displayName: 'Ben', isYou: false, serviceCount: 1, hours: { intervals: [] } },
        ],
      }),
    );
    expect(rows.map((row) => row.meta)).toEqual([
      '1 service',
      'No hours yet · 1 service',
      'Central Time',
    ]);
  });

  it('puts each warning in words with the screen that fixes it (AC-W1-12)', () => {
    expect(setupFix({ kind: 'no_services' }).action.href).toBe('/services');
    expect(
      setupFix({ kind: 'staff_without_hours', staffMemberId: BEN, displayName: 'Ben' }),
    ).toEqual({
      key: `hours-${BEN}`,
      text: 'Ben has no working hours, so clients can’t book them.',
      action: { label: 'Set their hours', href: `/team/${BEN}` },
    });
    expect(
      setupFix({ kind: 'service_without_provider', serviceId: COLOR, name: 'Color' }).text,
    ).toBe('No one with hours offers Color, so it isn’t on your booking page.');
  });
});

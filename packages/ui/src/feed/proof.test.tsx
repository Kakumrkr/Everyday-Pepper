// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import {
  EveningWrapSchema,
  WeekValueSchema,
  type EveningWrap as Wrap,
  type WeekValue,
} from '@pepper/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { EveningWrap, WeekProof, eveningLines, weekHasProof, weekLines } from './proof.js';

// Proof of value on Home (S55, AC-W4-10…13): the words from the numbers, zeros left out.

afterEach(cleanup);

const NY = 'America/New_York';
const week = (overrides: Partial<WeekValue> = {}) =>
  WeekValueSchema.parse({
    from: '2026-10-29T15:00:00.000Z',
    to: '2026-11-05T15:00:00.000Z',
    visitsBooked: 9,
    gapsFilled: 2,
    regularsBack: 3,
    regularsBackCents: 16_500,
    valueCents: 54_000,
    minutesSaved: 127,
    ...overrides,
  });
const wrap = (overrides: Partial<Wrap> = {}) =>
  EveningWrapSchema.parse({
    day: '2026-11-06',
    visitCount: 7,
    firstStartsAt: '2026-11-06T14:00:00.000Z',
    atRiskCount: 1,
    atRisk: [
      {
        bookingId: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700031',
        clientName: 'Sam Diaz',
        startsAt: '2026-11-06T16:00:00.000Z',
        noShowCount: 2,
      },
    ],
    ...overrides,
  });

describe('weekLines', () => {
  it('says each number once, with the dollars, and the time to 5 minutes', () => {
    expect(weekLines(week())).toEqual({
      title: 'What I did this week',
      rows: [
        { key: 'visits', title: '9 visits booked through me', cents: 54_000 },
        { key: 'gaps', title: '2 freed times filled', cents: null },
        { key: 'regulars', title: '3 regulars back after my email', cents: 16_500 },
      ],
      saved: 'About 2 h 5 min of your time saved.',
    });
  });

  it('leaves the zeros out and speaks of one in the singular', () => {
    expect(
      weekLines(
        week({
          visitsBooked: 1,
          gapsFilled: 0,
          regularsBack: 0,
          regularsBackCents: 0,
          valueCents: 0,
          minutesSaved: 2,
        }),
      ),
    ).toEqual({
      title: 'What I did this week',
      rows: [{ key: 'visits', title: '1 visit booked through me', cents: null }],
      saved: null,
    });
  });

  it('a week where I did nothing has no card', () => {
    const quiet = week({
      visitsBooked: 0,
      gapsFilled: 0,
      regularsBack: 0,
      regularsBackCents: 0,
      valueCents: 0,
      minutesSaved: 0,
    });
    expect(weekHasProof(quiet)).toBe(false);
    const { container } = render(<WeekProof week={quiet} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('WeekProof', () => {
  it('shows the rows with their money, accessibly', async () => {
    const { container } = render(<WeekProof week={week()} />);
    const card = screen.getByRole('region', { name: 'What I did this week' });
    expect(within(card).getByText('9 visits booked through me')).toBeTruthy();
    expect(within(card).getByText('adds $540')).toBeTruthy();
    expect(within(card).getByText('About 2 h 5 min of your time saved.')).toBeTruthy();
    expect((await axe.run(container)).violations).toEqual([]);
  });
});

describe('eveningLines', () => {
  it("counts tomorrow from the first time, in the business's zone, and names who is at risk", () => {
    expect(eveningLines(wrap(), NY)).toEqual({
      title: 'Tomorrow: 7 visits, the first at 9:00 am',
      atRisk: [
        {
          key: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700031',
          title: 'Sam Diaz',
          meta: '11:00 am · missed 2 visits in 6 months',
        },
      ],
      more: null,
    });
  });

  it('says how many more are at risk than it names', () => {
    expect(eveningLines(wrap({ atRiskCount: 4 }), NY).more).toBe('And 3 more visits at risk.');
  });

  it('says when nothing is booked yet', () => {
    expect(
      eveningLines(wrap({ visitCount: 0, firstStartsAt: null, atRiskCount: 0, atRisk: [] }), NY)
        .title,
    ).toBe('Tomorrow: nothing booked yet');
  });
});

describe('EveningWrap', () => {
  it('is not there before the evening', () => {
    const { container } = render(<EveningWrap evening={null} timeZone={NY} />);
    expect(container.innerHTML).toBe('');
  });

  it('lists the visits at risk, accessibly', async () => {
    const { container } = render(<EveningWrap evening={wrap()} timeZone={NY} />);
    const region = screen.getByRole('region', { name: /Tomorrow: 7 visits/ });
    expect(within(region).getByText('1 visit at risk of a no-show.')).toBeTruthy();
    expect(
      within(within(region).getByRole('list', { name: 'Visits at risk' })).getByText('Sam Diaz'),
    ).toBeTruthy();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('says nobody is at risk when nobody is', () => {
    render(<EveningWrap evening={wrap({ atRiskCount: 0, atRisk: [] })} timeZone={NY} />);
    expect(screen.getByText('Nobody booked has missed visits lately.')).toBeTruthy();
  });
});

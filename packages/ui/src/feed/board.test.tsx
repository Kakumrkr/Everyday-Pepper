// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { FeedItemSchema, type FeedSettings } from '@pepper/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boardOf, groupLine, namesList, roughDuration, type BoardItem } from './board.js';
import { FeedSuggestions, type FeedSuggestionsProps } from './feed-suggestions.js';

afterEach(cleanup);

// Home's card board (S52, ADR-0043): the feed-noise case (one gap card per day for a staff
// member open all week) as one card, regulars who are due as one, ranked by dollars.

const RANDY = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700001';
const DRE = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700002';
let next = 0;
const id = () => `0199f0a4-7c1e-7d2a-9b3c-4d5e6f7${String(++next).padStart(5, '0')}`;
const base = {
  status: 'suggestion',
  proposalId: null,
  expiresAt: '2026-11-30T05:00:00.000Z',
  createdAt: '2026-11-02T13:00:00.000Z',
};
const noSubjects = { staffMemberId: null, clientId: null, bookingId: null, serviceId: null };

function gap(
  staff: string,
  name: string,
  day: string,
  minutes: number,
  valueCents: number | null,
): BoardItem {
  return {
    ...FeedItemSchema.parse({
      ...base,
      id: id(),
      day,
      kind: 'schedule_gaps',
      payload: {
        gapCount: 1,
        openMinutes: minutes,
        longestStartsAt: `${day}T15:00:00.000Z`,
        longestEndsAt: `${day}T17:00:00.000Z`,
      },
      subjects: { ...noSubjects, staffMemberId: staff },
      names: { staff: name, client: null, service: null },
    }),
    valueCents,
  };
}

function due(client: string, valueCents: number | null): BoardItem {
  return {
    ...FeedItemSchema.parse({
      ...base,
      id: id(),
      day: '2026-10-27',
      kind: 'rebooking_due',
      payload: {
        lastVisitAt: '2026-09-01T14:00:00.000Z',
        intervalDays: 28,
        basis: 'service',
        dueOn: '2026-10-13',
      },
      subjects: { ...noSubjects, clientId: id() },
      names: { staff: null, client, service: 'Skin fade' },
    }),
    valueCents,
  };
}

const overload: BoardItem = {
  ...FeedItemSchema.parse({
    ...base,
    id: id(),
    day: '2026-11-04',
    kind: 'staff_overload',
    payload: { busyDays: ['2026-11-04'], horizonDays: 7, peakPercent: 100 },
    subjects: { ...noSubjects, staffMemberId: DRE },
    names: { staff: 'Dre', client: null, service: null },
  }),
  valueCents: null,
};

// Randy open five days of the week (newest first, as the api sends them), Dre one day.
const RANDY_WEEK = ['2026-11-07', '2026-11-03', '2026-11-05', '2026-11-04', '2026-11-06'].map(
  (day) => gap(RANDY, 'Randy', day, 180, 27000),
);
const DRE_DAY = gap(DRE, 'Dre', '2026-11-03', 60, 9000);
const REGULARS = [due('Maria Lopez', 4500), due('Lee Park', 9000), due('Sam Ortiz', null)];

describe('boardOf (AC-W4-3, AC-W4-4)', () => {
  it("makes a staff member's open week one card, regulars one card, ranked by dollars", () => {
    const board = boardOf([overload, ...RANDY_WEEK, DRE_DAY, ...REGULARS]);
    expect(board.map((card) => [card.type, card.valueCents])).toEqual([
      ['group', 135000],
      ['group', 13500],
      ['single', 9000],
      ['single', null],
    ]);
    const [week, regulars] = board;
    if (week?.type !== 'group' || regulars?.type !== 'group') throw new Error('groups expected');
    // Days in order; regulars by value, the unpriced last.
    expect(week.items.map((item) => item.day)).toEqual([
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
    ]);
    expect(regulars.items.map((item) => item.names.client)).toEqual([
      'Lee Park',
      'Maria Lopez',
      'Sam Ortiz',
    ]);
    expect(groupLine(week).title).toBe('Randy has 15 h open on 5 of the next 7 days');
    expect(groupLine(regulars)).toEqual({
      title: '3 regulars are due back',
      why: 'Lee Park, Maria Lopez and Sam Ortiz. Each is past their usual time, with nothing booked yet.',
    });
  });

  it('keeps one of a kind as its own card, and unpriced cards in the order they came', () => {
    const [lee] = REGULARS;
    if (lee === undefined) throw new Error('no regular');
    const board = boardOf([overload, lee, { ...DRE_DAY, valueCents: null }]);
    expect(board.map((card) => (card.type === 'single' ? card.item.kind : card.kind))).toEqual([
      'rebooking_due',
      'staff_overload',
      'schedule_gaps',
    ]);
    // Items the api didn't price (older shapes) rank as unpriced.
    const unpriced: BoardItem = { ...DRE_DAY };
    delete unpriced.valueCents;
    expect(boardOf([unpriced, overload]).map((card) => card.valueCents)).toEqual([null, null]);
  });

  it('rounds a long week to whole hours', () => {
    expect([135, 599, 600, 3677].map(roughDuration)).toEqual([
      '2 h 15 min',
      '9 h 59 min',
      '10 h',
      '61 h',
    ]);
  });

  it('lists names in words', () => {
    expect(namesList(['A'])).toBe('A');
    expect(namesList(['A', 'B'])).toBe('A and B');
    expect(namesList(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C and 2 more');
  });
});

const OPEN: FeedSettings = { suggestionsPaused: false, disabledKinds: [], morningHour: null };

function setup(
  items: readonly BoardItem[],
  extra: Pick<Partial<FeedSuggestionsProps>, 'quiet' | 'onCloseMany'> = {},
) {
  const onClose = vi.fn(() => Promise.resolve<string | null>(null));
  const view = render(
    <FeedSuggestions
      items={items}
      settings={OPEN}
      canChangeSettings
      askToTurnOff={null}
      timeZone="America/New_York"
      now={Date.parse('2026-11-02T15:00:00.000Z')}
      actionFor={(item) =>
        item.kind === 'schedule_gaps'
          ? { label: 'Show on calendar', href: `/calendar?date=${item.day}` }
          : { label: 'Open', href: `/clients/${item.subjects.clientId ?? ''}` }
      }
      renderAction={(action) => <a href={action.href}>{action.label}</a>}
      onClose={onClose}
      onSettings={() => Promise.resolve(null)}
      quietAction={<a href="/calendar">Open your calendar</a>}
      {...extra}
    />,
  );
  return { ...view, onClose };
}

describe('the grouped card (AC-W4-3)', () => {
  it('shows the week as one card with its estimate and each day as a row, accessibly', async () => {
    const { container } = setup([...RANDY_WEEK, DRE_DAY]);
    const cards = screen.getAllByTestId('feed-suggestion');
    expect(cards).toHaveLength(2);
    const week = screen.getByRole('article', {
      name: 'Randy has 15 h open on 5 of the next 7 days',
    });
    expect(within(week).getByText('about $1,350')).toBeTruthy();
    const rows = within(week).getAllByRole('link');
    expect(rows.map((row) => row.getAttribute('href'))).toEqual(
      ['03', '04', '05', '06', '07'].map((day) => `/calendar?date=2026-11-${day}`),
    );
    expect(rows[0]?.textContent).toContain('Tue, Nov 3 · 3 h');
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });

  it('dismisses every day with "Dismiss all", and following a row marks it done', async () => {
    const { onClose } = setup([...RANDY_WEEK, ...REGULARS]);
    const regulars = screen.getByRole('article', { name: '3 regulars are due back' });
    const [firstRow] = within(regulars).getAllByRole('link');
    if (firstRow === undefined) throw new Error('no row');
    firstRow.addEventListener('click', (event) => {
      event.preventDefault();
    });
    await userEvent.click(firstRow);
    expect(onClose).toHaveBeenCalledWith(REGULARS[1]?.id, 'done');

    const week = screen.getByRole('article', {
      name: 'Randy has 15 h open on 5 of the next 7 days',
    });
    await userEvent.click(within(week).getByRole('button', { name: 'Dismiss all' }));
    for (const item of RANDY_WEEK) expect(onClose).toHaveBeenCalledWith(item.id, 'dismissed');
    await vi.waitFor(() => {
      expect(screen.queryByRole('article', { name: /Randy/ })).toBeNull();
    });
    expect(screen.getByRole('status').textContent).toBe(
      "Snoozed for 30 days. I won't suggest these open gaps again until then.",
    );
  });

  it('closes the whole card in one call when it can, so it counts as one dismissal', async () => {
    const onCloseMany = vi.fn(() => Promise.resolve<string | null>(null));
    const { onClose } = setup(RANDY_WEEK, { onCloseMany });
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss all' }));
    // In the card's order: by day.
    expect(onCloseMany).toHaveBeenCalledExactlyOnceWith(
      [...RANDY_WEEK].sort((a, b) => a.day.localeCompare(b.day)).map((item) => item.id),
      'dismissed',
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId('feed-suggestion')).toBeNull();

    cleanup();
    setup(RANDY_WEEK, { onCloseMany: () => Promise.resolve('That card is no longer open') });
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss all' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That card is no longer open');
    expect(screen.getAllByTestId('feed-suggestion')).toHaveLength(1);
  });

  it('stays quiet before the first booking, with how to start (AC-W4-5)', () => {
    setup([], { quiet: true });
    expect(screen.getByTestId('feed-quiet').textContent).toContain('Quiet for now.');
    expect(screen.getByRole('link', { name: 'Open your calendar' })).toBeTruthy();
    expect(screen.queryByText('All clear.')).toBeNull();
  });

  it('shows a calendar note in the quiet start, never a suggestion (S71.2, AC-X-176)', () => {
    const kept: BoardItem = {
      ...FeedItemSchema.parse({
        ...base,
        id: id(),
        day: '2026-11-03',
        kind: 'calendar_kept',
        payload: { change: 'moved', startsAt: '2026-11-03T15:00:00.000Z' },
        subjects: { ...noSubjects, staffMemberId: RANDY },
        names: { staff: 'Randy', client: 'Sam', service: 'Haircut' },
      }),
      valueCents: null,
    };
    setup([kept, gap(RANDY, 'Randy', '2026-11-04', 120, 9000)], { quiet: true });
    const cards = screen.getAllByTestId('feed-suggestion');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.textContent).toContain("Sam's Tue, Nov 3, 10:00 am is kept as booked");
    expect(screen.getByTestId('feed-quiet').textContent).toContain('Quiet for now.');
  });
});

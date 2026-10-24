// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { FeedItemSchema, type FeedSettings } from '@pepper/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { feedLine, formatDuration } from './feed-lines.js';
import { FeedSuggestions, type FeedSuggestionsProps } from './feed-suggestions.js';

afterEach(cleanup);

const NY = 'America/New_York';
const NOW = Date.parse('2026-11-02T15:00:00.000Z');
const STAFF = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700001';
const CLIENT = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700011';
const BOOKING = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700031';

const base = {
  status: 'suggestion',
  proposalId: null,
  expiresAt: '2026-11-30T05:00:00.000Z',
  createdAt: '2026-11-02T13:00:00.000Z',
};
const noSubjects = { staffMemberId: null, clientId: null, bookingId: null, serviceId: null };
const noNames = { staff: null, client: null, service: null };

const gap = FeedItemSchema.parse({
  ...base,
  id: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700101',
  day: '2026-11-05',
  kind: 'schedule_gaps',
  payload: {
    gapCount: 1,
    openMinutes: 135,
    longestStartsAt: '2026-11-05T18:30:00.000Z',
    longestEndsAt: '2026-11-05T20:45:00.000Z',
  },
  subjects: { ...noSubjects, staffMemberId: STAFF },
  names: { ...noNames, staff: 'Jess' },
});
const rebooking = FeedItemSchema.parse({
  ...base,
  id: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700102',
  day: '2026-10-27',
  kind: 'rebooking_due',
  payload: {
    lastVisitAt: '2026-09-01T14:00:00.000Z',
    intervalDays: 42,
    basis: 'service',
    dueOn: '2026-10-13',
  },
  subjects: { ...noSubjects, clientId: CLIENT, staffMemberId: STAFF },
  names: { staff: 'Jess', client: 'Maria Lopez', service: 'Color touch-up' },
});
const noShow = FeedItemSchema.parse({
  ...base,
  id: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700103',
  day: '2026-11-06',
  kind: 'no_show_pattern',
  payload: { noShowCount: 2, windowDays: 180, bookingStartsAt: '2026-11-06T15:00:00.000Z' },
  subjects: { ...noSubjects, clientId: CLIENT, bookingId: BOOKING },
  names: noNames,
});
const overload = FeedItemSchema.parse({
  ...base,
  id: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700104',
  day: '2026-11-04',
  kind: 'staff_overload',
  payload: {
    busyDays: ['2026-11-04', '2026-11-05', '2026-11-07'],
    horizonDays: 7,
    peakPercent: 100,
  },
  subjects: { ...noSubjects, staffMemberId: STAFF },
  names: { ...noNames, staff: 'Ana' },
});

describe('feedLine', () => {
  it('says each kind in plain words, in the business’s time zone', () => {
    expect(feedLine(gap, NY, NOW)).toEqual({
      title: 'Jess has 2 h 15 min open on Thu, Nov 5',
      why: "Free 1:30 pm–3:45 pm, inside working hours. It goes away when it's booked or the day ends.",
    });
    expect(feedLine(rebooking, NY, NOW)).toEqual({
      title: 'Maria Lopez is due for Color touch-up',
      why: 'Last visit 9 weeks ago. Color touch-up usually rebooks every 42 days. Nothing is booked yet.',
    });
    expect(feedLine(noShow, NY, NOW).title).toBe(
      'A client missed 2 visits lately and is booked Fri, Nov 6, 10:00 am',
    );
    expect(feedLine(overload, NY, NOW)).toEqual({
      title: 'Ana is 90% booked or more on 3 of the next 7 days',
      why: 'Wed, Nov 4, Thu, Nov 5, Sat, Nov 7. The fullest is 100% booked.',
    });
  });

  it('formats durations', () => {
    expect([45, 60, 135].map(formatDuration)).toEqual(['45 min', '1 h', '2 h 15 min']);
  });
});

const OPEN: FeedSettings = { suggestionsPaused: false, disabledKinds: [] };

function setup(props: Partial<FeedSuggestionsProps> = {}) {
  const onClose = vi.fn(() => Promise.resolve<string | null>(null));
  const onSettings = vi.fn(() => Promise.resolve<string | null>(null));
  const follow = vi.fn();
  const view = render(
    <FeedSuggestions
      items={[gap, rebooking, noShow, overload]}
      settings={OPEN}
      canChangeSettings
      askToTurnOff={null}
      timeZone={NY}
      now={NOW}
      actionFor={(item) =>
        item.kind === 'schedule_gaps' ? { label: 'Show on calendar', href: '/calendar' } : null
      }
      renderAction={(action, onFollow) => (
        <a
          href={action.href}
          onClick={(event) => {
            event.preventDefault();
            follow();
            onFollow();
          }}
        >
          {action.label}
        </a>
      )}
      onClose={onClose}
      onSettings={onSettings}
      {...props}
    />,
  );
  return { ...view, onClose, onSettings, follow };
}

async function expectAccessible(container: HTMLElement): Promise<void> {
  const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(result.violations.map((violation) => violation.id)).toEqual([]);
}

describe('FeedSuggestions', () => {
  it('lists the suggestions with their reasons, accessibly', async () => {
    const { container } = setup();
    expect(screen.getAllByTestId('feed-suggestion')).toHaveLength(4);
    expect(
      screen.getByRole('article', { name: 'Jess has 2 h 15 min open on Thu, Nov 5' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('switch', { name: 'Pause suggestions' }).getAttribute('aria-checked'),
    ).toBe('false');
    await expectAccessible(container);
  });

  it('dismisses: the item goes, with a 30-day snooze notice', async () => {
    const { onClose } = setup();
    const [first] = screen.getAllByRole('button', { name: 'Dismiss' });
    if (first === undefined) throw new Error('no Dismiss');
    await userEvent.click(first);
    expect(onClose).toHaveBeenCalledWith(gap.id, 'dismissed');
    expect(screen.getAllByTestId('feed-suggestion')).toHaveLength(3);
    expect(screen.getByRole('status').textContent).toBe(
      "Snoozed for 30 days. I won't suggest open gaps for this again until then.",
    );
  });

  it('keeps both gone when two dismissals overlap', async () => {
    const pending: ((value: string | null) => void)[] = [];
    setup({
      onClose: () =>
        new Promise<string | null>((resolve) => {
          pending.push(resolve);
        }),
    });
    const [first, second] = screen.getAllByRole('button', { name: 'Dismiss' });
    if (first === undefined || second === undefined) throw new Error('no Dismiss');
    await userEvent.click(first);
    await userEvent.click(second);
    for (const resolve of pending) resolve(null);
    await vi.waitFor(() => {
      expect(screen.getAllByTestId('feed-suggestion')).toHaveLength(2);
    });
  });

  it('records following an action as done, and shows a failure', async () => {
    const { onClose, follow } = setup();
    await userEvent.click(screen.getByRole('link', { name: 'Show on calendar' }));
    expect(follow).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(gap.id, 'done');

    cleanup();
    setup({ onClose: () => Promise.resolve('This suggestion is no longer open') });
    const [first] = screen.getAllByRole('button', { name: 'Dismiss' });
    if (first === undefined) throw new Error('no Dismiss');
    await userEvent.click(first);
    expect(screen.getByRole('alert').textContent).toBe('This suggestion is no longer open');
    expect(screen.getAllByTestId('feed-suggestion')).toHaveLength(4);
  });

  it('pauses, and says so while paused', async () => {
    const { onSettings } = setup();
    await userEvent.click(screen.getByRole('switch', { name: 'Pause suggestions' }));
    expect(onSettings).toHaveBeenCalledWith({ suggestionsPaused: true });
    cleanup();
    const { container } = setup({ items: [], settings: { ...OPEN, suggestionsPaused: true } });
    expect(screen.getByText('Suggestions are paused.')).toBeTruthy();
    await expectAccessible(container);
  });

  it('asks once to turn off a kind dismissed often', async () => {
    const { onSettings } = setup({ askToTurnOff: 'schedule_gaps' });
    await userEvent.click(screen.getByRole('button', { name: 'Turn off open gaps' }));
    expect(onSettings).toHaveBeenCalledWith({
      disabledKinds: ['schedule_gaps'],
      askAnswered: 'schedule_gaps',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Keep them' }));
    expect(onSettings).toHaveBeenLastCalledWith({ askAnswered: 'schedule_gaps' });
  });

  it('gives staff no switch and no question, and teaches when empty', async () => {
    const { container } = setup({
      items: [],
      canChangeSettings: false,
      askToTurnOff: 'schedule_gaps',
    });
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: /Turn off/ })).toBeNull();
    expect(screen.getByText('All clear.')).toBeTruthy();
    await expectAccessible(container);
  });
});

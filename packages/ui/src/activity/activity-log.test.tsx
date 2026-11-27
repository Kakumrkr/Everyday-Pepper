// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { AiActionViewSchema, type AiActionView } from '@pepper/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActivityLog,
  activityLine,
  dayHeading,
  localDay,
  type ActivityPage,
} from './activity-log.js';

afterEach(cleanup);

// The Activity log (S52, AC-W7-4): every receipt in plain words, by local day, with Undo
// while its window is open and "Show older".

const NY = 'America/New_York';
const NOW = Date.parse('2026-11-04T17:00:00.000Z'); // Wed, Nov 4, noon in New York
const CLIENT = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700011';
let next = 0;
const id = () => `0199f0a4-7c1e-7d2a-9b3c-4d5e6f8${String(++next).padStart(5, '0')}`;

function receipt(overrides: Partial<Record<keyof AiActionView, unknown>> = {}): AiActionView {
  return AiActionViewSchema.parse({
    id: id(),
    proposalId: null,
    action: 'booking.move',
    tool: 'move_booking',
    outcome: 'execute_and_notify',
    status: 'done',
    summary: 'Moved Maria Lopez to Thu, Nov 5, 3:00 pm',
    before: null,
    after: null,
    emails: [{ template: 'rescheduled', clientId: CLIENT, status: 'sent', sendsAt: null }],
    createdAt: '2026-11-04T15:15:00.000Z',
    undoUntil: '2026-11-04T19:15:00.000Z',
    canUndo: true,
    undoneAt: null,
    undoReason: null,
    approvedByName: null,
    forYou: true,
    why: {
      asked: { kind: 'none' },
      steps: [],
      decision: { outcome: 'execute_and_notify', reason: 'setting' },
      untrustedContext: false,
    },
    ...overrides,
  });
}

describe('waitlist offer outcome (S54, AC-W5-5)', () => {
  const offer = (overrides: Partial<Record<keyof AiActionView, unknown>> = {}) =>
    receipt({
      action: 'message.waitlist_offer',
      tool: 'send_waitlist_offers',
      summary:
        "Offer Jess's opening Tue 2:00 PM to Maria L., ~$60; the first to claim it books it.",
      after: {
        date: '2026-11-10',
        time: '14:00',
        staffName: 'Jess',
        serviceName: 'Haircut',
        offeredTo: 'Maria L. and Ana R.',
        offers: 2,
        valueCents: 6000,
      },
      ...overrides,
    });

  it('names who got it and the slot’s value while it is open', () => {
    expect(
      activityLine(offer({ fill: { state: 'open', clientName: null, priceCents: null } }), NY)
        .title,
    ).toBe('Offered Tue, Nov 10, 2:00 pm to Maria L. and Ana R., ~$60');
  });

  it('says who filled it and for how much once claimed', () => {
    expect(
      activityLine(offer({ fill: { state: 'filled', clientName: 'Ana R.', priceCents: 6550 } }), NY)
        .title,
    ).toBe('Filled Tue, Nov 10, 2:00 pm with Ana R., +$66');
  });

  it('says nobody claimed it once every offer closed, but not for one undone', () => {
    const closed = { fill: { state: 'unclaimed', clientName: null, priceCents: null } };
    expect(activityLine(offer(closed), NY).title).toBe(
      'Offered Tue, Nov 10, 2:00 pm to Maria L. and Ana R., ~$60; nobody claimed it',
    );
    expect(
      activityLine(offer({ ...closed, status: 'undone', undoneAt: '2026-11-04T15:16:00.000Z' }), NY)
        .title,
    ).toBe('Offered Tue, Nov 10, 2:00 pm to Maria L. and Ana R., ~$60');
  });

  it('a time without a price, or a receipt from before S54, keeps to what it knows', () => {
    const after = { date: '2026-11-10', time: '14:00', staffName: 'Jess', offeredTo: 'Maria L.' };
    expect(activityLine(offer({ after }), NY).title).toBe(
      'Offered Tue, Nov 10, 2:00 pm to Maria L.',
    );
    expect(activityLine(offer({ after: null }), NY).title).toBe(
      "Offer Jess's opening Tue 2:00 PM to Maria L., ~$60; the first to claim it books it.",
    );
  });
});

describe('activity words', () => {
  it('says what was done, when, by whose OK and what it sent', () => {
    expect(activityLine(receipt(), NY)).toEqual({
      title: 'Moved Maria Lopez to Thu, Nov 5, 3:00 pm',
      meta: '10:15 am, on its own, as Autonomy allows · emailed 1 client',
    });
    expect(
      activityLine(
        receipt({
          summary: null,
          action: 'message.waitlist_offer',
          outcome: 'propose',
          approvedByName: 'Ana',
          emails: [
            { template: 'waitlist_offer', clientId: CLIENT, status: 'waiting', sendsAt: null },
            { template: 'waitlist_offer', clientId: CLIENT, status: 'waiting', sendsAt: null },
          ],
        }),
        NY,
      ),
    ).toEqual({ title: 'Waitlist offer', meta: '10:15 am, approved by Ana · 2 emails wait to go' });
    expect(
      activityLine(
        receipt({
          outcome: 'propose',
          status: 'undone',
          undoneAt: '2026-11-04T15:45:00.000Z',
          emails: [
            { template: 'rescheduled', clientId: CLIENT, status: 'taken_back', sendsAt: null },
          ],
        }),
        NY,
      ).meta,
    ).toBe('10:15 am, after approval · 1 email taken back · undone at 10:45 am');
  });

  it('says a card was approved by text, by the viewer or by a lead (S63.2, AC-X-91)', () => {
    expect(activityLine(receipt({ outcome: 'propose', approvedVia: 'text' }), NY).meta).toBe(
      '10:15 am, approved by text · emailed 1 client',
    );
    expect(
      activityLine(receipt({ outcome: 'propose', approvedVia: 'text', approvedByName: 'Ana' }), NY)
        .meta,
    ).toBe('10:15 am, approved by Ana by text · emailed 1 client');
  });

  it('heads each local day: today, yesterday (also across a DST change), then the date', () => {
    expect(localDay('2026-11-04T03:00:00.000Z', NY)).toBe('2026-11-03');
    expect(dayHeading('2026-11-04', NY, NOW)).toBe('Today');
    expect(dayHeading('2026-11-03', NY, NOW)).toBe('Yesterday');
    expect(dayHeading('2026-11-02', NY, NOW)).toBe('Mon, Nov 2');
    // Mon, Nov 2 2026, 11:30 pm after Sunday's 25-hour day: yesterday is Sunday.
    expect(dayHeading('2026-11-01', NY, Date.parse('2026-11-03T04:30:00.000Z'))).toBe('Yesterday');
  });
});

describe('ActivityLog', () => {
  const today = receipt();
  const yesterday = receipt({
    summary: 'Added a to-do: call the supplier',
    action: 'task.create',
    emails: [],
    createdAt: '2026-11-03T20:00:00.000Z',
    undoUntil: null,
    canUndo: false,
  });

  function setup(overrides: { next?: string | null } = {}) {
    const onMore = vi.fn<(next: string) => Promise<ActivityPage>>(() =>
      Promise.resolve({
        actions: [
          yesterday,
          receipt({
            summary: 'Booked Lee Park',
            createdAt: '2026-11-01T15:00:00.000Z',
            canUndo: false,
          }),
        ],
        next: null,
      }),
    );
    const onUndo = vi.fn((undoneId: string) =>
      Promise.resolve<{ action: AiActionView; notice: string } | string>({
        action: receipt({
          ...today,
          id: undoneId,
          status: 'undone',
          canUndo: false,
          undoneAt: '2026-11-04T16:59:00.000Z',
        }),
        notice: 'Undone. The client was already emailed, and I didn’t email them again.',
      }),
    );
    const view = render(
      <ActivityLog
        initial={{ actions: [today, yesterday], next: overrides.next ?? yesterday.id }}
        timeZone={NY}
        now={NOW}
        onMore={onMore}
        onUndo={onUndo}
      />,
    );
    return { ...view, onMore, onUndo };
  }

  it('lists receipts by day with Undo while open, accessibly', async () => {
    const { container } = setup();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Today',
      'Yesterday',
    ]);
    const todays = screen.getByRole('region', { name: 'Today' });
    expect(within(todays).getByText(/You can undo this until/)).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Yesterday' })).queryByRole('button'),
    ).toBeNull();
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });

  it('undoes in place, and pages on with "Show older" without a receipt twice', async () => {
    const { onMore, onUndo } = setup();
    await userEvent.click(
      screen.getByRole('button', { name: 'Undo: Moved Maria Lopez to Thu, Nov 5, 3:00 pm' }),
    );
    expect(onUndo).toHaveBeenCalledWith(today.id);
    expect(await screen.findByText('Undone', { selector: 'span' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(
      'Undone. The client was already emailed, and I didn’t email them again.',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Show older' }));
    expect(onMore).toHaveBeenCalledWith(yesterday.id);
    expect(await screen.findByRole('region', { name: 'Sun, Nov 1' })).toBeTruthy();
    expect(screen.getAllByTestId('activity-row')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
  });

  it('says what will appear when empty, and shows a refused undo', async () => {
    cleanup();
    render(
      <ActivityLog
        initial={{ actions: [], next: null }}
        timeZone={NY}
        now={NOW}
        onMore={() => Promise.resolve('x')}
        onUndo={() => Promise.resolve('x')}
        emptyAction={<a href="/chat">Ask me to do something</a>}
      />,
    );
    expect(screen.getByTestId('activity-empty').textContent).toContain('Nothing yet.');
    expect(screen.getByRole('link', { name: 'Ask me to do something' })).toBeTruthy();
    cleanup();
    render(
      <ActivityLog
        initial={{ actions: [today], next: null }}
        timeZone={NY}
        now={NOW}
        onMore={() => Promise.resolve('x')}
        onUndo={() => Promise.resolve('The email has already left, so it can’t be unsent.')}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /^Undo:/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('already left');
  });
});

describe('a released visit (S78.2, AC-X-211)', () => {
  const released = (fill?: Record<string, unknown>) =>
    receipt({
      action: 'booking.release',
      tool: 'release_unconfirmed_booking',
      outcome: 'propose',
      summary: 'Maria L. hasn’t confirmed Tue, Dec 1, 2:00 pm. Release it and offer it?',
      before: { date: '2026-12-01', time: '14:00', endTime: '15:00', clientName: 'Maria L.' },
      undoUntil: null,
      canUndo: false,
      emails: [{ template: 'cancelled', clientId: CLIENT, status: 'sent', sendsAt: null }],
      ...(fill !== undefined && { fill }),
    });

  it('says it was released, then offered, then filled', () => {
    expect(activityLine(released(), NY).title).toBe('Released Tue, Dec 1, 2:00 pm');
    expect(
      activityLine(released({ state: 'open', clientName: null, priceCents: null, offered: 3 }), NY)
        .title,
    ).toBe('Released Tue, Dec 1, 2:00 pm, offered to 3');
    expect(
      activityLine(
        released({ state: 'filled', clientName: 'Sara K.', priceCents: 6000, offered: 3 }),
        NY,
      ).title,
    ).toBe('Released Tue, Dec 1, 2:00 pm, offered to 3, filled +$60');
    expect(
      activityLine(
        released({ state: 'unclaimed', clientName: null, priceCents: null, offered: 2 }),
        NY,
      ).title,
    ).toBe('Released Tue, Dec 1, 2:00 pm, offered to 2, nobody claimed it');
  });
});

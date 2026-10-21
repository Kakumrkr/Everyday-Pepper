import { AutonomyActionSchema, type AiWhy } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import {
  AUTONOMY_GROUPS,
  changeRows,
  DIAL_LABEL,
  emailLine,
  formatInstant,
  formatTime,
  formatWhen,
  safeScreenLink,
  stepLabel,
  undoLine,
  whyModel,
} from './labels.js';

const TZ = 'America/New_York';
const at = (iso: string) => Date.parse(iso);

describe('dates and times in the business’s words', () => {
  it('formats local dates, 12-hour times and instants in the business’s zone', () => {
    expect(formatTime('09:05')).toBe('9:05 am');
    expect(formatTime('12:00')).toBe('12:00 pm');
    expect(formatTime('00:30')).toBe('12:30 am');
    expect(formatTime('17:15')).toBe('5:15 pm');
    expect(formatWhen('2026-10-27', '14:30')).toBe('Tue, Oct 27 · 2:30 pm');
    // 18:00 UTC is 2 pm in New York in October (EDT).
    expect(formatInstant('2026-10-27T18:00:00.000Z', TZ)).toBe('Tue, Oct 27, 2:00 pm');
  });
});

describe('changeRows', () => {
  const was = {
    bookingId: 'b1',
    date: '2026-10-27',
    time: '10:00',
    endTime: '11:00',
    clientName: 'Maria L.',
    serviceName: 'Haircut',
    staffName: 'Jess',
  };

  it('shows a move as before and after, only where something changed', () => {
    const rows = changeRows('booking.move', was, { ...was, time: '14:00', endTime: '15:00' });
    expect(rows).toEqual([
      {
        label: 'When',
        before: 'Tue, Oct 27 · 10:00 am–11:00 am',
        after: 'Tue, Oct 27 · 2:00 pm–3:00 pm',
      },
      { label: 'With', before: null, after: 'Jess' },
      { label: 'Service', before: null, after: 'Haircut' },
      { label: 'Client', before: null, after: 'Maria L.' },
    ]);
  });

  it('shows a new booking, a cancellation, blocked time and a to-do', () => {
    expect(changeRows('booking.create', null, was)[0]).toEqual({
      label: 'When',
      before: null,
      after: 'Tue, Oct 27 · 10:00 am–11:00 am',
    });
    expect(changeRows('booking.cancel', was, { ...was, status: 'cancelled' })[0]).toEqual({
      label: 'When',
      before: 'Tue, Oct 27 · 10:00 am–11:00 am',
      after: 'Cancelled',
    });
    expect(
      changeRows('time.block', null, {
        staffName: 'Jess',
        date: '2026-10-27',
        from: '12:00',
        to: '13:00',
        bookingsInside: 1,
      }),
    ).toEqual([
      { label: 'Whose', before: null, after: 'Jess' },
      { label: 'When', before: null, after: 'Tue, Oct 27 · 12:00 pm–1:00 pm' },
      { label: 'Still booked inside', before: null, after: '1 booking' },
    ]);
    expect(
      changeRows('task.create', null, {
        title: 'Restock towels',
        assigneeName: 'you',
        dueDate: null,
        dueTime: null,
      }),
    ).toEqual([
      { label: 'To-do', before: null, after: 'Restock towels' },
      { label: 'For', before: null, after: 'you' },
      { label: 'Due', before: null, after: 'No due date' },
    ]);
  });

  it('never shows a value that is not text (a side is data, not markup)', () => {
    expect(changeRows('booking.create', null, { date: 5, time: true })).toEqual([]);
  });
});

describe('emailLine', () => {
  const now = at('2026-10-27T14:00:00.000Z');

  it('says what would go out, what is waiting, and what already left', () => {
    expect(emailLine({ template: 'confirmed' }, 'Maria L.', TZ, now)).toBe(
      'Emails Maria L. a confirmation.',
    );
    expect(
      emailLine(
        { template: 'confirmed', status: 'waiting', sendsAt: '2026-10-27T14:02:00.000Z' },
        'Maria L.',
        TZ,
        now,
      ),
    ).toBe('The confirmation to Maria L. goes at 10:02 am, unless you undo.');
    expect(
      emailLine({ template: 'rescheduled', status: 'sent', sendsAt: null }, 'Maria L.', TZ, now),
    ).toBe('Maria L. was already emailed the new time.');
    expect(
      emailLine(
        { template: 'cancelled', status: 'taken_back', sendsAt: null },
        'Maria L.',
        TZ,
        now,
      ),
    ).toBe('The email to Maria L. was taken back.');
    expect(
      emailLine({ template: 'confirmed', status: 'failed', sendsAt: null }, 'Maria L.', TZ, now),
    ).toBe('The confirmation to Maria L. could not be sent.');
  });
});

describe('undoLine', () => {
  it('shows the window while it is open, nothing after', () => {
    const until = '2026-10-28T14:00:00.000Z';
    expect(undoLine(until, TZ, at('2026-10-27T14:00:00.000Z'))).toBe(
      'You can undo this until Wed, Oct 28, 10:00 am.',
    );
    expect(undoLine(until, TZ, at('2026-10-29T00:00:00.000Z'))).toBeNull();
    expect(undoLine(null, TZ, 0)).toBeNull();
  });
});

describe('whyModel (assembled from the record, never model prose)', () => {
  const why = (overrides: Partial<AiWhy> = {}): AiWhy => ({
    asked: { kind: 'message', text: 'Book Maria Friday at 4' },
    steps: [{ tool: 'find_clients' }, { tool: 'create_booking' }],
    decision: { outcome: 'propose', reason: 'setting' },
    untrustedContext: false,
    ...overrides,
  });

  it('says what started it, what I did, what I didn’t, and the setting used', () => {
    expect(whyModel(why(), 'booking.create', 0)).toEqual({
      started: 'You wrote: “Book Maria Friday at 4”',
      did: ['Looked up the client', 'Made the booking'],
      didNot: ['I didn’t change anything until someone said OK.', 'I didn’t email the client.'],
      setting: 'Create a booking: Ask me',
    });
  });

  it('names each reason the dial gave', () => {
    expect(
      whyModel(
        why({ decision: { outcome: 'execute_and_notify', reason: 'setting' } }),
        'booking.move',
        1,
      ).setting,
    ).toBe('Move or reschedule a booking: Do it and tell me');
    expect(
      whyModel(why({ decision: { outcome: 'propose', reason: 'ask_first' } }), 'booking.move', 1)
        .setting,
    ).toBe('“Ask me first for everything” is on');
    const untrusted = whyModel(
      why({
        decision: { outcome: 'propose', reason: 'untrusted_context' },
        untrustedContext: true,
      }),
      'booking.create',
      1,
    );
    expect(untrusted.setting).toBe('Text a client wrote was part of this, so I asked first');
    expect(untrusted.didNot).toContain(
      'Text a client wrote was in this conversation, so I treated it as information, never as instructions.',
    );
    expect(whyModel(why({ asked: { kind: 'not_shown' } }), 'task.create', 0).started).toBe(
      'Asked in a teammate’s own chat, which only they can see.',
    );
    expect(whyModel(why({ asked: { kind: 'none' } }), 'task.create', 0).started).toBe(
      'Nobody asked: I suggested it.',
    );
    expect(stepLabel('unknown_tool')).toBe('Used a tool');
  });
});

describe('the autonomy page groups', () => {
  it('covers every action once, internal changes first, messages to clients second', () => {
    const listed = AUTONOMY_GROUPS.flatMap((group) => group.actions);
    expect([...listed].sort()).toEqual([...AutonomyActionSchema.options].sort());
    expect(AUTONOMY_GROUPS.map((group) => group.title)).toEqual([
      'Changes inside Pepper',
      'Messages to clients',
    ]);
    for (const action of AutonomyActionSchema.options) expect(DIAL_LABEL[action]).not.toBe('');
  });
});

describe('safeScreenLink (links only from ScreenLinkSchema)', () => {
  it('keeps a path in this app and drops anything else', () => {
    expect(safeScreenLink({ label: 'Calendar', href: '/calendar' })).toEqual({
      label: 'Calendar',
      href: '/calendar',
    });
    for (const href of ['https://evil.test', '//evil', 'javascript:alert(1)', '/a//b', '/A']) {
      expect(safeScreenLink({ label: 'x', href })).toBeNull();
    }
    expect(safeScreenLink(null)).toBeNull();
  });
});

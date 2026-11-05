import { AutonomyActionSchema, MemoryFactShownSchema, type AiWhy } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import {
  AUTONOMY_GROUPS,
  changeRows,
  DIAL_LABEL,
  emailLine,
  factLine,
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

  it('shows a learned rule: whom it is for, and the rule before and after (S31)', () => {
    expect(
      changeRows(
        'rule.change',
        { rule: 'Mondays: 09:00–17:00', scope: 'Jess' },
        { rule: 'No bookings before 10:00 on Mondays', scope: 'Jess', kind: 'hours_limit' },
      ),
    ).toEqual([
      { label: 'For', before: null, after: 'Jess' },
      {
        label: 'Rule',
        before: 'Mondays: 09:00–17:00',
        after: 'No bookings before 10:00 on Mondays',
      },
    ]);
    expect(
      factLine({ kind: 'rule_change', value: { rule: 'At most 6 bookings a day', scope: 'Jess' } }),
    ).toBe(
      'At most 6 bookings a day, for Jess. A booking rule always waits for an owner’s or manager’s OK.',
    );
    expect(factLine({ kind: 'rule_change', value: {} })).toBeNull();
    // A rebooking email (S36): its rows, and its reasons.
    expect(
      changeRows('message.rebooking_nudge', null, {
        email: 'rebooking',
        clientName: 'Sara',
        serviceName: 'Haircut',
        staffName: 'Jess',
        date: '2026-11-03',
        time: '09:00',
      }),
    ).toEqual([
      { label: 'To', before: null, after: 'Sara' },
      { label: 'Service', before: null, after: 'Haircut' },
      { label: 'Open time', before: null, after: 'Tue, Nov 3 · 9:00 am' },
      { label: 'With', before: null, after: 'Jess' },
    ]);
    expect(factLine({ kind: 'nudge_last_visit', value: { date: '2026-09-28' } })).toBe(
      'Their last visit was on Mon, Sep 28.',
    );
    expect(factLine({ kind: 'win_back', value: { visits: 4, dueOn: '2026-10-12' } })).toBe(
      'After 4 visits they were due back on Mon, Oct 12, and nothing is booked.',
    );
    expect(factLine({ kind: 'win_back', value: { visits: 'many' } })).toBeNull();
    expect(stepLabel('win_back')).toBe('Drafted the email you asked for');
    expect(
      factLine({
        kind: 'rebooking_due',
        value: { intervalDays: 28, dueOn: '2026-10-26', basis: 'client_median' },
      }),
    ).toBe(
      'They usually come back every 28 days, so they were due on Mon, Oct 26, and nothing is booked.',
    );
    expect(factLine({ kind: 'rebooking_due', value: { dueOn: '2026-10-26' } })).toBeNull();
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

describe('changeRows for completing a to-do and unblocking time (S26b)', () => {
  it('shows a completed to-do as open → done, and whose it is', () => {
    const was = { title: 'Order foils', whose: 'you', dueDate: null, dueTime: null };
    expect(
      changeRows('task.create', { ...was, status: 'open' }, { ...was, status: 'done' }),
    ).toEqual([
      { label: 'To-do', before: null, after: 'Order foils' },
      { label: 'For', before: null, after: 'You' },
      { label: 'Status', before: 'Open', after: 'Done' },
    ]);
  });

  it('shows the whole span an unblock frees', () => {
    const before = {
      staffMemberId: 's1',
      staffName: 'Marco',
      fromDate: '2026-11-03',
      from: '09:00',
      toDate: '2026-11-06',
      to: '17:00',
    };
    const after = { staffMemberId: 's1', staffName: 'Marco', blocked: false };
    expect(changeRows('time.block', before, after)).toEqual([
      { label: 'Whose', before: null, after: 'Marco' },
      {
        label: 'Blocked',
        before: 'Tue, Nov 3 · 9:00 am – Fri, Nov 6 · 5:00 pm',
        after: 'Free to book',
      },
    ]);
    expect(
      changeRows('time.block', { ...before, toDate: '2026-11-03', to: '13:00' }, after)[1],
    ).toEqual({ label: 'Blocked', before: 'Tue, Nov 3 · 9:00 am–1:00 pm', after: 'Free to book' });
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
      checked: [],
      didNot: ['I didn’t change anything until someone said OK.', 'I didn’t email the client.'],
      setting: 'Create a booking: Ask me',
      remembered: [],
    });
  });

  it('lists the remembered facts it used, read live, and a deleted one as such (S30)', () => {
    const model = whyModel(
      why({
        remembered: [
          MemoryFactShownSchema.parse({
            state: 'known',
            factId: '0199f4b2-7c1e-7a00-8000-0000000000f1',
            subjectType: 'client',
            key: 'usual_service',
            value: 'Colour with Jess',
            previous: null,
            sensitive: false,
          }),
          MemoryFactShownSchema.parse({
            state: 'gone',
            factId: '0199f4b2-7c1e-7a00-8000-0000000000f2',
          }),
        ],
      }),
      'booking.create',
      0,
    );
    expect(model.remembered).toEqual(['Usual service: Colour with Jess', 'A fact you deleted']);
  });

  it('says what the domain checked, from the facts it recorded (S26b), skipping unknown ones', () => {
    const facts = [
      { kind: 'slot_was_free', value: { date: '2026-10-30', time: '16:00', staffName: 'Jess' } },
      { kind: 'staff_chosen', value: { staffName: 'Jess' } },
      { kind: 'not_started', value: { date: '2026-10-30', time: '16:00' } },
      { kind: 'bookings_inside', value: { count: 2 } },
      { kind: 'bookings_inside', value: { count: 1 } },
      { kind: 'bookings_inside', value: { count: 0 } },
      { kind: 'bookings_untouched', value: null },
      { kind: 'reminds', value: { date: '2026-10-30', time: '09:00' } },
      { kind: 'todo_was_open', value: null },
      { kind: 'something_new', value: null },
      { kind: 'slot_was_free', value: { date: 3 } },
    ];
    expect(whyModel(why({ facts }), 'booking.create', 1).checked).toEqual([
      'Jess was free on Fri, Oct 30 · 4:00 pm.',
      'You didn’t name anyone, so I picked Jess.',
      'It hadn’t started yet (Fri, Oct 30 · 4:00 pm).',
      '2 bookings stay inside it; I didn’t move or cancel them.',
      '1 booking stays inside it; I didn’t move or cancel it.',
      'No bookings were inside that time.',
      'Bookings stay as they are; I only removed the block.',
      'It reminds them Fri, Oct 30 · 9:00 am.',
      'The to-do was still open.',
    ]);
    expect(stepLabel('find_client_bookings')).toBe('Read the client’s bookings');
    expect(stepLabel('list_todos')).toBe('Read the to-dos');
    expect(stepLabel('complete_todo')).toBe('Marked the to-do done');
    expect(stepLabel('unblock_time')).toBe('Removed the blocked time');
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

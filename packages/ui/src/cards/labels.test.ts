import {
  AutonomyActionSchema,
  levelAllowed,
  MemoryFactShownSchema,
  visitRiskFactValue,
  type AiWhy,
} from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import {
  AUTONOMY_GROUPS,
  changeRows,
  releaseReasonLine,
  decisionLabels,
  DIAL_LABEL,
  LOCKED_HELP,
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
    // A review request (S55.2): to whom, the visit and the 90-day rule.
    expect(
      changeRows('message.review_request', null, {
        email: 'review',
        clientName: 'Ana',
        serviceName: 'Haircut',
        staffName: 'Jess',
        date: '2026-11-04',
      }),
    ).toEqual([
      { label: 'To', before: null, after: 'Ana' },
      { label: 'Visit', before: null, after: 'Haircut' },
      { label: 'On', before: null, after: 'Wed, Nov 4' },
      { label: 'With', before: null, after: 'Jess' },
    ]);
    expect(factLine({ kind: 'review_visit', value: { date: '2026-11-04' } })).toBe(
      'They came in on Wed, Nov 4, and I haven’t asked them for a review in the last 90 days.',
    );
    expect(factLine({ kind: 'review_visit', value: {} })).toBeNull();
    // A visit's risk (S77, ADR-0071): the band and its reasons, the miss first.
    expect(
      factLine({
        kind: 'visit_risk',
        value: visitRiskFactValue({
          band: 'high',
          points: 4,
          reasons: [
            { signal: 'missed_before', points: 3, misses: 2, visits: 5 },
            { signal: 'not_confirmed', points: 1 },
          ],
        }),
      }),
    ).toBe('I rated the risk of a missed visit high: missed 2 of 5 visits, not confirmed yet.');
    expect(factLine({ kind: 'visit_risk', value: { band: 'low' } })).toBe(
      'I rated the risk of a missed visit low.',
    );
    expect(factLine({ kind: 'visit_risk', value: { band: 'unknown' } })).toBeNull();
    // A message the member asked for (S56a): to whom, what kind, the visit and the words.
    expect(
      changeRows('message.client', null, {
        clientName: 'Maria',
        kind: 'running_late',
        date: '2026-11-04',
        time: '14:00',
        endTime: '14:45',
        message: 'Jess is running about 10 minutes late.',
      }),
    ).toEqual([
      { label: 'To', before: null, after: 'Maria' },
      { label: 'What', before: null, after: 'Running late' },
      { label: 'Visit', before: null, after: 'Wed, Nov 4 · 2:00 pm–2:45 pm' },
      { label: 'Message', before: null, after: 'Jess is running about 10 minutes late.' },
    ]);
    expect(emailLine({ template: 'client_message' }, 'Maria', 'America/New_York', 0)).toBe(
      'Emails Maria the message above.',
    );
    expect(factLine({ kind: 'message_visit', value: { date: '2026-11-04', time: '14:00' } })).toBe(
      'It’s about their visit on Wed, Nov 4 · 2:00 pm, which is still booked.',
    );
    expect(factLine({ kind: 'visit_started', value: { date: '2026-11-04', time: '14:00' } })).toBe(
      'It started on Wed, Nov 4 · 2:00 pm and was still booked, not done or cancelled.',
    );
    // A no-show (S56a): the visit, booked → no-show.
    expect(
      changeRows(
        'booking.no_show',
        {
          date: '2026-11-04',
          time: '14:00',
          endTime: '14:45',
          clientName: 'Jay',
          serviceName: 'Fade',
          status: 'confirmed',
        },
        { status: 'no_show' },
      ),
    ).toEqual([
      { label: 'When', before: null, after: 'Wed, Nov 4 · 2:00 pm–2:45 pm' },
      { label: 'Client', before: null, after: 'Jay' },
      { label: 'Service', before: null, after: 'Fade' },
      { label: 'Status', before: 'Booked', after: 'No-show' },
    ]);
    expect(stepLabel('review_requests')).toBe('Looked at yesterday’s visits');
    expect(emailLine({ template: 'review_request' }, 'Ana', 'America/New_York', 0)).toBe(
      'Emails Ana the thank-you below, with your review link.',
    );
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
  it('covers every action once: internal changes, messages to clients, then money', () => {
    const listed = AUTONOMY_GROUPS.flatMap((group) => group.actions);
    expect(listed).toHaveLength(new Set(listed).size);
    expect([...listed].sort()).toEqual([...AutonomyActionSchema.options].sort());
    expect(AUTONOMY_GROUPS.map((group) => group.title)).toEqual([
      'Changes inside Pepper',
      'Messages to clients',
      'Money',
    ]);
    expect(AUTONOMY_GROUPS[2]?.actions).toEqual(['payment.no_show_fee']);
    for (const action of AutonomyActionSchema.options) expect(DIAL_LABEL[action]).not.toBe('');
    // Each locked dial says its own reason (S68: the fee's isn't a booking rule's, CI run 1).
    for (const action of AutonomyActionSchema.options.filter((a) => !levelAllowed(a, 'auto'))) {
      expect(LOCKED_HELP[action]).toBeDefined();
    }
    expect(new Set(Object.values(LOCKED_HELP)).size).toBe(Object.keys(LOCKED_HELP).length);
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

describe('the no-show fee card (S68, AC-X-138)', () => {
  const after = {
    fee: 'no_show',
    clientName: 'Ana',
    serviceName: 'Haircut',
    staffName: 'Jess',
    date: '2026-11-03',
    time: '10:00',
    endTime: '11:00',
    amount: '$20',
    card: 'card_on_file',
    keptDeposit: null,
    policy:
      'Please cancel or reschedule at least 24 hours before your visit. No-shows may be charged $20.',
    choice: 'No-shows may be charged $20 · charge $20 or waive',
  };

  it('shows the visit, the card, the client’s own terms and the choice', () => {
    expect(changeRows('payment.no_show_fee', null, after)).toEqual([
      { label: 'Client', before: null, after: 'Ana' },
      { label: 'Missed', before: null, after: 'Tue, Nov 3 · 10:00 am–11:00 am' },
      { label: 'Service', before: null, after: 'Haircut' },
      { label: 'Card', before: null, after: 'Card on file' },
      { label: 'Their policy', before: null, after: after.policy },
      { label: 'Fee', before: null, after: 'No-shows may be charged $20 · charge $20 or waive' },
    ]);
    expect(changeRows('payment.no_show_fee', null, { ...after, card: 'deposit_card' })[3]).toEqual({
      label: 'Card',
      before: null,
      after: 'The deposit’s card',
    });
  });

  it('puts the money on the button: "Charge $20" or "Waive"', () => {
    expect(decisionLabels('payment.no_show_fee', after)).toEqual({
      approve: 'Charge $20',
      reject: 'Waive',
    });
    expect(decisionLabels('booking.move', null)).toEqual({ approve: 'Approve', reject: 'Not now' });
  });
});

describe('the release card (S78.2, AC-X-208, AC-X-213)', () => {
  const before = {
    bookingId: 'b1',
    date: '2026-12-01',
    time: '14:00',
    endTime: '15:00',
    clientName: 'Maria L.',
    serviceName: 'Haircut',
    staffName: 'Jess',
    status: 'confirmed',
  };

  it('names the visit, its top reason and what the tap does', () => {
    const rows = changeRows('booking.release', before, {
      ...before,
      status: 'cancelled',
      release: true,
      refund: true,
      riskSignal: 'missed_before',
      riskMisses: 2,
      riskVisits: 5,
    });
    expect(rows.map((row) => [row.label, row.after])).toEqual([
      ['Client', 'Maria L.'],
      ['When', 'Tue, Dec 1 · 2:00 pm–3:00 pm'],
      ['Service', 'Haircut'],
      ['With', 'Jess'],
      ['Top reason', 'Missed 2 of 5 visits'],
      [
        'Then',
        'Email the client, refund the deposit in full, and offer the time to your waitlist and regulars',
      ],
    ]);
  });

  it('leaves the reason out without one, and the refund without a deposit', () => {
    const rows = changeRows('booking.release', before, {
      ...before,
      refund: false,
      riskSignal: null,
    });
    expect(rows.map((row) => row.label)).not.toContain('Top reason');
    expect(rows.at(-1)?.after).toBe(
      'Email the client, and offer the time to your waitlist and regulars',
    );
    // A client with no email address: no email promised.
    expect(
      changeRows('booking.release', before, { ...before, emailed: false, refund: true }).at(-1)
        ?.after,
    ).toBe('Refund the deposit in full, and offer the time to your waitlist and regulars');
    expect(releaseReasonLine({ riskSignal: 'booked_far_ahead', riskDays: 21 })).toBe(
      'Booked 21 days ahead',
    );
    expect(releaseReasonLine({ riskSignal: 'first_visit' })).toBe('First visit');
  });

  it('asks with its own buttons, and is locked to asking', () => {
    expect(decisionLabels('booking.release', null)).toEqual({
      approve: 'Release and offer it',
      reject: 'Keep it',
    });
    expect(LOCKED_HELP['booking.release']).toContain('can’t be undone');
    expect(AUTONOMY_GROUPS[1]?.actions).toContain('booking.release');
  });
});

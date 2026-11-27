import type { ClientTexts } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import {
  consentDayLabel,
  consentHowLabel,
  consentMomentLabel,
  lastTextLine,
  textsSummary,
} from './client-texts';

// The profile's "Text messages" words (S61.2, AC-X-66).

const ZONE = 'America/New_York';
const CONSENT: NonNullable<ClientTexts['consent']> = {
  phone: '+15552345678',
  source: 'booking_page',
  wordingVersion: 'sms-consent-v1',
  words: 'Text me appointment confirmations and reminders from Juniper at this number.',
  // 23:30 on the 12th in New York, already the 13th in UTC: the business's day counts.
  givenAt: '2026-11-13T04:30:00.000Z' as never,
  stoppedAt: null,
};
const of = (texts: Partial<ClientTexts>): ClientTexts => ({
  status: 'on',
  textable: true,
  consent: CONSENT,
  canStop: true,
  lastText: null,
  consents: [],
  messages: [],
  canReply: false,
  ...texts,
});

describe('textsSummary', () => {
  const options = { timeZone: ZONE, hasPhone: true };

  it('says since when and how texts are on, on the business’s day', () => {
    expect(textsSummary(of({}), 'Sam', options)).toEqual({
      badge: { text: 'On', tone: 'ok' },
      line: 'Said yes Nov 12, 2026 on your booking page.',
      next: 'I text their confirmations and reminders. They can reply STOP at any time.',
    });
  });

  it('says a waitlist client’s texts are about openings (S79)', () => {
    const consent = {
      ...CONSENT,
      source: 'staff_recorded' as const,
      wordingVersion: 'sms-consent-v3' as const,
    };
    expect(textsSummary(of({ consent }), 'Sam', options)).toEqual({
      badge: { text: 'On', tone: 'ok' },
      line: 'Said yes Nov 12, 2026 to your team, when added to the waitlist.',
      next: 'I text them when a time they’re waiting for opens up. They can reply STOP at any time.',
    });
  });

  it('says a STOP turned them off, and how they come back', () => {
    expect(textsSummary(of({ status: 'opted_out' }), 'Sam', options)).toMatchObject({
      badge: { text: 'Off', tone: 'warn' },
      line: 'They replied STOP, so no texts go to their number.',
      next: 'Sam can reply START to get texts again. Until then I email them.',
    });
  });

  it('says when a member stopped them, and that only the client can say yes again', () => {
    const stopped = of({
      status: 'stopped',
      canStop: false,
      consent: { ...CONSENT, stoppedAt: '2026-11-14T15:00:00.000Z' as never },
    });
    expect(textsSummary(stopped, 'Sam', options)).toMatchObject({
      line: 'Texts stopped Nov 14, 2026.',
      next: 'I email Sam instead. They can say yes again by ticking the box when they next book online.',
    });
  });

  it('says what to do when they were never asked: by phone, or why the number can’t', () => {
    const never = of({ status: 'never', consent: null, canStop: false });
    expect(textsSummary(never, 'Sam', options)).toMatchObject({
      badge: { text: 'Not asked', tone: 'neutral' },
      line: 'Sam hasn’t said yes to texts.',
      next: 'They can tick the box when they book online. Until then I email them.',
    });
    expect(textsSummary({ ...never, textable: false }, 'Sam', options).next).toBe(
      'Their number can’t get texts: I text US and Canadian numbers only.',
    );
    expect(
      textsSummary({ ...never, textable: false }, 'Sam', { ...options, hasPhone: false }).next,
    ).toBe('Add their mobile number first. They can say yes when they book online.');
  });
});

describe('the record’s labels', () => {
  it('shows the moment to the minute and the day with its year, in the business’s zone', () => {
    expect(consentMomentLabel(ZONE, CONSENT.givenAt)).toBe('Thu, Nov 12, 2026, 11:30 PM');
    expect(consentDayLabel('America/Los_Angeles', CONSENT.givenAt)).toBe('Nov 12, 2026');
  });

  it('says how they said yes', () => {
    expect(consentHowLabel('booking_page')).toBe('Ticked the box on your booking page');
    // S79: a waitlist client's consent, online or told to the team.
    expect(consentHowLabel('waitlist_join')).toBe(
      'Ticked the box when they joined your waitlist online',
    );
    expect(consentHowLabel('staff_recorded')).toBe('Told your team, when added to the waitlist');
  });
});

describe('lastTextLine (AC-X-78)', () => {
  // 15:10 in New York on Tue Nov 10.
  const at = '2026-11-10T20:10:00.000Z' as never;
  const last = (patch: Partial<NonNullable<ClientTexts['lastText']>>) => ({
    kind: 'day_before' as const,
    at,
    state: 'delivered' as const,
    reason: null,
    ...patch,
  });

  it('says nothing when the business never texted them', () => {
    expect(lastTextLine(null, ZONE)).toBeNull();
  });

  it('says what went, when, in the business’s time zone, and that it arrived', () => {
    expect(lastTextLine(last({}), ZONE)).toBe(
      'Last text: the reminder the day before, sent Tue, Nov 10, 3:10 PM. Delivered.',
    );
  });

  it('names each kind of text', () => {
    expect(lastTextLine(last({ kind: 'opt_in' }), ZONE)).toContain('the welcome text');
    expect(lastTextLine(last({ kind: 'confirmation' }), ZONE)).toContain('a booking confirmation');
    expect(lastTextLine(last({ kind: 'same_day' }), ZONE)).toContain('the reminder on the day');
  });

  it('says when a held text will go', () => {
    expect(lastTextLine(last({ state: 'waiting' }), ZONE)).toBe(
      'Next text: the reminder the day before, waiting to go Tue, Nov 10, 3:10 PM.',
    );
  });

  it('says sent with no report yet, and not delivered', () => {
    expect(lastTextLine(last({ state: 'sent' }), ZONE)).toBe(
      'Last text: the reminder the day before, sent Tue, Nov 10, 3:10 PM. No delivery report yet.',
    );
    expect(lastTextLine(last({ state: 'not_delivered' }), ZONE)).toContain(
      'Not delivered: their carrier turned it away.',
    );
  });

  it('says why a text was not sent', () => {
    const notSent = (reason: NonNullable<ClientTexts['lastText']>['reason']) =>
      lastTextLine(last({ state: 'not_sent', reason }), ZONE);
    expect(notSent('opted_out')).toContain('Not sent: they replied STOP.');
    expect(notSent('no_consent')).toContain('Not sent: they hadn’t said yes to texts.');
    expect(notSent('not_textable')).toContain('Not sent: their number can’t get texts.');
    expect(notSent('failed')).toContain('Not sent: the text service failed.');
    expect(notSent(null)).toMatch(/PM\. Not sent\.$/);
  });
});

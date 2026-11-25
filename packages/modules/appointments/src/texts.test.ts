import { OutboxSmsSchema, SMS_MAX_SEGMENTS, smsSegments } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import type { BookingEmailDetails } from './services/notices.js';
import {
  confirmationText,
  confirmedReply,
  formatTextWhen,
  optInText,
  reminderText,
  type ReminderTextInput,
} from './texts.js';

// The texts to a booking's client (S62, AC-X-72…74): Pepper's fixed words, the business's zone,
// three GSM-7 segments at most whatever the names.

const DETAILS: BookingEmailDetails = {
  businessName: 'Fades by Marco',
  slug: 'fades-by-marco',
  timeZone: 'America/New_York',
  serviceName: 'Skin fade',
  staffName: 'Marco',
  // Tuesday 17 November 2026, 14:00 in New York.
  startsAt: '2026-11-17T19:00:00.000Z',
  email: 'ana@example.test',
  clientName: 'Ana Ruiz',
  policy: { sentence: null, note: null },
};
const LINK = `https://app.example.com/book/fades-by-marco/manage#${'a'.repeat(43)}`;

const reminder = (over: Partial<ReminderTextInput> = {}) =>
  reminderText({
    kind: 'day_before',
    details: DETAILS,
    link: LINK,
    askToConfirm: true,
    first: false,
    today: false,
    ...over,
  });

/** The longest names a text meets: a 100-character business, service, staff, slug and emoji. */
const LONGEST: BookingEmailDetails = {
  ...DETAILS,
  businessName: `${'Ñ'.repeat(60)} 💈 Salon & Spa`,
  serviceName: `Balayage ✨ ${'x'.repeat(90)}`,
  staffName: `Marie-Thérèse ${'y'.repeat(60)}`,
  slug: 'a'.repeat(63),
};
const LONG_LINK = `https://pepper-pilot.example.com/book/${'a'.repeat(63)}/manage#${'b'.repeat(43)}`;

describe('reminder texts', () => {
  it('names the business, the service, the staff member and the time in its zone', () => {
    expect(reminder()).toBe(
      `Fades by Marco via Pepper: Reminder: Skin fade with Marco on Tue, Nov 17 at 2:00 PM. Reply C to confirm. Change or cancel: ${LINK}`,
    );
    expect(formatTextWhen(DETAILS.startsAt, 'America/Los_Angeles')).toBe('Tue, Nov 17 at 11:00 AM');
  });

  it('says "today" on the day only, and stops asking once confirmed', () => {
    expect(reminder({ kind: 'same_day', today: true, askToConfirm: false })).toBe(
      `Fades by Marco via Pepper: See you today at 2:00 PM for Skin fade with Marco. Change or cancel: ${LINK}`,
    );
    expect(reminder({ kind: 'same_day', today: false })).toContain(
      'See you Tue, Nov 17 at 2:00 PM for Skin fade with Marco. Reply C to confirm.',
    );
  });

  it('says how to stop on the first reminder only (top-up)', () => {
    expect(reminder({ first: true }).split('\n')).toEqual([reminder(), 'Reply STOP to opt out.']);
    expect(reminder()).not.toContain('STOP');
  });

  it('goes without a link when the app has no address', () => {
    expect(reminder({ link: null })).toBe(
      'Fades by Marco via Pepper: Reminder: Skin fade with Marco on Tue, Nov 17 at 2:00 PM. Reply C to confirm.',
    );
  });

  it('fits three GSM-7 segments with the longest names, and is queueable', () => {
    const texts = [
      reminderText({
        kind: 'day_before',
        details: LONGEST,
        link: LONG_LINK,
        askToConfirm: true,
        first: true,
        today: false,
      }),
      reminderText({
        kind: 'same_day',
        details: { ...LONGEST, staffName: null },
        link: LONG_LINK,
        askToConfirm: true,
        first: true,
        today: true,
      }),
      optInText(LONGEST, LONG_LINK),
      confirmationText(LONGEST, LONG_LINK),
      confirmedReply(LONGEST, false),
    ];
    for (const body of texts) {
      const segments = smsSegments(body);
      expect(segments.encoding).toBe('gsm7');
      expect(segments.segments).toBeLessThanOrEqual(SMS_MAX_SEGMENTS);
      expect(
        OutboxSmsSchema.safeParse({ to: '+12125550123', body, wordsBy: 'template' }).success,
      ).toBe(true);
    }
  });
});

describe('opt-in and confirmation texts (AC-X-73)', () => {
  it('says who texts, what, how often, rates, HELP and STOP, with the booking', () => {
    const text = optInText(DETAILS, LINK);
    expect(text).toContain(
      "Fades by Marco via Pepper: You're booked: Skin fade on Tue, Nov 17 at 2:00 PM.",
    );
    expect(text).toContain(`Change or cancel: ${LINK}`);
    for (const words of [
      'appointment confirmations and reminders',
      'Msg frequency varies.',
      'Msg & data rates may apply.',
      'Reply HELP for help, STOP to opt out.',
    ]) {
      expect(text).toContain(words);
    }
  });

  it('confirms a booking in one line when texts are already on', () => {
    expect(confirmationText(DETAILS, null)).toBe(
      "Fades by Marco via Pepper: You're booked: Skin fade with Marco on Tue, Nov 17 at 2:00 PM.",
    );
  });

  it('answers a "C" with the time, or that it was already confirmed', () => {
    expect(confirmedReply(DETAILS, false)).toBe(
      "Fades by Marco via Pepper: Thanks, you're confirmed for Skin fade with Marco on Tue, Nov 17 at 2:00 PM. See you then!",
    );
    expect(confirmedReply(DETAILS, true)).toContain("You're already confirmed");
  });
});

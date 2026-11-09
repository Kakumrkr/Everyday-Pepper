import type { BookingEmailDetails } from '@pepper/appointments';
import { aiDisclosureLines } from '@pepper/contracts';
import { DraftRefusedError } from '@pepper/core';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_NOTE_MAX,
  cleanNote,
  clientMessageEmail,
  messageTiming,
} from './client-messages.js';

// The words and timing of a message the member asks for (S56a, AC-W2-5/6).

const details: BookingEmailDetails = {
  businessName: 'Fade Lab',
  slug: 'fade-lab',
  timeZone: 'America/New_York',
  serviceName: 'Skin Fade',
  staffName: 'Dre',
  startsAt: '2026-11-04T19:00:00.000Z', // 2:00 PM in New York
  email: 'maria@example.com',
  clientName: 'Maria Lopez',
};

const at = (iso: string) => new Date(iso);
const start = at('2026-11-04T19:00:00.000Z');

describe('messageTiming', () => {
  it('sends a reminder only before the visit starts', () => {
    expect(messageTiming('reminder', start, at('2026-11-03T19:00:00Z'))).toBe('ok');
    expect(messageTiming('reminder', start, start)).toBe('started');
  });

  it('sends "running late" from 3 hours before to 1 hour after the start', () => {
    expect(messageTiming('running_late', start, at('2026-11-04T15:59:00Z'))).toBe('too_early');
    expect(messageTiming('running_late', start, at('2026-11-04T16:00:00Z'))).toBe('ok');
    expect(messageTiming('running_late', start, at('2026-11-04T20:00:00Z'))).toBe('ok');
    expect(messageTiming('running_late', start, at('2026-11-04T20:01:00Z'))).toBe('too_late');
  });

  it('sends a note about a visit whenever it is still booked', () => {
    expect(messageTiming('note', start, at('2026-10-01T00:00:00Z'))).toBe('ok');
    expect(messageTiming('note', start, at('2026-11-05T00:00:00Z'))).toBe('ok');
  });
});

describe('cleanNote', () => {
  it('tidies spaces and keeps the words', () => {
    expect(cleanNote('  Bring   your photos!\r\n\n\n\nSee you.  ')).toBe(
      'Bring your photos!\n\nSee you.',
    );
  });

  it.each([
    ['empty', '   '],
    ['missing', null],
    ['too long', 'a'.repeat(CLIENT_NOTE_MAX + 1)],
    ['a link', 'Book here: fadelab.com/book'],
    ['an email address', 'Write to dre@fadelab.co'],
    ['a phone number', 'Call me on 555-201-3344'],
  ])('refuses a note that is %s', (_what, note) => {
    expect(() => cleanNote(note)).toThrow(DraftRefusedError);
  });
});

describe('clientMessageEmail', () => {
  it('writes "running late" with the staff member, the minutes and the time today', () => {
    const email = clientMessageEmail(details, { kind: 'running_late', minutes: 10, today: true });
    expect(email.to).toBe('maria@example.com');
    expect(email.subject).toBe('Running about 10 minutes late');
    expect(email.text).toBe(
      [
        'Hi Maria,',
        '',
        'Dre is running about 10 minutes late for your skin fade at 2:00 PM today. Sorry for the wait, see you soon.',
        '',
        'Fade Lab',
      ].join('\n'),
    );
  });

  it('names the day when the visit is not today', () => {
    const email = clientMessageEmail(details, { kind: 'running_late', minutes: 15, today: false });
    expect(email.text).toContain('for your skin fade at Wednesday, November 4 at 2:00 PM.');
  });

  it('sends the reminder email with the first name', () => {
    const email = clientMessageEmail(details, { kind: 'reminder' });
    expect(email.subject).toBe('Reminder: your booking at Fade Lab');
    expect(email.text).toMatch(/^Hi Maria,\n/);
    expect(email.text).toContain('Skin Fade with Dre, Wednesday, November 4 at 2:00 PM.');
  });

  it("sends a note in the member's words, with the visit, the AI disclosure and the business (AC-X-55)", () => {
    const disclosure = aiDisclosureLines('Fade Lab', 'https://app.example.com');
    const email = clientMessageEmail(details, {
      kind: 'note',
      note: 'Bring your photos!',
      disclosure,
    });
    expect(email.subject).toBe('A note from Fade Lab');
    expect(email.text).toBe(
      [
        'Hi Maria,',
        '',
        'Bring your photos!',
        '',
        'About your skin fade, Wednesday, November 4 at 2:00 PM.',
        '',
        'Written with help from Pepper, the AI assistant Fade Lab uses.',
        'How Pepper works and what it does with your details: https://app.example.com/privacy#ai',
        '',
        'Fade Lab',
      ].join('\n'),
    );
  });

  it('says nothing about the AI in its own words: the reminder and "running late" (AC-X-55)', () => {
    for (const email of [
      clientMessageEmail(details, { kind: 'reminder' }),
      clientMessageEmail(details, { kind: 'running_late', minutes: 10, today: true }),
    ]) {
      expect(email.text).not.toContain('Pepper');
      expect(email.text).not.toContain('/privacy');
    }
  });
});

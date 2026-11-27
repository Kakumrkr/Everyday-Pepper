import { describe, expect, it } from 'vitest';
import {
  cancelledEmail,
  codeEmail,
  confirmAskEmail,
  confirmationEmail,
  formatWhen,
  manageUrl,
  reminderEmail,
  releasedEmail,
  rescheduledEmail,
  seriesCancelledEmail,
  seriesConfirmationEmail,
  waitlistCodeEmail,
} from './emails.js';
import type { BookingEmailDetails } from './services/notices.js';

const DETAILS: BookingEmailDetails = {
  businessName: 'Juniper Hair Studio',
  slug: 'juniper',
  timeZone: 'America/New_York',
  serviceName: 'Haircut',
  staffName: 'Jess',
  startsAt: '2026-11-03T15:00:00.000Z',
  email: 'ana@example.test',
  clientName: 'Ana Ruiz',
  policy: { sentence: null, note: null },
};

describe('formatWhen', () => {
  it("renders the time in the business's time zone, never the server's", () => {
    expect(formatWhen('2026-11-03T15:00:00.000Z', 'America/New_York')).toBe(
      'Tuesday, November 3 at 10:00 AM',
    );
    expect(formatWhen('2026-11-03T15:00:00.000Z', 'America/Los_Angeles')).toBe(
      'Tuesday, November 3 at 7:00 AM',
    );
  });
});

describe('the booking page emails', () => {
  it('sends the code to the client with what it books and how long it works', () => {
    const email = codeEmail(DETAILS, '042917', 10);
    expect(email.to).toBe('ana@example.test');
    expect(email.subject).toBe('042917 is your code for Juniper Hair Studio');
    expect(email.text).toContain('    042917');
    expect(email.text).toContain('Haircut with Jess, Tuesday, November 3 at 10:00 AM.');
    expect(email.text).toContain('works for 10 minutes. Nothing is booked until you enter it.');
  });

  it('sends the code to join the waitlist for a day, nothing added before it (S38a)', () => {
    // The day begins at local midnight.
    const email = waitlistCodeEmail(
      { ...DETAILS, startsAt: '2026-11-03T05:00:00.000Z' },
      '042917',
      10,
    );
    expect(email.subject).toBe('042917 is your code for Juniper Hair Studio');
    expect(email.text).toContain('Your code to join the waitlist at Juniper Hair Studio is:');
    expect(email.text).toContain('Haircut with Jess, any time on Tuesday, November 3.');
    expect(email.text).toContain("You're not on the waitlist until you enter it.");
  });

  it('says "anyone" by leaving the staff member out', () => {
    expect(codeEmail({ ...DETAILS, staffName: null }, '042917', 10).text).toContain(
      'Haircut, Tuesday, November 3 at 10:00 AM.',
    );
  });

  it('confirms with the private link, and tells about moves and cancellations', () => {
    const link = manageUrl(
      'https://pepper.app',
      'juniper',
      'q1W2e3R4t5Y6u7I8o9P0a_S-d1F2g3H4j5K6l7Z8x9C',
    );
    expect(link).toBe(
      'https://pepper.app/book/juniper/manage#q1W2e3R4t5Y6u7I8o9P0a_S-d1F2g3H4j5K6l7Z8x9C',
    );
    expect(confirmationEmail(DETAILS, link)).toMatchObject({
      subject: "You're booked at Juniper Hair Studio",
      text: expect.stringContaining(link) as string,
    });
    expect(rescheduledEmail(DETAILS, link).text).toContain(link);
    expect(cancelledEmail(DETAILS)).toMatchObject({
      subject: 'Your booking at Juniper Hair Studio is cancelled',
    });
    expect(cancelledEmail(DETAILS).text).not.toContain('#');
  });
});

describe('the release email (S78.2, AC-X-209)', () => {
  it('is kind, says the deposit is refunded, and links the booking page', () => {
    const page = 'https://pepper.app/book/juniper';
    const email = releasedEmail(DETAILS, { refunded: true, bookingPage: page });
    expect(email.subject).toBe('Your booking at Juniper Hair Studio was released');
    expect(email.text).toContain(
      "We didn't hear back, so we've let this time go for someone else:",
    );
    expect(email.text).toContain('Your deposit is refunded in full.');
    expect(email.text).toContain(page);
    expect(email.text).not.toContain('#');
    const plain = releasedEmail(DETAILS, { refunded: false, bookingPage: null });
    expect(plain.text).not.toContain('deposit');
    expect(plain.text).toContain('We hope to see you another time.');
  });
});

describe('the ask to confirm (S78, AC-X-202, AC-X-204, AC-X-205)', () => {
  const link = 'https://pepper.app/book/juniper/manage#q1W2e3R4t5Y6u7I8o9P0a_S-d1F2g3H4j5K6l7Z8x9C';
  const asked: BookingEmailDetails = {
    ...DETAILS,
    confirmBy: '2026-11-02T15:00:00.000Z',
    askConfirm: true,
  };
  const line =
    'Please confirm by Monday, November 2 at 10:00 AM, or your time may be offered to others.';

  it('the confirmation, reminder and move ask by when, and the link confirms too', () => {
    for (const email of [
      confirmationEmail(asked, link),
      reminderEmail(asked, link),
      rescheduledEmail(asked, link),
    ]) {
      expect(email.text).toContain(line);
      expect(email.text).toContain(link);
      expect(email.text).toMatch(/To confirm, (reschedule|change it again) or cancel/);
    }
  });

  it('says nothing about confirming when the business doesn’t ask or the client confirmed', () => {
    for (const details of [DETAILS, { ...DETAILS, askConfirm: false }]) {
      expect(confirmationEmail(details, link).text).not.toContain('confirm by');
      expect(reminderEmail(details, link).text).not.toContain('To confirm');
    }
    // No link, no ask: there would be nothing to answer it with.
    expect(reminderEmail(asked).text).not.toContain('confirm by');
  });

  it('asks without a time once the time to confirm by has passed', () => {
    const late = reminderEmail({ ...asked, confirmBy: null }, link);
    expect(late.text).toContain('Please confirm your visit with the link below.');
    expect(late.text).not.toContain('confirm by');
    expect(late.text).toContain('To confirm, reschedule or cancel');
  });

  it('the early ask by email', () => {
    const email = confirmAskEmail(asked, link);
    expect(email).toMatchObject({
      to: 'ana@example.test',
      subject: 'Please confirm your booking at Juniper Hair Studio',
    });
    expect(email.text).toContain('Haircut with Jess, Tuesday, November 3 at 10:00 AM.');
    expect(email.text).toContain(line);
    expect(email.text).toContain(link);
  });
});

describe('the reminder', () => {
  it('names the booking in the business time zone and carries no link', () => {
    const email = reminderEmail(DETAILS);
    expect(email).toMatchObject({
      to: 'ana@example.test',
      subject: 'Reminder: your booking at Juniper Hair Studio',
    });
    expect(email.text).toContain('Hi Ana Ruiz,');
    expect(email.text).toContain('Haircut with Jess, Tuesday, November 3 at 10:00 AM.');
    expect(email.text).toContain('use the link in your booking confirmation email');
    expect(email.text).not.toContain('#');
    expect(email.text).not.toContain('http');
  });
});

describe('the cancellation policy and the deposit (S67.2, AC-X-133, AC-X-134)', () => {
  const policy = {
    sentence:
      'Please cancel or reschedule at least 24 hours before your visit. No-shows may be charged $20.',
    note: 'Running late? Call us.',
  };
  const withPolicy: BookingEmailDetails = { ...DETAILS, policy };
  const LINK = 'https://app.example/book/juniper/manage#t';

  it('ends the confirmation, reminder, reschedule and cancel emails with the policy', () => {
    for (const email of [
      confirmationEmail(withPolicy, LINK),
      rescheduledEmail(withPolicy, LINK),
      cancelledEmail(withPolicy),
      reminderEmail(withPolicy, LINK),
    ]) {
      expect(
        email.text.endsWith(`\n\nCancellation policy:\n${policy.sentence}\n${policy.note}`),
      ).toBe(true);
    }
  });

  it('carries the sentence or the note alone, and nothing without either', () => {
    expect(
      cancelledEmail({ ...DETAILS, policy: { sentence: null, note: policy.note } }).text,
    ).toContain(`Cancellation policy:\n${policy.note}`);
    expect(
      cancelledEmail({
        ...DETAILS,
        policy: { sentence: policy.sentence, note: null },
      }).text.endsWith(`Cancellation policy:\n${policy.sentence}`),
    ).toBe(true);
    expect(cancelledEmail(DETAILS).text).not.toContain('Cancellation policy');
    expect(confirmationEmail(DETAILS, LINK).text).not.toContain('Cancellation policy');
  });

  it('says the deposit under the booking in the team sheet’s words', () => {
    const deposit = {
      kind: 'deposit',
      amountCents: 1500,
      refundEndsAt: '2026-11-02T15:00:00.000Z',
      status: 'held',
      refundableNow: true,
    } as const;
    expect(confirmationEmail({ ...DETAILS, deposit }, LINK).text).toContain(
      'Haircut with Jess, Tuesday, November 3 at 10:00 AM.\n$15 deposit paid · refundable until Mon, Nov 2, 10:00 AM\n',
    );
    expect(
      confirmationEmail({ ...DETAILS, deposit: { ...deposit, refundableNow: false } }, LINK).text,
    ).toContain('$15 deposit paid · no longer refundable');
    expect(
      confirmationEmail(
        { ...DETAILS, deposit: { ...deposit, kind: 'card', amountCents: 0, refundEndsAt: null } },
        LINK,
      ).text,
    ).toContain('Card on file. Nothing is charged now.');
    expect(confirmationEmail({ ...DETAILS, deposit: null }, LINK).text).not.toContain('deposit');
    // Only the confirmation says it.
    expect(rescheduledEmail({ ...DETAILS, deposit }, LINK).text).not.toContain('deposit');
  });
});

describe('the series emails (S72, AC-X-185)', () => {
  const visits = [
    { startsAt: '2026-11-03T15:00:00.000Z', manageUrl: 'https://app.test/b/juniper/manage#one' },
    { startsAt: '2026-11-10T15:00:00.000Z', manageUrl: 'https://app.test/b/juniper/manage#two' },
  ];

  it('lists every visit with its own link, and the policy', () => {
    const policy = { sentence: 'Cancel at least 24 hours before.', note: null };
    const email = seriesConfirmationEmail({ ...DETAILS, policy }, visits);
    expect(email.to).toBe('ana@example.test');
    expect(email.subject).toBe("You're booked at Juniper Hair Studio: 2 visits");
    expect(email.text).toContain('for Haircut with Jess, 2 visits:');
    expect(email.text).toContain(
      'Tuesday, November 3 at 10:00 AM\nTo reschedule or cancel this visit: https://app.test/b/juniper/manage#one',
    );
    expect(email.text).toContain(
      'Tuesday, November 10 at 10:00 AM\nTo reschedule or cancel this visit: https://app.test/b/juniper/manage#two',
    );
    expect(email.text).toContain('Cancel at least 24 hours before.');
  });

  it('lists the cancelled visits, one or many', () => {
    const many = seriesCancelledEmail(DETAILS, visits);
    expect(many.subject).toBe('2 visits at Juniper Hair Studio are cancelled');
    expect(many.text).toContain(
      'Tuesday, November 3 at 10:00 AM\nTuesday, November 10 at 10:00 AM',
    );
    expect(many.text).not.toContain('manage');
    expect(seriesCancelledEmail(DETAILS, visits.slice(0, 1)).subject).toBe(
      'A visit at Juniper Hair Studio is cancelled',
    );
  });
});

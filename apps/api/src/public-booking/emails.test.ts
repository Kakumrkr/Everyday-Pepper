import type { BookingEmailDetails } from '@pepper/appointments';
import { describe, expect, it } from 'vitest';
import {
  cancelledEmail,
  codeEmail,
  confirmationEmail,
  formatWhen,
  manageUrl,
  rescheduledEmail,
} from './emails.js';

const DETAILS: BookingEmailDetails = {
  businessName: 'Juniper Hair Studio',
  timeZone: 'America/New_York',
  serviceName: 'Haircut',
  staffName: 'Jess',
  startsAt: '2026-11-03T15:00:00.000Z',
  email: 'ana@example.test',
  clientName: 'Ana Ruiz',
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

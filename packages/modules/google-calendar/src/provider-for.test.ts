import { describe, expect, it } from 'vitest';
import { GoogleCalendarProvider } from './google.js';
import { calendarProviderFor, calendarReturnUrl } from './provider-for.js';
import { SandboxCalendarProvider } from './sandbox.js';

describe('calendarProviderFor', () => {
  it("returns to the app's calendar page", () => {
    expect(calendarReturnUrl('https://app.pepper.test')).toBe(
      'https://app.pepper.test/more/calendar/google',
    );
  });

  it('makes the sandbox or Google from the settings', () => {
    expect(
      calendarProviderFor({ provider: 'sandbox' }, 'http://localhost:3000', Date.now),
    ).toBeInstanceOf(SandboxCalendarProvider);
    expect(
      calendarProviderFor(
        { provider: 'google', clientId: 'id', clientSecret: 'secret' },
        'https://app.pepper.test',
        Date.now,
      ),
    ).toBeInstanceOf(GoogleCalendarProvider);
  });
});

import { describe, expect, it } from 'vitest';
import { loadGoogleCalendarConfig } from './config.js';

// The Google Calendar settings (S70, ADR-0069 §1, AC-X-158).

const CLIENT = '123456789012-abcdefghijklmnop0123.apps.googleusercontent.com';
const SECRET = 'GOCSPX-abcdefghijklmnopqrstuvwx';

describe('loadGoogleCalendarConfig (AC-X-158)', () => {
  it('is off by default, and with an empty value', () => {
    expect(loadGoogleCalendarConfig('api', {})).toBeNull();
    expect(loadGoogleCalendarConfig('api', { GOOGLE_CALENDAR_PROVIDER: '' })).toBeNull();
    expect(
      loadGoogleCalendarConfig('api', {
        GOOGLE_CALENDAR_PROVIDER: 'off',
        GOOGLE_CLIENT_ID: CLIENT,
      }),
    ).toBeNull();
  });

  it('reads the sandbox without a client', () => {
    expect(loadGoogleCalendarConfig('worker', { GOOGLE_CALENDAR_PROVIDER: 'sandbox' })).toEqual({
      provider: 'sandbox',
    });
  });

  it('reads Google with its client', () => {
    expect(
      loadGoogleCalendarConfig('api', {
        GOOGLE_CALENDAR_PROVIDER: 'google',
        GOOGLE_CLIENT_ID: CLIENT,
        GOOGLE_CLIENT_SECRET: SECRET,
      }),
    ).toEqual({ provider: 'google', clientId: CLIENT, clientSecret: SECRET });
  });

  it('stops naming the variable, never its value', () => {
    const run = () =>
      loadGoogleCalendarConfig('api', {
        GOOGLE_CALENDAR_PROVIDER: 'google',
        GOOGLE_CLIENT_ID: CLIENT,
        GOOGLE_CLIENT_SECRET: 'short!',
      });
    expect(run).toThrow(/GOOGLE_CLIENT_SECRET/);
    expect(run).not.toThrow(/short!/);
    expect(() => loadGoogleCalendarConfig('api', { GOOGLE_CALENDAR_PROVIDER: 'google' })).toThrow(
      /GOOGLE_CLIENT_ID/,
    );
    expect(() => loadGoogleCalendarConfig('api', { GOOGLE_CALENDAR_PROVIDER: 'yes' })).toThrow(
      /GOOGLE_CALENDAR_PROVIDER/,
    );
  });
});

import { GoogleCalendarProvider } from './google.js';
import type { CalendarProvider } from './provider.js';
import { SandboxCalendarProvider } from './sandbox.js';

/** The deployment's settings, as the runtime reads them (`loadGoogleCalendarConfig`). */
export type CalendarProviderSettings =
  { provider: 'sandbox' } | { provider: 'google'; clientId: string; clientSecret: string };

/** The app's page Google sends the member back to (S70.2 builds it). */
export function calendarReturnUrl(baseUrl: string): string {
  return new URL('/more/calendar/google', baseUrl).toString();
}

/** The api's and the worker's provider, from the same settings. */
export function calendarProviderFor(
  settings: CalendarProviderSettings,
  baseUrl: string,
  now: () => number,
): CalendarProvider {
  const redirectUri = calendarReturnUrl(baseUrl);
  return settings.provider === 'sandbox'
    ? new SandboxCalendarProvider(redirectUri, now)
    : new GoogleCalendarProvider({
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
        redirectUri,
        now,
      });
}

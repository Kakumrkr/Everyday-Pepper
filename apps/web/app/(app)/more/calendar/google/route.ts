import { ROUTES } from '../../../../../lib/account';
import { finishGoogleReturn } from '../../../../../lib/calendar-connect';
import { loadWebServerEnv } from '../../../../../lib/env';

// Per request: it finishes a connect with the member's session.
export const dynamic = 'force-dynamic';

/**
 * Google's return (S70.2, AC-X-161, ADR-0069): `AUTH_BASE_URL/more/calendar/google`, the
 * redirect URI Google was given. The web server finishes the connect with the member's cookie
 * (the state binds it to the member who started it, so a link someone else made is refused),
 * then sends the browser on to More → Calendar with how it ended. A 303, so the code never
 * reaches the page's script and the return is never an entry Back can bring back.
 */
export async function GET(request: Request): Promise<Response> {
  const { API_INTERNAL_URL, AUTH_BASE_URL } = loadWebServerEnv(process.env);
  const url = new URL(request.url);
  const outcome = await finishGoogleReturn(Object.fromEntries(url.searchParams), {
    apiBaseUrl: API_INTERNAL_URL,
    origin: AUTH_BASE_URL === undefined ? url.origin : new URL(AUTH_BASE_URL).origin,
    cookie: request.headers.get('cookie'),
    forwardedFor: request.headers.get('x-forwarded-for'),
  });
  const next =
    outcome === null ? ROUTES.calendarSettings : `${ROUTES.calendarSettings}?google=${outcome}`;
  return new Response(null, {
    status: 303,
    headers: { location: next, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
}

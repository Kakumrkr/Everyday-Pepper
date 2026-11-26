import type { Metadata } from 'next';
import { googleOutcomeOf } from '../../../../lib/calendar-connect';
import { CalendarSettings } from '../../../_components/calendar-connect/calendar-settings';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Calendar · Pepper' };

/**
 * More → Calendar (S70.2, AC-X-160…162): the member's own Google Calendar; `?google=` says how
 * Google's return ended (`/more/calendar/google`, a route that finishes it on the server).
 */
export default async function CalendarSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <CalendarSettings outcome={googleOutcomeOf((await searchParams)['google'])} />;
}

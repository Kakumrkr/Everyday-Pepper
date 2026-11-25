import type { Metadata } from 'next';
import { googleArrival } from '../../../../../lib/calendar-connect';
import { CalendarSettings } from '../../../../_components/calendar-connect/calendar-settings';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Calendar · Pepper' };

/**
 * Google's return page (S70.2, AC-X-161, ADR-0069): `AUTH_BASE_URL/more/calendar/google`, the
 * redirect URI Google was given. More → Calendar with what Google sent; the panel finishes the
 * connect once and cleans the address.
 */
export default async function GoogleReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <CalendarSettings arrival={googleArrival(await searchParams)} />;
}

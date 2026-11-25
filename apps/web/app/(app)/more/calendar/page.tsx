import type { Metadata } from 'next';
import { CalendarSettings } from '../../../_components/calendar-connect/calendar-settings';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Calendar · Pepper' };

/** More → Calendar (S70.2, AC-X-160): the member's own Google Calendar. */
export default function CalendarSettingsPage() {
  return <CalendarSettings arrival={null} />;
}

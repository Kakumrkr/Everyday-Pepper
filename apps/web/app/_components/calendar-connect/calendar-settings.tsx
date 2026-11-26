import { redirect } from 'next/navigation';
import { ROUTES } from '../../../lib/account';
import type { GoogleOutcome } from '../../../lib/calendar-connect';
import { currentAccount, currentBusiness, currentCalendar } from '../../_server/account';
import { CalendarPanel } from './calendar-panel';

/**
 * More → Calendar (S70.2, AC-X-160…162, ADR-0069): the member's own Google Calendar in words,
 * with how Google's return ended when it comes from there (`outcome`).
 * Everyone who reads the calendar opens it; only the member linked to a staff member connects
 * (the api says so in `canConnect`). Off in this deployment, it goes back to More.
 */
export async function CalendarSettings({ outcome }: { outcome: GoogleOutcome | null }) {
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  if (current?.permissions.includes('calendar.read') !== true) redirect(ROUTES.more);
  const calendar = await currentCalendar();
  if (calendar.state === 'off') redirect(ROUTES.more);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 pb-24 desk:pb-0">
      <header className="flex flex-col gap-1">
        <h1 className="m-0 type-display">Calendar</h1>
        <p className="m-0 type-body text-ink-2">
          Your Google Calendar’s busy times keep clients from booking over your own plans.
        </p>
      </header>
      {calendar.state === 'unavailable' ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t load your calendar. Try again in a moment.
        </p>
      ) : (
        <CalendarPanel
          initial={calendar.answer}
          timeZone={current.business.timeZone}
          outcome={outcome}
        />
      )}
    </div>
  );
}

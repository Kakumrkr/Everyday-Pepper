import { buttonClass, Card, chipClass, Icon } from '@pepper/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../lib/account';
import {
  addDays,
  calendarHref,
  columnsFor,
  dayRange,
  dayTitle,
  formatDate,
  readCalendarParams,
  sameDate,
  todayIn,
} from '../../../lib/calendar';
import { bookableStaff, bookingAbilities, type BookingSetup } from '../../../lib/booking';
import { seesDetailsOf } from '../../../lib/calendar-data';
import { NewBooking } from '../../_components/booking/new-booking';
import { DayGrid, type CalendarColumn } from '../../_components/day-grid';
import { currentAccount, currentBusiness, currentCalendarDay } from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Calendar · Pepper' };

/**
 * The calendar's day view: one column per staff member on the business's clock. Owners and
 * managers see every booking; staff see their own in full and colleagues' as busy times
 * (AC-W9-1: the api decides what each role gets). Members who may book get "New booking" and
 * a sheet for each booking they see in full (S15).
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The app layout has sent anyone without a usable session elsewhere already.
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  if (!current?.permissions.includes('calendar.read')) redirect(ROUTES.home);

  const { timeZone } = current.business;
  const today = todayIn(timeZone, Date.now());
  const { date, staffMemberId } = readCalendarParams(await searchParams, today);
  const day = await currentCalendarDay(dayRange(timeZone, date));
  const services = new Map(day.services.map((service) => [service.id, service.name]));
  const userId = account.me.user.id;

  const columns: CalendarColumn[] = columnsFor(day.staff, staffMemberId).map((member) => {
    if (!seesDetailsOf(current.role, userId, member)) {
      return {
        member,
        entries: day.busy
          .filter((busy) => busy.staffMemberId === member.id)
          .map((busy) => ({ kind: 'busy', startsAt: busy.startsAt, endsAt: busy.endsAt })),
      };
    }
    return {
      member,
      entries: day.bookings
        .filter((booking) => booking.staffMemberId === member.id)
        .map((booking) => ({
          kind: 'booking',
          id: booking.id,
          startsAt: booking.startsAt,
          endsAt: booking.endsAt,
          service: services.get(booking.serviceId) ?? 'Appointment',
          serviceId: booking.serviceId,
          client: day.clientNames.get(booking.clientId) ?? 'Client',
          status: booking.status,
          overridden: booking.overridden,
        })),
    };
  });
  const filterable = day.staff.filter((member) => member.active);
  const abilities = bookingAbilities(current.permissions, current.role);
  const setup: BookingSetup = {
    timeZone,
    userId,
    abilities,
    services: day.services.filter((service) => service.active),
    staff: day.staff,
  };
  const books =
    abilities.books &&
    bookableStaff(day.staff, { userId, ownOnly: abilities.ownStaffOnly }).length > 0;

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0 font-display text-2xl font-bold">Calendar</h1>
          <p className="m-0 text-ink-2" data-testid="calendar-day">
            {dayTitle(date, today)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {books ? <NewBooking setup={setup} date={formatDate(date)} /> : null}
          <Link
            href={ROUTES.waitlist}
            className={buttonClass({ variant: 'secondary', size: 'sm' })}
          >
            Waitlist
          </Link>
          <nav aria-label="Day" className="flex items-center gap-1">
            <Link
              href={calendarHref(addDays(date, -1), staffMemberId)}
              aria-label="Previous day"
              className={buttonClass({ variant: 'secondary', size: 'sm', className: 'w-11 px-0' })}
            >
              <Icon name="left" />
            </Link>
            <Link
              href={calendarHref(today, staffMemberId)}
              aria-current={sameDate(date, today) ? 'date' : undefined}
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
            >
              Today
            </Link>
            <Link
              href={calendarHref(addDays(date, 1), staffMemberId)}
              aria-label="Next day"
              className={buttonClass({ variant: 'secondary', size: 'sm', className: 'w-11 px-0' })}
            >
              <Icon name="right" />
            </Link>
          </nav>
        </div>
      </header>

      {filterable.length > 1 ? (
        <nav aria-label="Staff" className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1">
          <Link
            href={calendarHref(date, null)}
            aria-current={staffMemberId === null ? 'true' : undefined}
            className={chipClass({ selected: staffMemberId === null, className: 'shrink-0' })}
          >
            Everyone
          </Link>
          {filterable.map((member) => (
            <Link
              key={member.id}
              href={calendarHref(date, member.id)}
              aria-current={staffMemberId === member.id ? 'true' : undefined}
              className={chipClass({
                selected: staffMemberId === member.id,
                className: 'shrink-0',
              })}
            >
              {member.displayName}
            </Link>
          ))}
        </nav>
      ) : null}

      {day.failed ? (
        <p role="alert" className="mb-4 rounded-md bg-wait-soft px-4 py-3 font-semibold text-wait">
          I couldn’t load everything for this day. Try again in a moment.
        </p>
      ) : null}
      {day.truncated ? (
        <p className="mb-4 rounded-md bg-info-soft px-4 py-3 text-info">
          This day has more appointments than I can show at once; pick one staff member to see
          theirs.
        </p>
      ) : null}

      {columns.length === 0 ? (
        <Card>
          <h2 className="m-0 font-display text-lg font-bold">No one to show yet</h2>
          <p className="mt-1 mb-0 text-ink-2">
            {day.staff.length === 0
              ? 'Once your team and services are set up, their appointments show here.'
              : 'There is no one on the calendar for this filter.'}
          </p>
        </Card>
      ) : (
        <DayGrid
          timeZone={timeZone}
          date={date}
          columns={columns}
          now={sameDate(date, today) ? new Date().toISOString() : null}
          setup={books ? setup : null}
        />
      )}
    </div>
  );
}

import { EmptyState, Icon } from '@pepper/ui';
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
import { seesDetailsOf, visitClient } from '../../../lib/calendar-data';
import { NewBooking } from '../../_components/booking/new-booking';
import { ARROW_LINK, DAY_LINK, SEGMENT, ViewSwitch } from '../../_components/calendar/calendar-nav';
import { DayGrid, type CalendarColumn } from '../../_components/day-grid';
import { kitLink } from '../../_components/kit-link';
import { weekRange } from '../../../lib/calendar-week';
import { ownStaffMember } from '../../../lib/my-week';
import {
  currentAccount,
  currentBusiness,
  currentCalendarDay,
  currentCalendarWeek,
} from '../../_server/account';
import { MyWeek, myWeekHref } from './my-week';
import { WeekCalendar } from './week-calendar';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Calendar · Pepper' };

/**
 * The calendar: a day of everyone, or one staff member's week (`?view=week`, S69:
 * `WeekCalendar`). The day view: one column per staff member on the business's clock. Owners and
 * managers see every booking; staff see their own in full and colleagues' as busy times
 * (AC-W9-1: the api decides what each role gets). Members who may book get "New booking" and
 * a sheet for each booking they see in full (S15). On the kit (S42): the day's title and its
 * buttons, the staff filter as a segmented track, the staff tones on the grid, and empty days
 * that say what to do next (AC-X-7).
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
  const userId = account.me.user.id;
  // Staff open on their own week (S72.2, AC-X-189); a member linked to no staff member sees Day.
  const { date, staffMemberId, view } = readCalendarParams(
    await searchParams,
    today,
    current.role === 'staff' ? 'my-week' : 'day',
  );
  if (view === 'my-week') {
    const week = await currentCalendarWeek(weekRange(timeZone, date), (staff) =>
      ownStaffMember(staff, userId),
    );
    const { member } = week;
    if (member !== null) {
      return (
        <MyWeek
          current={current}
          userId={userId}
          date={date}
          today={today}
          week={{ ...week, member }}
        />
      );
    }
  }
  if (view === 'week') {
    return (
      <WeekCalendar
        current={current}
        userId={account.me.user.id}
        date={date}
        today={today}
        staffMemberId={staffMemberId}
      />
    );
  }
  const day = await currentCalendarDay(dayRange(timeZone, date));
  const services = new Map(day.services.map((service) => [service.id, service.name]));

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
          ...visitClient(day.clientNames.get(booking.clientId), booking.clientId),
          status: booking.status,
          overridden: booking.overridden,
          clientConfirmedAt: booking.clientConfirmedAt ?? null,
          clientConfirmedVia: booking.clientConfirmedVia ?? null,
          seriesId: booking.seriesId ?? null,
          visit: day.visits.get(booking.id) ?? null,
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
  const manageStaff = current.permissions.includes('staff.manage');
  const quiet = !day.failed && columns.every((column) => column.entries.length === 0);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 type-display">Calendar</h1>
          <p className="m-0 type-label text-ink-2 tabular-nums" data-testid="calendar-day">
            {dayTitle(date, today)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ViewSwitch
            view="day"
            hrefs={{
              day: calendarHref(date, staffMemberId),
              week: calendarHref(date, staffMemberId, 'week'),
              'my-week': myWeekHref(ownStaffMember(day.staff, userId) !== null, date),
            }}
          />
          {books ? <NewBooking setup={setup} date={formatDate(date)} /> : null}
          <Link href={ROUTES.waitlist} className={DAY_LINK}>
            Waitlist
          </Link>
          <nav aria-label="Day" className="flex items-center gap-1">
            <Link
              href={calendarHref(addDays(date, -1), staffMemberId)}
              aria-label="Previous day"
              className={ARROW_LINK}
            >
              <Icon name="left" />
            </Link>
            <Link
              href={calendarHref(today, staffMemberId)}
              aria-current={sameDate(date, today) ? 'date' : undefined}
              className={DAY_LINK}
            >
              Today
            </Link>
            <Link
              href={calendarHref(addDays(date, 1), staffMemberId)}
              aria-label="Next day"
              className={ARROW_LINK}
            >
              <Icon name="right" />
            </Link>
          </nav>
        </div>
      </header>

      {filterable.length > 1 ? (
        <nav aria-label="Staff" className="-mx-5 overflow-x-auto px-5 pb-1">
          <div className="inline-flex gap-1 rounded-pill bg-surface-2 p-1">
            <Link
              href={calendarHref(date, null)}
              aria-current={staffMemberId === null ? 'true' : undefined}
              className={SEGMENT}
            >
              Everyone
            </Link>
            {filterable.map((member) => (
              <Link
                key={member.id}
                href={calendarHref(date, member.id)}
                aria-current={staffMemberId === member.id ? 'true' : undefined}
                className={SEGMENT}
              >
                {member.displayName}
              </Link>
            ))}
          </div>
        </nav>
      ) : null}

      {day.failed ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t load everything for this day. Try again in a moment.
        </p>
      ) : null}
      {day.truncated ? (
        <p className="m-0 rounded-md bg-info-soft px-4 py-3 type-label text-info">
          This day has more appointments than I can show at once; pick one staff member to see
          theirs.
        </p>
      ) : null}

      {columns.length === 0 ? (
        // A failed load already said so above: no call to add a team that may exist.
        day.failed ? null : staffMemberId === null ? (
          <EmptyState
            icon="team"
            title={day.staff.length === 0 ? 'No one on the calendar yet' : 'No one is on today'}
            body={
              day.staff.length > 0
                ? 'Everyone on your team is switched off. Turn someone back on in Team.'
                : manageStaff
                  ? 'Add yourself and your team, and everyone’s appointments show here.'
                  : 'Once the owner adds the team, everyone’s appointments show here.'
            }
            action={
              manageStaff
                ? {
                    label: day.staff.length === 0 ? 'Add your team' : 'Open Team',
                    href: ROUTES.team,
                    renderLink: kitLink,
                  }
                : { label: 'Back to Home', href: ROUTES.home, renderLink: kitLink }
            }
          />
        ) : (
          <EmptyState
            icon="calendar"
            title="No one to show here"
            body="This staff member isn’t on the calendar any more."
            action={{ label: 'Show everyone', href: calendarHref(date, null), renderLink: kitLink }}
          />
        )
      ) : (
        <>
          {quiet ? (
            <p className="m-0 type-body text-ink-2" data-testid="calendar-quiet">
              {books
                ? 'Nothing booked this day yet. Tap New booking to add one.'
                : 'Nothing booked this day yet.'}
            </p>
          ) : null}
          <DayGrid
            timeZone={timeZone}
            date={date}
            columns={columns}
            staff={filterable}
            now={sameDate(date, today) ? new Date().toISOString() : null}
            setup={books ? setup : null}
          />
        </>
      )}
    </div>
  );
}

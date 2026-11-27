import type { CivilDate, CurrentBusinessResponse } from '@pepper/contracts';
import { EmptyState, Icon } from '@pepper/ui';
import Link from 'next/link';
import { ROUTES } from '../../../lib/account';
import { bookableStaff, bookingAbilities, type BookingSetup } from '../../../lib/booking';
import { addDays, calendarHref, formatDate, staffTone } from '../../../lib/calendar';
import { seesDetailsOf, visitClient } from '../../../lib/calendar-data';
import {
  notWorking,
  weekDates,
  weekRange,
  weekStaffMember,
  weekStart,
  weekTitle,
  workingSpans,
} from '../../../lib/calendar-week';
import { NewBooking } from '../../_components/booking/new-booking';
import { ARROW_LINK, DAY_LINK, SEGMENT, ViewSwitch } from '../../_components/calendar/calendar-nav';
import { WeekGrid } from '../../_components/calendar/week-grid';
import type { CalendarEntry } from '../../_components/day-grid';
import { kitLink } from '../../_components/kit-link';
import { STAFF_TONE_CLASSES } from '../../_components/staff-tone';
import { ownStaffMember } from '../../../lib/my-week';
import { currentCalendarWeek } from '../../_server/account';
import { myWeekHref } from './my-week';

/**
 * The calendar's week view (S69, AC-X-144…151): one staff member's Monday to Sunday, staff on
 * their own first, owners and managers on the first active member. A colleague's week shows
 * busy times only (AC-X-145); the member's own bookings (owners and managers: anyone's) open
 * their sheet and drag to a new time.
 */
export async function WeekCalendar({
  current,
  userId,
  date,
  today,
  staffMemberId,
}: {
  current: CurrentBusinessResponse;
  userId: string;
  date: CivilDate;
  today: CivilDate;
  staffMemberId: string | null;
}) {
  const { timeZone } = current.business;
  const viewer = { role: current.role, userId };
  const week = await currentCalendarWeek(weekRange(timeZone, date), (staff) =>
    weekStaffMember(staff, staffMemberId, viewer),
  );
  const { member } = week;
  const dates = weekDates(date);
  const services = new Map(week.services.map((service) => [service.id, service.name]));
  const filterable = week.staff.filter((one) => one.active);
  const abilities = bookingAbilities(current.permissions, current.role);
  const setup: BookingSetup = {
    timeZone,
    userId,
    abilities,
    services: week.services.filter((service) => service.active),
    staff: week.staff,
  };
  const books =
    abilities.books &&
    bookableStaff(week.staff, { userId, ownOnly: abilities.ownStaffOnly }).length > 0;
  const details = member !== null && seesDetailsOf(current.role, userId, member);
  const entries: CalendarEntry[] =
    member === null
      ? []
      : details
        ? week.bookings
            .filter((booking) => booking.staffMemberId === member.id)
            .map((booking) => ({
              kind: 'booking',
              id: booking.id,
              startsAt: booking.startsAt,
              endsAt: booking.endsAt,
              service: services.get(booking.serviceId) ?? 'Appointment',
              serviceId: booking.serviceId,
              ...visitClient(week.clientNames.get(booking.clientId), booking.clientId),
              status: booking.status,
              overridden: booking.overridden,
              clientConfirmedAt: booking.clientConfirmedAt ?? null,
              clientConfirmedVia: booking.clientConfirmedVia ?? null,
              seriesId: booking.seriesId ?? null,
              keptOverGoogle: week.kept.has(booking.id),
              visit: week.visits.get(booking.id) ?? null,
            }))
        : week.busy
            .filter((busy) => busy.staffMemberId === member.id)
            .map((busy) => ({ kind: 'busy', startsAt: busy.startsAt, endsAt: busy.endsAt }));
  const memberId = member?.id ?? null;
  const thisWeek = formatDate(weekStart(date)) === formatDate(weekStart(today));
  const manageStaff = current.permissions.includes('staff.manage');

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 type-display">Calendar</h1>
          <p className="m-0 type-label text-ink-2 tabular-nums" data-testid="calendar-week">
            {weekTitle(date, today)}
            {member === null ? null : <span className="text-ink-3"> · {member.displayName}</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ViewSwitch
            view="week"
            hrefs={{
              day: calendarHref(thisWeek ? today : weekStart(date), memberId),
              week: calendarHref(date, memberId, 'week'),
              'my-week': myWeekHref(ownStaffMember(week.staff, userId) !== null, date),
            }}
          />
          {books ? (
            <NewBooking setup={setup} date={formatDate(thisWeek ? today : weekStart(date))} />
          ) : null}
          <Link href={ROUTES.waitlist} className={DAY_LINK}>
            Waitlist
          </Link>
          <nav aria-label="Week" className="flex items-center gap-1">
            <Link
              href={calendarHref(addDays(date, -7), memberId, 'week')}
              aria-label="Previous week"
              className={ARROW_LINK}
            >
              <Icon name="left" />
            </Link>
            <Link
              href={calendarHref(today, memberId, 'week')}
              aria-current={thisWeek ? 'date' : undefined}
              className={DAY_LINK}
            >
              This week
            </Link>
            <Link
              href={calendarHref(addDays(date, 7), memberId, 'week')}
              aria-label="Next week"
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
            {filterable.map((one) => (
              <Link
                key={one.id}
                href={calendarHref(date, one.id, 'week')}
                aria-current={memberId === one.id ? 'true' : undefined}
                className={SEGMENT}
              >
                {one.displayName}
              </Link>
            ))}
          </div>
        </nav>
      ) : null}

      {week.failed ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t load everything for this week. Try again in a moment.
        </p>
      ) : null}
      {week.truncated ? (
        <p className="m-0 rounded-md bg-info-soft px-4 py-3 type-label text-info">
          This week has more appointments than I can show at once; the day view shows each day in
          full.
        </p>
      ) : null}

      {member === null ? (
        week.failed ? null : (
          <EmptyState
            icon="team"
            title={
              week.staff.length === 0 ? 'No one on the calendar yet' : 'No one is on this week'
            }
            body={
              week.staff.length > 0
                ? 'Everyone on your team is switched off. Turn someone back on in Team.'
                : manageStaff
                  ? 'Add yourself and your team, and everyone’s appointments show here.'
                  : 'Once the owner adds the team, everyone’s appointments show here.'
            }
            action={
              manageStaff
                ? {
                    label: week.staff.length === 0 ? 'Add your team' : 'Open Team',
                    href: ROUTES.team,
                    renderLink: kitLink,
                  }
                : { label: 'Back to Home', href: ROUTES.home, renderLink: kitLink }
            }
          />
        )
      ) : (
        <>
          {!week.failed && entries.length === 0 ? (
            <p className="m-0 type-body text-ink-2" data-testid="calendar-quiet">
              {books && details
                ? 'Nothing booked this week yet. Tap New booking to add one.'
                : 'Nothing booked this week yet.'}
            </p>
          ) : null}
          {details && books ? (
            <p className="m-0 type-caption text-ink-2">
              Drag a booking to move it (on a phone, press and hold first). Shaded hours are outside{' '}
              {member.userId === userId ? 'your' : `${member.displayName}’s`} working hours
              {week.outside.length > 0 ? ' or busy in Google Calendar' : ''}.
            </p>
          ) : null}
          <WeekGrid
            timeZone={timeZone}
            dates={dates}
            member={member}
            tone={STAFF_TONE_CLASSES[staffTone(filterable, member.id)].block}
            entries={entries}
            off={notWorking(timeZone, dates, week.hours, week.timeOff)}
            outside={week.outside}
            working={week.hours === null ? [] : workingSpans(timeZone, dates, week.hours)}
            now={new Date().toISOString()}
            setup={books && details ? setup : null}
            movable={books && details}
          />
        </>
      )}
    </div>
  );
}

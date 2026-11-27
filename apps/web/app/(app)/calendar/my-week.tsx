import type { CivilDate, CurrentBusinessResponse } from '@pepper/contracts';
import { cx, Icon } from '@pepper/ui';
import Link from 'next/link';
import {
  bookableStaff,
  bookingAbilities,
  bookingBlockName,
  confirmedByText,
  STATUS_LABELS,
  type BookingSetup,
} from '../../../lib/booking';
import {
  addDays,
  calendarHref,
  formatDate,
  sameDate,
  staffTone,
  timeRange,
} from '../../../lib/calendar';
import { KEPT_OVER_GOOGLE } from '../../../lib/calendar-connect';
import { visitClient, type CalendarWeek } from '../../../lib/calendar-data';
import { weekDates, weekdayHeading, weekStart, weekTitle } from '../../../lib/calendar-week';
import { myWeekDays, myWeekSummary } from '../../../lib/my-week';
import { BookingSheet, type BookingSummary } from '../../_components/booking/booking-sheet';
import { NewBooking } from '../../_components/booking/new-booking';
import { ARROW_LINK, DAY_LINK, ViewSwitch } from '../../_components/calendar/calendar-nav';
import { STAFF_TONE_CLASSES } from '../../_components/staff-tone';

/**
 * "My week" (S72.2, AC-X-189…194): the member's own Monday to Sunday as a list for a phone, day
 * by day: when they work or that they're off, time off and Google busy times, then their visits,
 * each opening its booking sheet, with a series visit's "2/8". The page loads the week with the
 * week view's loader for the member's own staff member, so it shows only what is theirs.
 */
export function MyWeek({
  current,
  userId,
  date,
  today,
  week,
}: {
  current: CurrentBusinessResponse;
  userId: string;
  date: CivilDate;
  today: CivilDate;
  /** Loaded for the member's own staff member (never `null` here). */
  week: CalendarWeek & { member: NonNullable<CalendarWeek['member']> };
}) {
  const { timeZone } = current.business;
  const { member } = week;
  const services = new Map(week.services.map((service) => [service.id, service.name]));
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
  const visits: (BookingSummary & { kind: 'booking' })[] = week.bookings
    .filter((booking) => booking.staffMemberId === member.id)
    .map((booking) => ({
      kind: 'booking',
      id: booking.id,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      service: services.get(booking.serviceId) ?? 'Appointment',
      serviceId: booking.serviceId,
      staffMemberId: booking.staffMemberId,
      ...visitClient(week.clientNames.get(booking.clientId), booking.clientId),
      status: booking.status,
      overridden: booking.overridden,
      clientConfirmedAt: booking.clientConfirmedAt ?? null,
      clientConfirmedVia: booking.clientConfirmedVia ?? null,
      seriesId: booking.seriesId ?? null,
      keptOverGoogle: week.kept.has(booking.id),
      visit: week.visits.get(booking.id) ?? null,
    }));
  const days = myWeekDays(timeZone, weekDates(date), {
    visits,
    hours: week.hours,
    timeOff: week.timeOff,
    outside: week.outside,
  });
  const thisWeek = formatDate(weekStart(date)) === formatDate(weekStart(today));
  const tone =
    STAFF_TONE_CLASSES[
      staffTone(
        week.staff.filter((one) => one.active),
        member.id,
      )
    ].block;
  const empty = !week.failed && visits.length === 0;

  return (
    <div className="mx-auto flex w-full max-w-2xl min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="m-0 type-display">My week</h1>
          <p className="m-0 type-label text-ink-2 tabular-nums" data-testid="calendar-week">
            {weekTitle(date, today)}
          </p>
          {week.failed ? null : (
            <p className="m-0 type-label text-ink tabular-nums" data-testid="my-week-summary">
              {myWeekSummary(days)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ViewSwitch
            view="my-week"
            hrefs={{
              day: calendarHref(thisWeek ? today : weekStart(date), null),
              week: calendarHref(date, member.id, 'week'),
              'my-week': calendarHref(date, null, 'my-week'),
            }}
          />
          {books ? (
            <NewBooking setup={setup} date={formatDate(thisWeek ? today : weekStart(date))} />
          ) : null}
          <nav aria-label="Week" className="flex items-center gap-1">
            <Link
              href={calendarHref(addDays(date, -7), null, 'my-week')}
              aria-label="Previous week"
              className={ARROW_LINK}
            >
              <Icon name="left" />
            </Link>
            <Link
              href={calendarHref(today, null, 'my-week')}
              aria-current={thisWeek ? 'date' : undefined}
              className={DAY_LINK}
            >
              This week
            </Link>
            <Link
              href={calendarHref(addDays(date, 7), null, 'my-week')}
              aria-label="Next week"
              className={ARROW_LINK}
            >
              <Icon name="right" />
            </Link>
          </nav>
        </div>
      </header>

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
      {empty ? (
        <p className="m-0 type-body text-ink-2" data-testid="calendar-quiet">
          {books
            ? 'Nothing booked this week yet. Tap New booking to add one.'
            : 'Nothing booked this week yet.'}
        </p>
      ) : null}

      <ol className="m-0 flex list-none flex-col gap-5 p-0" aria-label="Days">
        {days.map((day) => {
          const heading = weekdayHeading(day.date);
          const isToday = sameDate(day.date, today);
          const hours =
            day.working.length === 0
              ? null
              : day.working
                  .map((span) => timeRange(timeZone, span.startsAt, span.endsAt))
                  .join(', ');
          return (
            <li
              key={formatDate(day.date)}
              className="flex min-w-0 flex-col gap-2"
              data-testid="my-week-day"
              aria-current={isToday ? 'date' : undefined}
            >
              <div className="flex min-w-0 items-center justify-between gap-3 border-0 border-b border-solid border-line">
                <h2 className="m-0 flex min-w-0 items-center gap-2 type-subheading">
                  <Link
                    href={calendarHref(day.date, null)}
                    className="inline-flex min-h-11 min-w-0 items-center truncate text-ink no-underline hover:underline"
                    aria-label={`${heading.full}, open the day`}
                  >
                    {heading.weekday} {heading.day}
                  </Link>
                  {isToday ? (
                    <span className="shrink-0 rounded-pill bg-brand-soft px-2 type-caption text-brand">
                      Today
                    </span>
                  ) : null}
                </h2>
                <span
                  className={cx(
                    'shrink-0 type-caption tabular-nums',
                    day.off ? 'font-semibold text-ink-2' : 'text-ink-2',
                  )}
                  data-testid="my-week-hours"
                >
                  {day.off ? 'Off' : hours}
                </span>
              </div>
              {day.timeOff.length > 0 && !day.off ? (
                <p className="m-0 type-caption text-ink-2 tabular-nums">
                  Time off{' '}
                  {day.timeOff
                    .map((span) => timeRange(timeZone, span.startsAt, span.endsAt))
                    .join(', ')}
                </p>
              ) : null}
              {day.outside.length > 0 ? (
                <p
                  className="m-0 type-caption text-ink-2 tabular-nums"
                  data-testid="my-week-google"
                >
                  Busy in Google Calendar{' '}
                  {day.outside
                    .map((span) => timeRange(timeZone, span.startsAt, span.endsAt))
                    .join(', ')}
                </p>
              ) : null}
              {day.visits.length === 0 ? (
                day.off || week.failed ? null : (
                  <p className="m-0 type-caption text-ink-3">
                    {day.working.length > 0 ? 'Free' : 'Nothing booked'}
                  </p>
                )
              ) : (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {day.visits.map((visit) => (
                    <li key={visit.id} className="min-w-0">
                      <VisitRow
                        visit={visit}
                        setup={books ? setup : null}
                        timeZone={timeZone}
                        tone={tone}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** One visit on My week: when, who, what and its marks; opens its sheet when the member books. */
function VisitRow({
  visit,
  setup,
  timeZone,
  tone,
}: {
  visit: BookingSummary;
  setup: BookingSetup | null;
  timeZone: string;
  tone: string;
}) {
  const confirmed = confirmedByText(visit) !== null;
  const status = visit.status === 'confirmed' ? null : STATUS_LABELS[visit.status];
  const className = cx(
    'flex min-h-11 w-full min-w-0 items-center gap-3 rounded-md border-0 border-l-4 border-solid px-3 py-2 text-left text-ink',
    tone,
    visit.status === 'no_show' && 'opacity-70',
  );
  const content = (
    <>
      <span className="w-20 shrink-0 type-caption text-ink-2 tabular-nums">
        {timeRange(timeZone, visit.startsAt, visit.endsAt)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1 type-label font-semibold">
          <span className="truncate">{visit.client}</span>
          {confirmed ? <Icon name="check" className="size-3 shrink-0 text-ok" /> : null}
        </span>
        <span className="truncate type-caption text-ink-2">
          {visit.service}
          {status === null ? '' : ` · ${status}`}
        </span>
      </span>
      {visit.visit ? (
        <span
          className="shrink-0 rounded-pill bg-surface px-2 type-caption tabular-nums text-ink-2"
          aria-hidden="true"
          data-testid="booking-visit-number"
        >
          {visit.visit.number}/{visit.visit.of}
        </span>
      ) : null}
      {visit.keptOverGoogle === true ? (
        <span
          className="size-2 shrink-0 rounded-full bg-info"
          title={KEPT_OVER_GOOGLE}
          data-testid="booking-kept-mark"
        />
      ) : null}
    </>
  );
  if (setup !== null) {
    return (
      <BookingSheet booking={visit} setup={setup} className={className} style={{}}>
        {content}
      </BookingSheet>
    );
  }
  return (
    <article
      data-testid="booking-block"
      aria-label={bookingBlockName(timeZone, visit)}
      className={className}
    >
      {content}
    </article>
  );
}

/** The link into My week for members linked to a staff member; `null` for everyone else. */
export function myWeekHref(linked: boolean, date: CivilDate): string | null {
  return linked ? calendarHref(date, null, 'my-week') : null;
}

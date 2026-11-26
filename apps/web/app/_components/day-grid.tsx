import type { BookingStatus, CivilDate, StaffMember } from '@pepper/contracts';
import { cx, Icon } from '@pepper/ui';
import { bookingBlockName, confirmedByText, type BookingSetup } from '../../lib/booking';
import type { VisitPlace } from '../../lib/calendar-data';
import { KEPT_OVER_GOOGLE } from '../../lib/calendar-connect';
import { hourLabel, layoutDay, staffTone, timeRange } from '../../lib/calendar';
import { STAFF_TONE_CLASSES } from './staff-tone';
import { BookingSheet } from './booking/booking-sheet';

export type CalendarEntry =
  | {
      kind: 'booking';
      id: string;
      startsAt: string;
      endsAt: string;
      service: string;
      serviceId: string;
      client: string;
      /** The client's profile; `null` for a deleted client (S50.2) or one not found. */
      clientId: string | null;
      status: BookingStatus;
      overridden: boolean;
      /** When the client replied C to a reminder (S62); `null` until then, or once moved. */
      clientConfirmedAt: string | null;
      /** The series of recurring visits it is part of (S72); `null`: a single booking. */
      seriesId?: string | null;
      /** Pepper kept it over a change made in Google lately (S72 top-up, AC-X-188). */
      keptOverGoogle?: boolean;
      /** Its place in its series, "2 of 8" (S72.2 top-up, AC-X-194); absent outside one. */
      visit?: VisitPlace | null;
    }
  | { kind: 'busy'; startsAt: string; endsAt: string };

export interface CalendarColumn {
  member: StaffMember;
  entries: CalendarEntry[];
}

/**
 * Pixels per hour of the grid: a 30-minute appointment is 44 px, the smallest tap target (D3,
 * S42); a 15-minute one is 22 px, the one exception.
 */
const HOUR_HEIGHT = 88;

const STATUS_LABELS: Partial<Record<BookingStatus, string>> = {
  completed: 'Done',
  no_show: 'No-show',
};

/**
 * One day on a time grid, a column per staff member; the hours fit every entry (8 am – 8 pm at
 * least). Two columns fit a 375 px phone; more scroll sideways inside the grid, the page never.
 * With `setup` (the member may book), a booking opens its sheet when tapped. Each staff member
 * has a tone from `staff` (the whole team, so a filtered view keeps it) and their name on top.
 */
export function DayGrid({
  timeZone,
  date,
  columns,
  staff,
  now,
  setup = null,
}: {
  timeZone: string;
  date: CivilDate;
  columns: CalendarColumn[];
  /** The business's active staff, in order: their tones (so visible columns differ). */
  staff: readonly StaffMember[];
  /** The current instant when the day is today (draws the now-line). */
  now: string | null;
  setup?: BookingSetup | null;
}) {
  // One layout for every entry (and the now-line), so all columns share the grid's hours.
  const placed = [
    ...columns.flatMap(({ entries }, column) =>
      entries.map((entry) => ({ startsAt: entry.startsAt, endsAt: entry.endsAt, column, entry })),
    ),
    ...(now === null ? [] : [{ startsAt: now, endsAt: now, column: -1, entry: null }]),
  ];
  const grid = layoutDay(timeZone, date, placed);
  const height = (grid.hours.length * HOUR_HEIGHT).toString();
  const nowTop = grid.blocks.find((block) => block.item.entry === null)?.top;

  return (
    <div
      className="overflow-x-auto rounded-lg border border-line bg-surface"
      data-testid="day-grid"
    >
      <div className="flex min-w-fit">
        <div className="w-12 shrink-0 border-r border-line" aria-hidden="true">
          <div className="h-12 border-b border-line" />
          <div className="relative" style={{ height: `${height}px` }}>
            {grid.hours.map((minute, index) => (
              <span
                key={minute}
                className="absolute right-2 -translate-y-1/2 type-caption text-ink-3 tabular-nums first:translate-y-0"
                style={{ top: `${(index * HOUR_HEIGHT).toString()}px` }}
              >
                {index === 0 ? '' : hourLabel(minute)}
              </span>
            ))}
          </div>
        </div>
        {columns.map(({ member, entries }, column) => {
          const tone = STAFF_TONE_CLASSES[staffTone(staff, member.id)];
          return (
            <section
              key={member.id}
              aria-label={member.displayName}
              data-testid="calendar-column"
              className="min-w-34 flex-1 border-r border-line last:border-r-0"
            >
              <h2 className="m-0 flex h-12 items-center gap-2 border-b border-line px-3 type-label text-ink">
                <span
                  aria-hidden="true"
                  className={cx('size-2.5 shrink-0 rounded-pill', tone.dot)}
                />
                <span className="truncate">{member.displayName}</span>
              </h2>
              <div className="relative" style={{ height: `${height}px` }}>
                {grid.hours.slice(1).map((minute, index) => (
                  <div
                    key={minute}
                    aria-hidden="true"
                    className="absolute inset-x-0 border-t border-line"
                    style={{ top: `${((index + 1) * HOUR_HEIGHT).toString()}px` }}
                  />
                ))}
                {entries.length === 0 ? <p className="sr-only">Nothing booked</p> : null}
                {grid.blocks.flatMap(({ item, top, height: tall }) =>
                  item.column !== column || item.entry === null
                    ? []
                    : [
                        <CalendarBlock
                          key={`${item.startsAt}-${item.entry.kind === 'booking' ? item.entry.id : 'busy'}`}
                          entry={item.entry}
                          staffMemberId={member.id}
                          setup={setup}
                          timeZone={timeZone}
                          tone={tone.block}
                          top={top}
                          height={tall}
                        />,
                      ],
                )}
                {nowTop === undefined ? null : (
                  <div
                    aria-hidden="true"
                    data-testid="now-line"
                    className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-danger"
                    style={{ top: `${nowTop.toString()}%` }}
                  />
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One entry on a time grid (the day view's, and the week view's, S69): a colleague's busy time,
 * a booking that opens its sheet when the member may book, or a booking to read.
 */
export function CalendarBlock({
  entry,
  staffMemberId,
  setup,
  timeZone,
  tone,
  top,
  height,
  className: extra,
}: {
  entry: CalendarEntry;
  staffMemberId: string;
  setup: BookingSetup | null;
  timeZone: string;
  /** The staff member's block classes. */
  tone: string;
  top: number;
  height: number;
  /** More classes for the block (the week view dims one being dragged). */
  className?: string | undefined;
}) {
  const time = timeRange(timeZone, entry.startsAt, entry.endsAt);
  // "2/8" leads the second line, so a narrow column keeps the client's name whole; the block's
  // name says "visit 2 of 8" (AC-X-194).
  const visit =
    entry.kind === 'booking' && entry.visit ? (
      <span
        className="mr-1 rounded-pill bg-surface px-1 tabular-nums text-ink-2"
        aria-hidden="true"
        data-testid="booking-visit-number"
      >
        {entry.visit.number}/{entry.visit.of}
      </span>
    ) : null;
  const position = { top: `${top.toString()}%`, height: `${height.toString()}%` };
  if (entry.kind === 'busy') {
    return (
      <div
        data-testid="busy-block"
        aria-label={`Busy, ${time}`}
        role="note"
        className="absolute inset-x-1 overflow-hidden rounded-sm border border-dashed border-line-strong bg-surface-2 px-2 py-1 type-caption text-ink-2"
        style={position}
      >
        Busy
      </div>
    );
  }
  const status = STATUS_LABELS[entry.status];
  const confirmed = confirmedByText(entry) !== null;
  // From 45 minutes (66 px) the service gets a line of its own.
  const roomy = Date.parse(entry.endsAt) - Date.parse(entry.startsAt) >= 45 * 60_000;
  const className = cx(
    'absolute inset-x-1 overflow-hidden rounded-sm border-0 border-l-4 border-solid px-2 py-1 text-left type-caption leading-tight text-ink',
    tone,
    entry.status === 'no_show' && 'opacity-70',
    extra,
  );
  const style = position;
  const content = (
    <>
      <span className="flex items-center gap-1 font-semibold">
        <span className="truncate">{entry.client}</span>
        {confirmed ? (
          // A 30-minute block has room for two lines only: the tick shows it; the block's name says it.
          <Icon name="check" className="size-3 shrink-0 text-ok" />
        ) : null}
        {entry.keptOverGoogle === true ? (
          // The sheet's words on hover; the block's name says them to a screen reader, and a tap
          // opens the sheet, which says them too (AC-X-180).
          <span
            className="ml-auto size-2 shrink-0 rounded-full bg-info"
            title={KEPT_OVER_GOOGLE}
            data-testid="booking-kept-mark"
          />
        ) : null}
      </span>
      {roomy ? (
        <>
          <span className="block truncate">
            {visit}
            {entry.service}
          </span>
          <span className="block truncate text-ink-2 tabular-nums">{time}</span>
        </>
      ) : (
        // Two lines fit a 30-minute block (44 px): who, then when and what.
        <span className="block truncate text-ink-2">
          {visit}
          <span className="tabular-nums">{time}</span> · {entry.service}
        </span>
      )}
      {status === undefined ? null : <span className="block font-semibold">{status}</span>}
      {confirmed ? (
        <span className={roomy ? 'block truncate text-ok' : 'sr-only'}>Confirmed by text</span>
      ) : null}
      {entry.overridden ? <span className="block text-warn">Outside the usual hours</span> : null}
    </>
  );
  if (setup !== null) {
    return (
      <BookingSheet
        booking={{ ...entry, staffMemberId }}
        setup={setup}
        className={className}
        style={style}
      >
        {content}
      </BookingSheet>
    );
  }
  return (
    <article
      data-testid="booking-block"
      aria-label={bookingBlockName(timeZone, entry)}
      className={className}
      style={style}
    >
      {content}
    </article>
  );
}

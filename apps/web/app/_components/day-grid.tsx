import type { BookingStatus, CivilDate, StaffMember } from '@floty/contracts';
import { cx } from '@floty/ui';
import { hourLabel, layoutDay, timeRange } from '../../lib/calendar';

export type CalendarEntry =
  | {
      kind: 'booking';
      id: string;
      startsAt: string;
      endsAt: string;
      service: string;
      client: string;
      status: BookingStatus;
      overridden: boolean;
    }
  | { kind: 'busy'; startsAt: string; endsAt: string };

export interface CalendarColumn {
  member: StaffMember;
  entries: CalendarEntry[];
}

/** Pixels per hour of the grid: a 15-minute appointment is 16 px, a 1-hour one 64 px. */
const HOUR_HEIGHT = 64;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const STATUS_LABELS: Partial<Record<BookingStatus, string>> = {
  completed: 'Done',
  no_show: 'No-show',
};

/**
 * One day on a time grid, a column per staff member; the hours fit every entry (8 am – 8 pm at
 * least). Columns scroll sideways inside the grid on narrow screens; the page itself never does.
 */
export function DayGrid({
  timeZone,
  date,
  columns,
  now,
}: {
  timeZone: string;
  date: CivilDate;
  columns: CalendarColumn[];
  /** The current instant when the day is today (draws the now-line). */
  now: string | null;
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
        <div className="w-14 shrink-0 border-r border-line" aria-hidden="true">
          <div className="h-12 border-b border-line" />
          <div className="relative" style={{ height: `${height}px` }}>
            {grid.hours.map((minute, index) => (
              <span
                key={minute}
                className="absolute right-2 -translate-y-1/2 text-xs text-ink-2 first:translate-y-0"
                style={{ top: `${(index * HOUR_HEIGHT).toString()}px` }}
              >
                {index === 0 ? '' : hourLabel(minute)}
              </span>
            ))}
          </div>
        </div>
        {columns.map(({ member, entries }, column) => (
          <section
            key={member.id}
            aria-label={member.displayName}
            data-testid="calendar-column"
            className="min-w-40 flex-1 border-r border-line last:border-r-0"
          >
            <h2 className="flex h-12 items-center gap-2 border-b border-line px-3 text-sm font-bold">
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-full"
                style={{ background: HEX_COLOR.test(member.color) ? member.color : 'var(--brand)' }}
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
                      <Entry
                        key={`${item.startsAt}-${item.entry.kind === 'booking' ? item.entry.id : 'busy'}`}
                        entry={item.entry}
                        timeZone={timeZone}
                        color={HEX_COLOR.test(member.color) ? member.color : null}
                        top={top}
                        height={tall}
                      />,
                    ],
              )}
              {nowTop === undefined ? null : (
                <div
                  aria-hidden="true"
                  data-testid="now-line"
                  className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-brand"
                  style={{ top: `${nowTop.toString()}%` }}
                />
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function Entry({
  entry,
  timeZone,
  color,
  top,
  height,
}: {
  entry: CalendarEntry;
  timeZone: string;
  color: string | null;
  top: number;
  height: number;
}) {
  const time = timeRange(timeZone, entry.startsAt, entry.endsAt);
  const position = { top: `${top.toString()}%`, height: `${height.toString()}%` };
  if (entry.kind === 'busy') {
    return (
      <div
        data-testid="busy-block"
        aria-label={`Busy, ${time}`}
        role="note"
        className="absolute inset-x-1 overflow-hidden rounded-sm border border-dashed border-line bg-surface-2 px-2 py-1 text-xs text-ink-2"
        style={position}
      >
        Busy
      </div>
    );
  }
  const status = STATUS_LABELS[entry.status];
  return (
    <article
      data-testid="booking-block"
      aria-label={`${time}, ${entry.service} with ${entry.client}`}
      className={cx(
        'absolute inset-x-1 overflow-hidden rounded-sm border-l-4 bg-brand-soft px-2 py-1 text-xs leading-tight text-ink',
        entry.status === 'no_show' && 'opacity-70',
      )}
      style={{ ...position, borderLeftColor: color ?? 'var(--brand)' }}
    >
      <p className="m-0 truncate font-bold">{entry.client}</p>
      <p className="m-0 truncate">{entry.service}</p>
      <p className="m-0 truncate text-ink-2">{time}</p>
      {status === undefined ? null : <p className="m-0 font-semibold">{status}</p>}
      {entry.overridden ? <p className="m-0 text-wait">Outside the usual hours</p> : null}
    </article>
  );
}

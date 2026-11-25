'use client';

import { formatDate, type CivilDate, type StaffMember } from '@pepper/contracts';
import { cx, Receipt } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { dateTimeLabel, timeLabel, type BookingSetup } from '../../../lib/booking';
import { hourLabel, todayIn, type Timed } from '../../../lib/calendar';
import {
  clampStart,
  DROP_PROBLEM_WORDS,
  dropLabel,
  dropProblem,
  layoutWeek,
  lineAt,
  minuteAt,
  startAt,
  weekdayHeading,
  type DropProblem,
} from '../../../lib/calendar-week';
import { CalendarBlock, type CalendarEntry } from '../day-grid';
import { MoveConfirm, sendMove, type MadeMove, type PendingMove } from './move-confirm';

/** Pixels per hour, as on the day view: a 30-minute appointment is 44 px (D3). */
const HOUR_HEIGHT = 88;
/** How long a finger rests on a booking before it lifts to drag (a swipe still scrolls). */
const LONG_PRESS_MS = 450;
/** How far a finger may wander during the press, and a mouse before a drag starts, in px. */
const TOUCH_SLOP = 8;
const MOUSE_SLOP = 4;
/** How near the grid's sides a drag scrolls it sideways, and by how much per move, in px. */
const EDGE = 40;
const EDGE_STEP = 12;
/** How long Undo stays on a moved booking's receipt. */
const UNDO_MS = 5 * 60_000;

type BookingEntry = Extract<CalendarEntry, { kind: 'booking' }>;

interface Target {
  day: number;
  minute: number;
  startsAt: string;
  endsAt: string;
  problem: DropProblem | null;
}

interface Drag {
  entry: BookingEntry;
  pointerId: number;
  touch: boolean;
  x: number;
  y: number;
  /** Where on the block it was taken, in px from its top: the block doesn't jump. */
  grab: number;
  active: boolean;
  target: Target | null;
  timer: number | null;
}

interface Done {
  made: MadeMove;
  undoUntil: number | null;
  back: boolean;
}

/**
 * One staff member's week on a time grid (S69, AC-X-144…151): a column per day, Monday first,
 * their not-working hours shaded. A booking the member may move drags with a mouse, or after a
 * long press on touch, in 15-minute steps; while it moves it says where it would land and
 * whether that looks free. A drop asks once (MoveConfirm) and the api decides; the receipt has
 * Undo. Keyboard and screen-reader users move a booking from its sheet, as on the day view.
 */
export function WeekGrid({
  timeZone,
  dates,
  member,
  tone,
  entries,
  off,
  working,
  now,
  setup,
  movable,
}: {
  timeZone: string;
  dates: CivilDate[];
  member: StaffMember;
  /** The member's block classes. */
  tone: string;
  entries: CalendarEntry[];
  /** When they aren't working, per day: shaded, and a hint for a drop. */
  off: Timed[][];
  /** Their working hours as instants: the grid fits them. */
  working: Timed[];
  /** The current instant (from the server: the now-line and today's column). */
  now: string;
  setup: BookingSetup | null;
  /** Whether the member may move these bookings (their own, or anyone's for owners). */
  movable: boolean;
}) {
  const router = useRouter();
  const scroller = useRef<HTMLDivElement>(null);
  const bodies = useRef<(HTMLDivElement | null)[]>([]);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const [shown, setShown] = useState<Drag | null>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const offFlat = useMemo(() => off.flat(), [off]);
  const layout = useMemo(
    () => layoutWeek(timeZone, dates, entries, working, offFlat),
    [timeZone, dates, entries, working, offFlat],
  );
  const height = layout.hours.length * HOUR_HEIGHT;
  const length = layout.endMinute - layout.startMinute;
  const today = formatDate(todayIn(timeZone, Date.parse(now)));
  const todayIndex = dates.findIndex((date) => formatDate(date) === today);
  const todayDate = dates[todayIndex];
  const nowTop = todayDate === undefined ? null : lineAt(timeZone, todayDate, now, layout);
  const bookings = useMemo(
    () => entries.filter((entry): entry is BookingEntry => entry.kind === 'booking'),
    [entries],
  );
  const staffName = (id: string) =>
    setup?.staff.find((one) => one.id === id)?.displayName ?? member.displayName;

  // Today in view on a phone, where the week scrolls sideways (AC-X-144).
  useEffect(() => {
    const box = scroller.current;
    const column = bodies.current[todayIndex]?.parentElement;
    if (box === null || column === null || column === undefined || todayIndex <= 0) return;
    box.scrollLeft = column.offsetLeft - (bodies.current[0]?.parentElement?.offsetLeft ?? 0);
  }, [todayIndex]);

  // The receipt's Undo goes by itself after five minutes.
  useEffect(() => {
    const until = done?.undoUntil ?? null;
    if (done === null || until === null) return;
    const timer = window.setTimeout(() => {
      setDone((current) => (current === done ? { ...done, undoUntil: null } : current));
    }, until - Date.now());
    return () => {
      window.clearTimeout(timer);
    };
  }, [done]);

  const targetAt = useCallback(
    (entry: BookingEntry, x: number, y: number, grab: number): Target | null => {
      const rects = bodies.current.map((body) => body?.getBoundingClientRect() ?? null);
      let day = rects.findIndex((rect) => rect !== null && x >= rect.left && x < rect.right);
      if (day < 0) day = x < (rects[0]?.left ?? 0) ? 0 : rects.length - 1;
      const rect = rects[day];
      const date = dates[day];
      if (rect === null || rect === undefined || date === undefined) return null;
      const minutes = Math.round((Date.parse(entry.endsAt) - Date.parse(entry.startsAt)) / 60_000);
      const minute = clampStart(
        minuteAt((y - grab - rect.top) / rect.height, layout.startMinute, layout.endMinute),
        minutes,
        layout.startMinute,
        layout.endMinute,
      );
      const startsAt = startAt(timeZone, date, minute);
      const endsAt = new Date(Date.parse(startsAt) + minutes * 60_000).toISOString();
      return {
        day,
        minute,
        startsAt,
        endsAt,
        problem: dropProblem(
          { startsAt, endsAt },
          {
            bookings: bookings.filter((other) => other.id !== entry.id),
            off: offFlat,
            now: Date.now(),
          },
        ),
      };
    },
    [bookings, dates, layout.endMinute, layout.startMinute, offFlat, timeZone],
  );

  const stop = useCallback(() => {
    const current = drag.current;
    if (current?.timer !== null && current?.timer !== undefined) window.clearTimeout(current.timer);
    drag.current = null;
    setShown(null);
  }, []);

  const activate = useCallback(
    (current: Drag) => {
      current.active = true;
      current.target = targetAt(current.entry, current.x, current.y, current.grab);
      setShown({ ...current });
    },
    [targetAt],
  );

  // While a booking is pressed or dragged: the pointer anywhere on the page, and Escape.
  useEffect(() => {
    function move(event: PointerEvent) {
      const current = drag.current;
      if (current?.pointerId !== event.pointerId) return;
      const far = Math.hypot(event.clientX - current.x, event.clientY - current.y);
      if (!current.active) {
        if (current.touch) {
          // A swipe before the press is done: the page scrolls, nothing drags.
          if (far > TOUCH_SLOP) stop();
          return;
        }
        if (far <= MOUSE_SLOP) return;
        activate(current);
      }
      current.x = event.clientX;
      current.y = event.clientY;
      const box = scroller.current;
      if (box !== null) {
        const rect = box.getBoundingClientRect();
        if (event.clientX < rect.left + EDGE) box.scrollLeft -= EDGE_STEP;
        else if (event.clientX > rect.right - EDGE) box.scrollLeft += EDGE_STEP;
      }
      const target = targetAt(current.entry, event.clientX, event.clientY, current.grab);
      if (
        target !== null &&
        (target.startsAt !== current.target?.startsAt || target.problem !== current.target.problem)
      ) {
        current.target = target;
        setShown({ ...current });
      }
    }
    function up(event: PointerEvent) {
      const current = drag.current;
      if (current?.pointerId !== event.pointerId) return;
      if (current.active) {
        suppressClick.current = true;
        window.setTimeout(() => {
          suppressClick.current = false;
        }, 0);
        const target = current.target;
        const { entry } = current;
        if (target !== null && target.startsAt !== entry.startsAt) {
          setPending({
            kind: 'move',
            bookingId: entry.id,
            client: entry.client,
            service: entry.service,
            from: { startsAt: entry.startsAt, endsAt: entry.endsAt, staffMemberId: member.id },
            to: { startsAt: target.startsAt, endsAt: target.endsAt, staffMemberId: member.id },
            problem: target.problem,
          });
        }
      }
      stop();
    }
    function cancel(event: PointerEvent) {
      if (drag.current?.pointerId === event.pointerId) stop();
    }
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape' && drag.current?.active === true) {
        event.preventDefault();
        suppressClick.current = true;
        stop();
        window.setTimeout(() => {
          suppressClick.current = false;
        }, 0);
      }
    }
    // A finger that lifted a booking moves it, not the page (non-passive, so it can say no).
    function touchMove(event: TouchEvent) {
      if (drag.current?.active === true) event.preventDefault();
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
    const box = scroller.current;
    box?.addEventListener('touchmove', touchMove, { passive: false });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
      box?.removeEventListener('touchmove', touchMove);
    };
  }, [activate, member.id, stop, targetAt]);

  function press(entry: BookingEntry, event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || drag.current !== null) return;
    const block = (event.target as HTMLElement).closest('[data-testid="booking-block"]');
    const top = block?.getBoundingClientRect().top ?? event.clientY;
    const touch = event.pointerType !== 'mouse';
    const current: Drag = {
      entry,
      pointerId: event.pointerId,
      touch,
      x: event.clientX,
      y: event.clientY,
      grab: event.clientY - top,
      active: false,
      target: null,
      timer: null,
    };
    if (touch) {
      current.timer = window.setTimeout(() => {
        if (drag.current === current) activate(current);
      }, LONG_PRESS_MS);
    }
    drag.current = current;
  }

  async function undo(made: MadeMove) {
    const { move } = made;
    const back: PendingMove = {
      kind: 'undo',
      bookingId: move.bookingId,
      client: move.client,
      service: move.service,
      from: {
        startsAt: made.startsAt,
        endsAt: new Date(
          Date.parse(made.startsAt) + Date.parse(move.from.endsAt) - Date.parse(move.from.startsAt),
        ).toISOString(),
        staffMemberId: made.staffMemberId,
      },
      to: move.from,
      problem: null,
    };
    // Told of the move: ask whether to tell them of the way back. Not told: straight back.
    if (made.notified) {
      setPending(back);
      return;
    }
    setDone(null);
    const answer = await sendMove(move.bookingId, {
      startsAt: move.from.startsAt,
      staffMemberId: move.from.staffMemberId,
      notifyClient: false,
    });
    if (answer.ok) {
      setDone({
        made: {
          move: back,
          startsAt: move.from.startsAt,
          staffMemberId: move.from.staffMemberId,
          notified: false,
        },
        undoUntil: null,
        back: true,
      });
      router.refresh();
      return;
    }
    if (answer.refused !== null) setPending({ ...back, refused: answer.refused });
    else setProblem(answer.message);
  }

  const live =
    shown?.active === true && shown.target !== null
      ? `${dropLabel(timeZone, shown.target.startsAt)}${shown.target.problem === null ? '' : `, ${DROP_PROBLEM_WORDS[shown.target.problem]}`}`
      : '';

  return (
    <div className="flex flex-col gap-3">
      {done === null ? null : (
        <div data-testid="move-receipt">
          <Receipt
            undo={
              done.undoUntil === null
                ? undefined
                : {
                    onUndo: () => void undo(done.made),
                    until: timeLabel(timeZone, new Date(done.undoUntil).toISOString()),
                  }
            }
          >
            {done.back
              ? `${done.made.move.client} is back at `
              : `Moved ${done.made.move.client} to `}
            <span className="tabular-nums">{dateTimeLabel(timeZone, done.made.startsAt)}</span>
            {done.made.notified ? ', and emailed them.' : '.'}
          </Receipt>
        </div>
      )}
      {problem === null ? null : (
        <p role="alert" className="m-0 rounded-md bg-danger-soft px-4 py-3 type-label text-danger">
          {problem}
        </p>
      )}
      <p className="sr-only" aria-live="polite" data-testid="drag-live">
        {live}
      </p>
      <div
        ref={scroller}
        className="overflow-x-auto rounded-lg border border-line bg-surface"
        data-testid="week-grid"
      >
        <div className="flex min-w-fit">
          <div
            className="sticky left-0 z-20 w-12 shrink-0 border-r border-line bg-surface"
            aria-hidden="true"
          >
            <div className="h-14 border-b border-line" />
            <div className="relative" style={{ height: `${String(height)}px` }}>
              {layout.hours.map((minute, index) => (
                <span
                  key={minute}
                  className="absolute right-2 -translate-y-1/2 type-caption text-ink-3 tabular-nums first:translate-y-0"
                  style={{ top: `${String(index * HOUR_HEIGHT)}px` }}
                >
                  {index === 0 ? '' : hourLabel(minute)}
                </span>
              ))}
            </div>
          </div>
          {layout.days.map((day, index) => {
            const heading = weekdayHeading(day.date);
            const isToday = index === todayIndex;
            const ghost =
              shown?.active === true && shown.target?.day === index ? shown.target : null;
            return (
              <section
                key={formatDate(day.date)}
                aria-label={heading.full}
                data-testid="week-day"
                data-date={formatDate(day.date)}
                className="min-w-23 flex-1 border-r border-line last:border-r-0"
              >
                <h2
                  className="m-0 flex h-14 flex-col items-center justify-center border-b border-line type-label text-ink-2"
                  {...(isToday && { 'aria-current': 'date' as const })}
                >
                  <span className="type-caption">{heading.weekday}</span>
                  <span
                    className={cx(
                      'inline-flex size-7 items-center justify-center rounded-pill tabular-nums',
                      isToday ? 'bg-brand text-brand-ink' : 'text-ink',
                    )}
                  >
                    {heading.day}
                  </span>
                </h2>
                <div
                  ref={(element) => {
                    bodies.current[index] = element;
                  }}
                  className="relative"
                  style={{ height: `${String(height)}px` }}
                >
                  {day.shade.map((shade) => (
                    <div
                      key={`${String(shade.top)}-${String(shade.height)}`}
                      aria-hidden="true"
                      data-testid="off-hours"
                      className="absolute inset-x-0 bg-surface-2"
                      style={{ top: `${String(shade.top)}%`, height: `${String(shade.height)}%` }}
                    />
                  ))}
                  {layout.hours.slice(1).map((minute, line) => (
                    <div
                      key={minute}
                      aria-hidden="true"
                      className="absolute inset-x-0 border-t border-line"
                      style={{ top: `${String((line + 1) * HOUR_HEIGHT)}px` }}
                    />
                  ))}
                  {day.blocks.length === 0 ? <p className="sr-only">Nothing booked</p> : null}
                  {day.blocks.map(({ item, top, height: tall }) => {
                    const block = (
                      <CalendarBlock
                        entry={item}
                        staffMemberId={member.id}
                        setup={setup}
                        timeZone={timeZone}
                        tone={tone}
                        top={top}
                        height={tall}
                        className={cx(
                          item.kind === 'booking' &&
                            shown?.active === true &&
                            shown.entry.id === item.id &&
                            'opacity-40',
                          item.kind === 'booking' &&
                            canDrag(item, movable, setup) &&
                            'select-none [-webkit-touch-callout:none]',
                        )}
                      />
                    );
                    const key = `${item.startsAt}-${item.kind === 'booking' ? item.id : 'busy'}`;
                    if (item.kind !== 'booking' || !canDrag(item, movable, setup)) {
                      return (
                        <div key={key} className="contents">
                          {block}
                        </div>
                      );
                    }
                    return (
                      <div
                        key={key}
                        className="contents"
                        data-draggable="true"
                        onPointerDown={(event) => {
                          press(item, event);
                        }}
                        onContextMenu={(event) => {
                          // The long press lifts the booking; no menu on top of it.
                          if (drag.current !== null) event.preventDefault();
                        }}
                        onClickCapture={(event) => {
                          // A drag that ended here is not a tap: no sheet.
                          if (suppressClick.current) {
                            event.preventDefault();
                            event.stopPropagation();
                          }
                        }}
                      >
                        {block}
                      </div>
                    );
                  })}
                  {ghost === null || shown === null ? null : (
                    <div
                      aria-hidden="true"
                      data-testid="drag-ghost"
                      data-problem={ghost.problem ?? ''}
                      className={cx(
                        'pointer-events-none absolute inset-x-1 z-30 overflow-hidden rounded-sm border-2 px-2 py-1 type-caption leading-tight shadow-floating',
                        ghost.problem === null
                          ? 'border-brand bg-surface text-ink'
                          : 'border-danger bg-danger-soft text-danger',
                      )}
                      style={{
                        top: `${String(((ghost.minute - layout.startMinute) / length) * 100)}%`,
                        height: `${String(((Date.parse(ghost.endsAt) - Date.parse(ghost.startsAt)) / 60_000 / length) * 100)}%`,
                      }}
                    >
                      <span className="block font-semibold tabular-nums">
                        {dropLabel(timeZone, ghost.startsAt)}
                      </span>
                      <span className="block truncate">
                        {ghost.problem === null
                          ? shown.entry.client
                          : DROP_PROBLEM_WORDS[ghost.problem]}
                      </span>
                    </div>
                  )}
                  {isToday && nowTop !== null ? (
                    <div
                      aria-hidden="true"
                      data-testid="now-line"
                      className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-danger"
                      style={{ top: `${String(nowTop)}%` }}
                    />
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      </div>
      <MoveConfirm
        pending={pending}
        timeZone={timeZone}
        staffName={staffName}
        onClose={() => {
          setPending(null);
        }}
        onMoved={(made) => {
          setPending(null);
          setProblem(null);
          setDone(
            made.move.kind === 'undo'
              ? { made, undoUntil: null, back: true }
              : { made, undoUntil: Date.now() + UNDO_MS, back: false },
          );
          router.refresh();
        }}
      />
    </div>
  );
}

/** Whether a booking drags: one the member may move (confirmed; staff, their own week). */
function canDrag(entry: BookingEntry, movable: boolean, setup: BookingSetup | null): boolean {
  return movable && setup !== null && entry.status === 'confirmed';
}

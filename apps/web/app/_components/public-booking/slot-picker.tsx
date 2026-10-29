'use client';

import { AvailabilityResponseSchema, parseDate, type AvailableSlot } from '@pepper/contracts';
import { Button, chipStyle, cx, FOCUS_RING, Skeleton } from '@pepper/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { timeLabel } from '../../../lib/booking';
import { fetchJson } from '../../../lib/client-api';
import {
  firstFreeDay,
  localTimeLabel,
  publicAvailabilityPath,
  publicRangePath,
  upcomingDays,
} from '../../../lib/public-booking';

type Slots =
  | { state: 'loading' }
  | { state: 'ready'; slots: AvailableSlot[] }
  | { state: 'failed'; message: string };

/**
 * Picks a free start time: a strip of the next two weeks, then the times the business offers
 * that day (`GET …/availability`), with who takes each one when the client chose anyone. It
 * opens on the first day with a free time (S46, AC-W8-4): one request over the whole strip per
 * service and staff choice, then the chosen day's times. A day the client taps wins over that
 * search, and a late answer never replaces a newer one. A failed load offers "Try again" for
 * the same day (AC-W8-5); the choices made before the picker stay with the page.
 */
export function SlotPicker({
  slug,
  timeZone,
  now,
  serviceId,
  staffMemberId,
  staffNames,
  onPick,
  onWaitlist,
}: {
  slug: string;
  timeZone: string;
  /** The server's clock when the page was made, so both renders show the same days. */
  now: number;
  serviceId: string;
  /** `null`: anyone. */
  staffMemberId: string | null;
  staffNames: ReadonlyMap<string, string>;
  onPick: (slot: AvailableSlot) => void;
  /** "Join the waitlist" for a day with nothing free (S38a); absent: not offered. */
  onWaitlist?: (day: { date: string; label: string }) => void;
}) {
  const days = upcomingDays(timeZone, now);
  const [date, setDate] = useState(days[0]?.date ?? '');
  // Until the strip-wide search answers (or the client taps a day), no day is loaded.
  const [searching, setSearching] = useState(true);
  // The whole strip has nothing free: said once, above the day's own (empty) times.
  const [rangeEmpty, setRangeEmpty] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The client tapped a day since this search started: its answer no longer moves the strip.
  const picked = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const [slots, setSlots] = useState<Slots>({ state: 'loading' });
  const dayLabel = days.find((day) => day.date === date)?.label ?? date;
  const timesId = useId();
  const firstDate = days[0]?.date ?? '';
  const lastDate = days.at(-1)?.date ?? '';

  useEffect(() => {
    let current = true;
    picked.current = false;
    setSearching(true);
    setRangeEmpty(false);
    const strip = upcomingDays(timeZone, now);
    const path = publicRangePath(slug, timeZone, strip, { serviceId, staffMemberId });
    if (path === null) {
      setSearching(false);
      return;
    }
    void fetchJson(path, AvailabilityResponseSchema).then((answer) => {
      if (!current) return;
      // A failed search proves nothing: the strip stays on today and loads it.
      const found = answer.ok
        ? firstFreeDay(answer.data, timeZone, strip)
        : ({ kind: 'unknown' } as const);
      if (found.kind === 'day' && !picked.current) setDate(found.date);
      if (found.kind === 'none') setRangeEmpty(true);
      setSearching(false);
    });
    return () => {
      current = false;
    };
  }, [slug, timeZone, now, serviceId, staffMemberId, firstDate, lastDate]);

  useEffect(() => {
    if (date === '' || searching) return;
    let current = true;
    setSlots({ state: 'loading' });
    void fetchJson(
      publicAvailabilityPath(slug, timeZone, parseDate(date), { serviceId, staffMemberId }),
      AvailabilityResponseSchema,
    ).then((answer) => {
      if (!current) return;
      setSlots(
        answer.ok
          ? { state: 'ready', slots: answer.data.slots }
          : { state: 'failed', message: answer.message },
      );
    });
    return () => {
      current = false;
    };
  }, [slug, timeZone, serviceId, staffMemberId, date, searching, attempt]);

  const loading = searching || slots.state === 'loading';

  return (
    <div className="flex flex-col gap-5">
      <div role="group" aria-label="Day" className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1">
        {days.map((day) => {
          const selected = day.date === date;
          return (
            <button
              key={day.date}
              type="button"
              aria-pressed={selected}
              aria-label={day.label}
              className={cx(
                'flex min-h-11 min-w-16 shrink-0 flex-col items-center justify-center rounded-md border px-3 py-2 font-normal tabular-nums',
                'transition motion-fast ease-standard',
                selected
                  ? 'border-brand bg-brand text-brand-ink'
                  : 'border-line-strong bg-surface text-ink hover:bg-surface-2',
                FOCUS_RING,
              )}
              onClick={() => {
                // The client's own choice: the strip-wide search no longer moves the day.
                picked.current = true;
                setDate(day.date);
                setSearching(false);
              }}
            >
              <span className="type-caption">{day.weekday}</span>
              <span className="type-subheading">{day.day}</span>
              <span className="type-caption">{day.month}</span>
            </button>
          );
        })}
      </div>
      <section aria-labelledby={timesId} className="flex flex-col gap-3">
        <h2
          id={timesId}
          ref={heading}
          tabIndex={-1}
          className="m-0 type-label text-ink-2 outline-none"
        >
          Times on {dayLabel}
        </h2>
        {rangeEmpty ? (
          <p className="m-0 type-body text-ink-2" data-testid="range-empty">
            No free times in the next two weeks.
            {onWaitlist === undefined ? null : ' Join the waitlist and I’ll tell you if one opens.'}
          </p>
        ) : null}
        {loading ? (
          <div
            role="status"
            className="grid grid-cols-[repeat(auto-fill,minmax(--spacing(26),1fr))] gap-2"
          >
            <span className="sr-only">Looking for free times…</span>
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <Skeleton key={n} className="h-11 rounded-md" />
            ))}
          </div>
        ) : slots.state === 'failed' ? (
          <div className="flex flex-col items-start gap-3 rounded-md bg-warn-soft px-4 py-3">
            <p className="m-0 type-body font-semibold text-warn" role="alert">
              I couldn’t load the times for {dayLabel}.{' '}
              <span className="font-normal">{slots.message}</span>
            </p>
            <Button
              variant="secondary"
              onClick={() => {
                // The button goes while the times load: focus stays on what it reloads.
                heading.current?.focus();
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </div>
        ) : slots.slots.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-lg bg-surface-2 px-5 py-6">
            <p className="m-0 type-body text-ink">
              {rangeEmpty ? 'Nothing free that day.' : 'Nothing free that day. Try another day.'}
            </p>
            {onWaitlist === undefined ? null : (
              <Button
                variant="secondary"
                onClick={() => {
                  onWaitlist({ date, label: dayLabel });
                }}
              >
                Join the waitlist for {dayLabel}
              </Button>
            )}
          </div>
        ) : (
          <div
            className="grid grid-cols-[repeat(auto-fill,minmax(--spacing(26),1fr))] gap-2"
            data-testid="free-times"
          >
            {slots.slots.map((slot) => (
              <button
                key={`${slot.startsAt}-${slot.staffMemberId}`}
                type="button"
                className={cx(
                  chipStyle(false),
                  'flex min-w-0 flex-col items-center justify-center',
                )}
                onClick={() => {
                  onPick(slot);
                }}
              >
                <span className="whitespace-nowrap">{timeLabel(timeZone, slot.startsAt)}</span>
                {staffMemberId === null ? (
                  <span className="w-full truncate type-caption font-normal text-ink-2">
                    with {staffNames.get(slot.staffMemberId) ?? 'staff'}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </section>
      <p className="m-0 type-caption text-ink-2">Times are in {localTimeLabel(timeZone)}.</p>
    </div>
  );
}

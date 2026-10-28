'use client';

import { AvailabilityResponseSchema, parseDate, type AvailableSlot } from '@pepper/contracts';
import { Button, chipStyle, cx, FOCUS_RING, Skeleton } from '@pepper/ui';
import { useEffect, useId, useState } from 'react';
import { timeLabel } from '../../../lib/booking';
import { fetchJson } from '../../../lib/client-api';
import { localTimeLabel, publicAvailabilityPath, upcomingDays } from '../../../lib/public-booking';

type Slots =
  | { state: 'loading' }
  | { state: 'ready'; slots: AvailableSlot[] }
  | { state: 'failed'; message: string };

/**
 * Picks a free start time: a strip of the next two weeks, then the times the business offers
 * that day (`GET …/availability`), with who takes each one when the client chose anyone.
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
  const [slots, setSlots] = useState<Slots>({ state: 'loading' });
  const dayLabel = days.find((day) => day.date === date)?.label ?? date;
  const timesId = useId();

  useEffect(() => {
    if (date === '') return;
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
  }, [slug, timeZone, serviceId, staffMemberId, date]);

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
                setDate(day.date);
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
        <h2 id={timesId} className="m-0 type-label text-ink-2">
          Times on {dayLabel}
        </h2>
        {slots.state === 'loading' ? (
          <div role="status" className="grid grid-cols-2 gap-2 min-[400px]:grid-cols-3">
            <span className="sr-only">Looking for free times…</span>
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <Skeleton key={n} className="h-11 rounded-md" />
            ))}
          </div>
        ) : slots.state === 'failed' ? (
          <p
            className="m-0 rounded-md bg-warn-soft px-4 py-3 type-body font-semibold text-warn"
            role="alert"
          >
            {slots.message}
          </p>
        ) : slots.slots.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-lg bg-surface-2 px-5 py-6">
            <p className="m-0 type-body text-ink">Nothing free that day. Try another day.</p>
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
          <div className="grid grid-cols-2 gap-2 min-[400px]:grid-cols-3" data-testid="free-times">
            {slots.slots.map((slot) => (
              <button
                key={`${slot.startsAt}-${slot.staffMemberId}`}
                type="button"
                className={cx(
                  chipStyle(false),
                  'flex flex-col items-center justify-center whitespace-nowrap',
                )}
                onClick={() => {
                  onPick(slot);
                }}
              >
                <span>{timeLabel(timeZone, slot.startsAt)}</span>
                {staffMemberId === null ? (
                  <span className="type-caption font-normal text-ink-2">
                    with {staffNames.get(slot.staffMemberId) ?? 'staff'}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </section>
      <p className="m-0 type-caption text-ink-2">Times are {localTimeLabel(timeZone)}.</p>
    </div>
  );
}

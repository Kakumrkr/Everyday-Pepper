'use client';

import { AvailabilityResponseSchema, parseDate, type AvailableSlot } from '@pepper/contracts';
import { chipClass } from '@pepper/ui';
import { useEffect, useId, useState } from 'react';
import { timeLabel } from '../../../lib/booking';
import { fetchJson } from '../../../lib/client-api';
import { publicAvailabilityPath, upcomingDays } from '../../../lib/public-booking';

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
    <div className="grid gap-4">
      <div role="group" aria-label="Day" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {days.map((day) => (
          <button
            key={day.date}
            type="button"
            aria-pressed={day.date === date}
            aria-label={day.label}
            className={chipClass({
              selected: day.date === date,
              className: 'min-w-16 shrink-0 flex-col justify-center gap-0 rounded-md px-3 py-2',
            })}
            onClick={() => {
              setDate(day.date);
            }}
          >
            <span className="text-xs font-semibold">{day.weekday}</span>
            <span className="text-lg font-bold text-ink">{day.day}</span>
            <span className="text-xs">{day.month}</span>
          </button>
        ))}
      </div>
      <section aria-labelledby={timesId} className="grid gap-2">
        <h2 id={timesId} className="m-0 text-base font-semibold">
          Times on {dayLabel}
        </h2>
        {slots.state === 'loading' ? (
          <p className="m-0 text-ink-2" role="status">
            Looking for free times…
          </p>
        ) : slots.state === 'failed' ? (
          <p className="m-0 font-semibold text-wait" role="alert">
            {slots.message}
          </p>
        ) : slots.slots.length === 0 ? (
          <p className="m-0 text-ink-2">Nothing free that day. Try another day.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2" data-testid="free-times">
            {slots.slots.map((slot) => (
              <button
                key={`${slot.startsAt}-${slot.staffMemberId}`}
                type="button"
                className={chipClass({
                  className: 'flex-col justify-center gap-0 rounded-md py-2',
                })}
                onClick={() => {
                  onPick(slot);
                }}
              >
                <span className="font-bold text-ink">{timeLabel(timeZone, slot.startsAt)}</span>
                {staffMemberId === null ? (
                  <span className="text-xs">
                    with {staffNames.get(slot.staffMemberId) ?? 'staff'}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </section>
      <p className="m-0 text-sm text-ink-2">Times are in the business’s time zone ({timeZone}).</p>
    </div>
  );
}

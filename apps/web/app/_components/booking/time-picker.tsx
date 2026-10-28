'use client';

import { AvailabilityResponseSchema, formatDate, type AvailableSlot } from '@pepper/contracts';
import { Input, TimeChip } from '@pepper/ui';
import { useEffect, useId, useState } from 'react';
import { availabilityPath, instantAt, timeLabel } from '../../../lib/booking';
import { readDate } from '../../../lib/calendar';
import { fetchJson } from '../../../lib/client-api';

type Slots =
  | { state: 'loading' }
  | { state: 'ready'; slots: AvailableSlot[] }
  | { state: 'failed'; message: string };

/**
 * Picks a start time on one local day: the free times the engine offers for the service and
 * staff member (`GET /v1/availability`), or any other time typed in (the api then checks it
 * and offers the nearest free times instead, AC-W2-1).
 */
export function TimePicker({
  timeZone,
  serviceId,
  staffMemberId,
  date,
  onDateChange,
  value,
  onChange,
}: {
  timeZone: string;
  serviceId: string;
  staffMemberId: string;
  /** The local day, `YYYY-MM-DD`. */
  date: string;
  onDateChange: (date: string) => void;
  /** The chosen start (UTC ISO), or `null`. */
  value: string | null;
  onChange: (startsAt: string | null) => void;
}) {
  const [slots, setSlots] = useState<Slots>({ state: 'loading' });
  const [otherTime, setOtherTime] = useState('');
  const headingId = useId();
  const day = readDate(date);

  useEffect(() => {
    const local = readDate(date);
    if (local === null || serviceId === '' || staffMemberId === '') return;
    let current = true;
    setSlots({ state: 'loading' });
    void fetchJson(
      availabilityPath(timeZone, local, { serviceId, staffMemberId }),
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
  }, [timeZone, serviceId, staffMemberId, date]);

  function chooseOther(time: string): void {
    setOtherTime(time);
    onChange(day === null ? null : instantAt(timeZone, day, time));
  }

  return (
    <div className="grid gap-3">
      <Input
        label="Day"
        type="date"
        name="date"
        required
        value={date}
        onChange={(event) => {
          onDateChange(event.target.value);
          setOtherTime('');
          onChange(null);
        }}
      />
      <section aria-labelledby={headingId} className="grid gap-2">
        <h3 id={headingId} className="m-0 type-label text-ink">
          Free times
        </h3>
        {day === null ? (
          <p className="m-0 type-body text-ink-2">Pick a day first.</p>
        ) : slots.state === 'loading' ? (
          <p className="m-0 type-body text-ink-2" role="status">
            Looking for free times…
          </p>
        ) : slots.state === 'failed' ? (
          <p className="m-0 type-body font-semibold text-danger" role="alert">
            {slots.message}
          </p>
        ) : slots.slots.length === 0 ? (
          <p className="m-0 type-body text-ink-2">
            No free times on {formatDate(day)}. Try another day.
          </p>
        ) : (
          <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto" data-testid="free-times">
            {slots.slots.map((slot) => (
              <TimeChip
                key={slot.startsAt}
                time={timeLabel(timeZone, slot.startsAt)}
                selected={value === slot.startsAt}
                onSelect={() => {
                  setOtherTime('');
                  onChange(slot.startsAt);
                }}
              />
            ))}
          </div>
        )}
      </section>
      <Input
        label="Or another time"
        hint="I’ll check it and suggest the nearest free times."
        type="time"
        name="time"
        step={300}
        value={otherTime}
        onChange={(event) => {
          chooseOther(event.target.value);
        }}
      />
    </div>
  );
}

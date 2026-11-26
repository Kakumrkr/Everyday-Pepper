'use client';

import { BookingSeriesPreviewSchema, type BookingSeriesPreview } from '@pepper/contracts';
import { Badge, Select, Skeleton, TimeChip } from '@pepper/ui';
import { useEffect, useState } from 'react';
import { dateTimeLabel } from '../../../lib/booking';
import {
  DEFAULT_VISITS,
  notFreeLine,
  REPEAT_OPTIONS,
  VISIT_COUNT_OPTIONS,
} from '../../../lib/booking-series';
import { sendJson } from '../../../lib/client-api';
import { Notice } from '../form-parts';

/** "Repeat" in the new-booking sheet (S72, AC-X-187): every 0 (no) to 4 weeks, 2–26 visits. */
export interface RepeatChoice {
  everyWeeks: number;
  count: number;
}

export const NO_REPEAT: RepeatChoice = { everyWeeks: 0, count: DEFAULT_VISITS };

export function RepeatPicker({
  value,
  onChange,
}: {
  value: RepeatChoice;
  onChange: (next: RepeatChoice) => void;
}) {
  return (
    // Stacked on a phone: a select is as wide as its longest option, so two side by side
    // would push the sheet wider than a 375 px screen.
    <div className="grid gap-3 sm:grid-cols-2 sm:gap-2">
      <Select
        label="Repeat"
        name="repeat"
        value={String(value.everyWeeks)}
        options={REPEAT_OPTIONS}
        onChange={(event) => {
          onChange({ ...value, everyWeeks: Number(event.target.value) });
        }}
      />
      {value.everyWeeks === 0 ? null : (
        <Select
          label="For"
          name="visits"
          value={String(value.count)}
          options={VISIT_COUNT_OPTIONS}
          onChange={(event) => {
            onChange({ ...value, count: Number(event.target.value) });
          }}
        />
      )}
    </div>
  );
}

/**
 * The repeat's dates, each checked by the api as one booking would be (AC-X-182): read again
 * whenever the first visit, the service, the staff member or the repeat changes; `null` while
 * reading or when it can't be read (`error` then says so).
 */
export function useSeriesPreview(request: {
  serviceId: string;
  staffMemberId: string;
  startsAt: string | null;
  repeat: RepeatChoice;
}): { preview: BookingSeriesPreview | null; error: string | null } {
  const { serviceId, staffMemberId, startsAt } = request;
  const { everyWeeks, count } = request.repeat;
  const [answer, setAnswer] = useState<{
    preview: BookingSeriesPreview | null;
    error: string | null;
  }>({ preview: null, error: null });
  useEffect(() => {
    if (startsAt === null || everyWeeks === 0 || staffMemberId === '') return;
    let current = true;
    setAnswer({ preview: null, error: null });
    void sendJson('POST', '/v1/bookings/series/preview', {
      serviceId,
      staffMemberId,
      startsAt,
      repeat: { everyWeeks, count },
    }).then((result) => {
      if (!current) return;
      const parsed = result.ok ? BookingSeriesPreviewSchema.safeParse(result.data) : null;
      setAnswer(
        parsed?.success === true
          ? { preview: parsed.data, error: null }
          : { preview: null, error: result.ok ? 'Something went wrong.' : result.message },
      );
    });
    return () => {
      current = false;
    };
  }, [serviceId, staffMemberId, startsAt, everyWeeks, count]);
  return startsAt === null || everyWeeks === 0 ? { preview: null, error: null } : answer;
}

/**
 * Every date of the repeat: free, or "Not free" with the nearest free times to tap instead
 * (D-2). A tapped time is chosen for that date; tapping it again leaves the date out.
 */
export function SeriesDates({
  timeZone,
  preview,
  error,
  count,
  picks,
  onPick,
}: {
  timeZone: string;
  preview: BookingSeriesPreview | null;
  error: string | null;
  count: number;
  picks: Readonly<Record<number, string>>;
  onPick: (index: number, startsAt: string | null) => void;
}) {
  if (error !== null) return <Notice tone="error">{error}</Notice>;
  if (preview === null) {
    return (
      <div className="grid gap-2" aria-busy="true" aria-label="Checking the dates">
        {Array.from({ length: Math.min(count, 4) }, (_, index) => (
          <Skeleton key={index} className="h-11" />
        ))}
      </div>
    );
  }
  const free = preview.visits.filter((visit) => visit.free).length;
  return (
    <section aria-label="The dates" className="grid gap-2">
      <p className="m-0 type-body text-ink-2" role="status" data-testid="series-summary">
        {free === preview.visits.length
          ? `All ${String(free)} dates are free.`
          : `${String(free)} of ${String(preview.visits.length)} dates are free.`}
      </p>
      <ul className="m-0 grid list-none gap-0 divide-y divide-line p-0" data-testid="series-dates">
        {preview.visits.map((visit, index) => (
          <li key={visit.startsAt} className="grid gap-2 py-2" data-testid="series-date">
            <div className="flex min-h-11 items-center justify-between gap-3">
              <span className="type-body tabular-nums text-ink" data-testid="series-date-when">
                {dateTimeLabel(timeZone, visit.startsAt)}
              </span>
              {visit.free ? (
                <Badge tone="ok">Free</Badge>
              ) : picks[index] === undefined ? (
                <Badge tone="warn">Not free</Badge>
              ) : (
                <Badge tone="brand">Moved</Badge>
              )}
            </div>
            {visit.free ? null : (
              <div className="grid gap-2">
                <p className="m-0 type-caption text-ink-2">
                  {notFreeLine(visit, preview.maximumAdvanceDays)}
                </p>
                {visit.alternatives.length === 0 ? null : (
                  <div className="flex flex-wrap gap-2">
                    {visit.alternatives.map((slot) => (
                      <TimeChip
                        key={slot.startsAt}
                        time={dateTimeLabel(timeZone, slot.startsAt)}
                        selected={picks[index] === slot.startsAt}
                        onSelect={() => {
                          onPick(index, picks[index] === slot.startsAt ? null : slot.startsAt);
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

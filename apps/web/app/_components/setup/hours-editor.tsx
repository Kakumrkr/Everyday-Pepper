'use client';

import { WeeklyHoursSchema, type WeeklyHours } from '@pepper/contracts';
import { Button, Checkbox, cx, fieldStyle, IconButton } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { sendJson } from '../../../lib/client-api';
import {
  clockLabel,
  DEFAULT_DAY,
  hoursFromWeek,
  timeChoices,
  weekOf,
  WEEKDAYS,
  type DayHours,
  type DayInterval,
} from '../../../lib/setup';
import { Notice } from '../form-parts';

/**
 * A staff member's weekly hours on the business's clock (`PUT /v1/staff/:id/hours`, the whole
 * week). Each day is off or has one or more spans (e.g. a lunch break between two). Owners and
 * managers only (`hours.manage`); the api checks it again.
 */
export function HoursEditor({
  staffMemberId,
  hours,
}: {
  staffMemberId: string;
  hours: WeeklyHours;
}) {
  const router = useRouter();
  const [week, setWeek] = useState<DayHours[]>(() => weekOf(hours));
  const [message, setMessage] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const times = timeChoices(hours.intervals.flatMap((i) => [i.start, i.end]));

  function setDay(weekday: number, intervals: DayInterval[]) {
    setWeek((current) =>
      current.map((day) => (day.weekday === weekday ? { weekday, intervals } : day)),
    );
    setMessage(null);
  }

  async function save() {
    const body = hoursFromWeek(week);
    const checked = WeeklyHoursSchema.safeParse(body);
    if (!checked.success) {
      setMessage({ tone: 'error', text: checked.error.issues[0]?.message ?? 'Check the hours.' });
      return;
    }
    setBusy(true);
    const answer = await sendJson('PUT', `/v1/staff/${staffMemberId}/hours`, body);
    setBusy(false);
    if (!answer.ok) {
      setMessage({ tone: 'error', text: answer.message });
      return;
    }
    setMessage({ tone: 'ok', text: 'Saved. New bookings follow these hours.' });
    router.refresh();
  }

  const monday = week[0]?.intervals ?? [];

  return (
    <div className="flex flex-col gap-3">
      <ul className="m-0 list-none divide-y divide-line p-0" data-testid="hours-editor">
        {week.map((day) => {
          const name = WEEKDAYS[day.weekday - 1]?.long ?? '';
          const working = day.intervals.length > 0;
          return (
            <li
              key={day.weekday}
              className="grid gap-1 py-2 desk:grid-cols-[9rem_1fr] desk:items-start"
            >
              <Checkbox
                label={name}
                checked={working}
                disabled={busy}
                onChange={(event) => {
                  setDay(day.weekday, event.target.checked ? [DEFAULT_DAY] : []);
                }}
              />
              {working ? (
                <div className="grid gap-2">
                  {day.intervals.map((interval, index) => (
                    <div
                      key={index}
                      className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_2.75rem] items-center gap-2 desk:max-w-md"
                    >
                      <TimeSelect
                        label={`${name} from`}
                        value={interval.start}
                        times={times.slice(0, -1)}
                        disabled={busy}
                        onChange={(start) => {
                          setDay(
                            day.weekday,
                            day.intervals.map((i, n) => (n === index ? { ...i, start } : i)),
                          );
                        }}
                      />
                      <span aria-hidden="true" className="text-ink-2">
                        –
                      </span>
                      <TimeSelect
                        label={`${name} until`}
                        value={interval.end}
                        times={times.slice(1)}
                        disabled={busy}
                        onChange={(end) => {
                          setDay(
                            day.weekday,
                            day.intervals.map((i, n) => (n === index ? { ...i, end } : i)),
                          );
                        }}
                      />
                      {day.intervals.length > 1 ? (
                        <IconButton
                          icon="close"
                          variant="quiet"
                          disabled={busy}
                          label={`Remove ${name} ${clockLabel(interval.start)} to ${clockLabel(interval.end)}`}
                          onClick={() => {
                            setDay(
                              day.weekday,
                              day.intervals.filter((_, n) => n !== index),
                            );
                          }}
                        />
                      ) : null}
                    </div>
                  ))}
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={busy || day.intervals.length >= 6}
                    className="-ml-4 justify-self-start"
                    aria-label={`Add more hours on ${name}`}
                    onClick={() => {
                      const last = day.intervals[day.intervals.length - 1];
                      const start = last?.end ?? DEFAULT_DAY.start;
                      setDay(day.weekday, [...day.intervals, { start, end: later(start, times) }]);
                    }}
                  >
                    Add hours (e.g. after a break)
                  </Button>
                </div>
              ) : (
                <p className="m-0 flex min-h-11 items-center type-body text-ink-2">Day off</p>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || monday.length === 0}
          onClick={() => {
            setWeek((current) =>
              current.map((day) =>
                day.weekday <= 5
                  ? { weekday: day.weekday, intervals: monday.map((i) => ({ ...i })) }
                  : day,
              ),
            );
            setMessage(null);
          }}
        >
          Use Monday’s hours Monday to Friday
        </Button>
      </div>
      {message === null ? null : <Notice tone={message.tone}>{message.text}</Notice>}
      <Button
        size="lg"
        busy={busy}
        className="w-full desk:w-auto desk:self-start"
        onClick={() => void save()}
      >
        {busy ? 'Saving…' : 'Save hours'}
      </Button>
    </div>
  );
}

function TimeSelect({
  label,
  value,
  times,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  times: string[];
  disabled: boolean;
  onChange: (time: string) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      className={cx(fieldStyle, 'min-h-11 min-w-0 px-3 tabular-nums')}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    >
      {times.map((time) => (
        <option key={time} value={time}>
          {clockLabel(time)}
        </option>
      ))}
    </select>
  );
}

/** An hour after `start` on the list of times (or its last time). */
function later(start: string, times: readonly string[]): string {
  const index = times.indexOf(start);
  return times[Math.min(index + 4, times.length - 1)] ?? start;
}

'use client';

import { TimeOffSchema, type TimeOff } from '@pepper/contracts';
import { buttonClass } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { sendJson } from '../../../lib/client-api';
import { clockLabel, timeChoices, timeOffLabel, timeOffSpan } from '../../../lib/setup';
import { Field, Notice } from '../booking/sheet';

/**
 * A staff member's coming time off: whole days, or part of one day, on the business's clock
 * (`POST`/`DELETE /v1/staff/:id/time-off`). Owners and managers manage everyone's; staff only
 * their own (`manages`); the api checks it again.
 */
export function TimeOffEditor({
  staffMemberId,
  timeZone,
  entries,
  manages,
  today,
}: {
  staffMemberId: string;
  timeZone: string;
  entries: TimeOff[];
  manages: boolean;
  /** Today on the business's clock, `YYYY-MM-DD`. */
  today: string;
}) {
  const router = useRouter();
  const [firstDay, setFirstDay] = useState('');
  const [lastDay, setLastDay] = useState('');
  const [partOfDay, setPartOfDay] = useState(false);
  const [from, setFrom] = useState('09:00');
  const [to, setTo] = useState('13:00');
  const [message, setMessage] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const times = timeChoices();
  const path = `/v1/staff/${staffMemberId}/time-off`;

  async function add() {
    const span = timeOffSpan(timeZone, {
      firstDay,
      lastDay: lastDay === '' ? firstDay : lastDay,
      ...(partOfDay && { from, to }),
    });
    if (span === null) {
      setMessage({
        tone: 'error',
        text: partOfDay
          ? 'Pick a day, and an end after the start.'
          : 'Pick the first day, and a last day that is not before it.',
      });
      return;
    }
    setBusy(true);
    const answer = await sendJson('POST', path, span);
    setBusy(false);
    if (!answer.ok || !TimeOffSchema.safeParse(answer.data).success) {
      setMessage({ tone: 'error', text: answer.ok ? 'Something went wrong.' : answer.message });
      return;
    }
    setFirstDay('');
    setLastDay('');
    setMessage({ tone: 'ok', text: 'Added. Those times can no longer be booked.' });
    router.refresh();
  }

  async function remove(entry: TimeOff) {
    setBusy(true);
    const answer = await sendJson('DELETE', `${path}/${entry.id}`, undefined);
    setBusy(false);
    setMessage(answer.ok ? null : { tone: 'error', text: answer.message });
    if (answer.ok) router.refresh();
  }

  return (
    <div className="grid gap-3">
      {entries.length === 0 ? (
        <p className="m-0 text-ink-2">No time off coming up.</p>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0" data-testid="time-off">
          {entries.map((entry) => {
            const label = timeOffLabel(timeZone, entry);
            return (
              <li
                key={entry.id}
                className="flex items-center justify-between gap-3 rounded-md bg-surface-2 px-4 py-2"
              >
                <span>{label}</span>
                {manages ? (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Remove time off ${label}`}
                    className={buttonClass({ variant: 'quiet', size: 'sm' })}
                    onClick={() => void remove(entry)}
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {manages ? (
        <fieldset disabled={busy} className="m-0 grid gap-3 border-0 p-0">
          <legend className="mb-1 p-0 font-semibold">Add time off</legend>
          <label className="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              checked={partOfDay}
              className="size-5 min-h-0 w-auto accent-brand"
              onChange={(event) => {
                setPartOfDay(event.target.checked);
                setMessage(null);
              }}
            />
            Only part of a day
          </label>
          <div className="grid grid-cols-2 gap-3">
            <Field label={partOfDay ? 'Day' : 'First day'}>
              <input
                type="date"
                name="firstDay"
                min={today}
                value={firstDay}
                onChange={(event) => {
                  setFirstDay(event.target.value);
                  setMessage(null);
                }}
              />
            </Field>
            {partOfDay ? null : (
              <Field label="Last day">
                <input
                  type="date"
                  name="lastDay"
                  min={firstDay || today}
                  value={lastDay}
                  onChange={(event) => {
                    setLastDay(event.target.value);
                    setMessage(null);
                  }}
                />
              </Field>
            )}
          </div>
          {partOfDay ? null : (
            <p className="m-0 -mt-1 text-sm text-ink-2">No last day: just the first day.</p>
          )}
          {partOfDay ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="From">
                <select
                  value={from}
                  onChange={(event) => {
                    setFrom(event.target.value);
                  }}
                >
                  {times.slice(0, -1).map((time) => (
                    <option key={time} value={time}>
                      {clockLabel(time)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Until">
                <select
                  value={to}
                  onChange={(event) => {
                    setTo(event.target.value);
                  }}
                >
                  {times.slice(1).map((time) => (
                    <option key={time} value={time}>
                      {clockLabel(time)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          ) : null}
          <button
            type="button"
            disabled={busy || firstDay === ''}
            className={buttonClass({
              variant: 'secondary',
              className: 'w-full desk:w-auto desk:justify-self-start',
            })}
            onClick={() => void add()}
          >
            Add time off
          </button>
        </fieldset>
      ) : null}
      {message === null ? null : <Notice tone={message.tone}>{message.text}</Notice>}
    </div>
  );
}

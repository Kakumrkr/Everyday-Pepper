'use client';

import { TimeOffSchema, type TimeOff } from '@pepper/contracts';
import { Button, Checkbox, Input, Select } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { sendJson } from '../../../lib/client-api';
import { clockLabel, timeChoices, timeOffLabel, timeOffSpan } from '../../../lib/setup';
import { Notice } from '../form-parts';

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
    <div className="flex flex-col gap-3">
      {entries.length === 0 ? (
        <p className="m-0 type-body text-ink-2">
          No time off coming up{manages ? '. Add a holiday or an afternoon off below.' : '.'}
        </p>
      ) : (
        <ul className="m-0 list-none divide-y divide-line p-0" data-testid="time-off">
          {entries.map((entry) => {
            const label = timeOffLabel(timeZone, entry);
            return (
              <li key={entry.id} className="flex min-h-14 items-center justify-between gap-3 py-2">
                <span className="type-body text-ink tabular-nums">{label}</span>
                {manages ? (
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={busy}
                    aria-label={`Remove time off ${label}`}
                    onClick={() => void remove(entry)}
                  >
                    Remove
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {manages ? (
        <fieldset disabled={busy} className="m-0 flex flex-col gap-3 border-0 p-0">
          <legend className="mb-1 p-0 type-label text-ink">Add time off</legend>
          <Checkbox
            label="Only part of a day"
            checked={partOfDay}
            onChange={(event) => {
              setPartOfDay(event.target.checked);
              setMessage(null);
            }}
          />
          <div className="grid grid-cols-2 items-end gap-3">
            <Input
              label={partOfDay ? 'Day' : 'First day'}
              type="date"
              name="firstDay"
              min={today}
              value={firstDay}
              onChange={(event) => {
                setFirstDay(event.target.value);
                setMessage(null);
              }}
            />
            {partOfDay ? null : (
              <Input
                label="Last day"
                hint="Empty: just the first day."
                type="date"
                name="lastDay"
                min={firstDay || today}
                value={lastDay}
                onChange={(event) => {
                  setLastDay(event.target.value);
                  setMessage(null);
                }}
              />
            )}
          </div>
          {partOfDay ? (
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="From"
                value={from}
                options={times
                  .slice(0, -1)
                  .map((time) => ({ value: time, label: clockLabel(time) }))}
                onChange={(event) => {
                  setFrom(event.target.value);
                }}
              />
              <Select
                label="Until"
                value={to}
                options={times.slice(1).map((time) => ({ value: time, label: clockLabel(time) }))}
                onChange={(event) => {
                  setTo(event.target.value);
                }}
              />
            </div>
          ) : null}
          <Button
            variant="secondary"
            disabled={busy || firstDay === ''}
            className="w-full desk:w-auto desk:self-start"
            onClick={() => void add()}
          >
            Add time off
          </Button>
        </fieldset>
      ) : null}
      {message === null ? null : <Notice tone={message.tone}>{message.text}</Notice>}
    </div>
  );
}

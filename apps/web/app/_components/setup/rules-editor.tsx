'use client';

import {
  BookingRulesResponseSchema,
  RULE_LIMITS,
  type Rule,
  type RuleDefaults,
  type SlotIntervalMinutes,
} from '@pepper/contracts';
import { buttonClass, LegacyCard } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { sendJson } from '../../../lib/client-api';
import {
  ADVANCE_CHOICES,
  businessRulesOf,
  choicesWith,
  closedDaysLabel,
  daysLabel,
  NOTICE_CHOICES,
  noticeLabel,
  withBusinessRules,
  type BusinessRules,
} from '../../../lib/setup';
import { Field, Notice } from '../booking/sheet';

/**
 * The business-wide booking rules (`PUT /v1/rules`): the start-time grid, notice, how far
 * ahead, a daily limit per staff member and closed days. Each value may be left on the default
 * (the industry template's, else Pepper's). Staff members' own rules are kept as they are.
 * Read-only for staff; the api checks it again.
 */
export function RulesEditor({
  rules,
  defaults,
  manages,
  ownRules,
}: {
  rules: Rule[];
  defaults: RuleDefaults;
  manages: boolean;
  /** How many rules staff members have of their own (kept, not edited here). */
  ownRules: number;
}) {
  const router = useRouter();
  const [value, setValue] = useState<BusinessRules>(() => businessRulesOf(rules));
  const [closed, setClosed] = useState({ startDate: '', endDate: '' });
  const [message, setMessage] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  function change(next: Partial<BusinessRules>) {
    setValue((current) => ({ ...current, ...next }));
    setMessage(null);
  }

  async function save(next: BusinessRules) {
    setBusy(true);
    const answer = await sendJson('PUT', '/v1/rules', { rules: withBusinessRules(rules, next) });
    setBusy(false);
    const parsed = answer.ok ? BookingRulesResponseSchema.safeParse(answer.data) : null;
    if (parsed?.success === true) {
      setValue(businessRulesOf(parsed.data.rules));
      setMessage({ tone: 'ok', text: 'Saved. New bookings follow these rules.' });
      router.refresh();
      return;
    }
    setMessage({ tone: 'error', text: answer.ok ? 'Something went wrong.' : answer.message });
  }

  const optional = (text: string) => (text === '' ? null : Number(text));

  return (
    <div className="grid gap-4">
      <LegacyCard>
        <h2 className="m-0 mb-3 font-display text-lg font-bold">When clients can book</h2>
        <fieldset disabled={!manages || busy} className="m-0 grid gap-4 border-0 p-0">
          <Field label="Start times every">
            <select
              name="slotInterval"
              value={value.slotIntervalMinutes ?? ''}
              onChange={(event) => {
                change({
                  slotIntervalMinutes: optional(event.target.value) as SlotIntervalMinutes | null,
                });
              }}
            >
              <option value="">Default ({String(defaults.slotIntervalMinutes)} minutes)</option>
              {RULE_LIMITS.slotIntervalMinutes.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} minutes
                </option>
              ))}
            </select>
          </Field>
          <Field label="Notice needed" hint="How soon before a start time it can still be booked.">
            <select
              name="notice"
              value={value.minimumNoticeMinutes ?? ''}
              onChange={(event) => {
                change({ minimumNoticeMinutes: optional(event.target.value) });
              }}
            >
              <option value="">Default ({noticeLabel(defaults.minimumNoticeMinutes)})</option>
              {choicesWith(NOTICE_CHOICES, value.minimumNoticeMinutes).map((minutes) => (
                <option key={minutes} value={minutes}>
                  {noticeLabel(minutes)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Bookable up to">
            <select
              name="advance"
              value={value.maximumAdvanceDays ?? ''}
              onChange={(event) => {
                change({ maximumAdvanceDays: optional(event.target.value) });
              }}
            >
              <option value="">Default ({daysLabel(defaults.maximumAdvanceDays)} ahead)</option>
              {choicesWith(ADVANCE_CHOICES, value.maximumAdvanceDays).map((days) => (
                <option key={days} value={days}>
                  {daysLabel(days)} ahead
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Most appointments per person a day"
            hint={`Empty: ${
              defaults.maxBookingsPerDay === null
                ? 'no limit'
                : `the default, ${String(defaults.maxBookingsPerDay)}`
            }.`}
          >
            <input
              name="dailyLimit"
              type="number"
              inputMode="numeric"
              min={1}
              max={RULE_LIMITS.maxBookingsPerDay}
              value={value.maxBookingsPerDay ?? ''}
              onChange={(event) => {
                change({ maxBookingsPerDay: optional(event.target.value) });
              }}
            />
          </Field>
        </fieldset>
      </LegacyCard>

      <LegacyCard>
        <h2 className="m-0 font-display text-lg font-bold">Closed days</h2>
        <p className="mt-1 mb-3 text-ink-2">Holidays and other days no one can be booked.</p>
        {value.blackouts.length === 0 ? (
          <p className="m-0 mb-3 text-ink-2">No closed days.</p>
        ) : (
          <ul className="m-0 mb-3 grid list-none gap-2 p-0" data-testid="closed-days">
            {value.blackouts.map((blackout, index) => (
              <li
                key={`${blackout.startDate}-${blackout.endDate}`}
                className="flex items-center justify-between gap-3 rounded-md bg-surface-2 px-4 py-2"
              >
                <span>{closedDaysLabel(blackout)}</span>
                {manages ? (
                  <button
                    type="button"
                    disabled={busy}
                    className={buttonClass({ variant: 'quiet', size: 'sm' })}
                    onClick={() => {
                      change({ blackouts: value.blackouts.filter((_, i) => i !== index) });
                    }}
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {manages ? (
          <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
            <Field label="First day">
              <input
                name="closedFrom"
                type="date"
                value={closed.startDate}
                onChange={(event) => {
                  setClosed({ ...closed, startDate: event.target.value });
                }}
              />
            </Field>
            <Field label="Last day">
              <input
                name="closedTo"
                type="date"
                value={closed.endDate}
                min={closed.startDate || undefined}
                onChange={(event) => {
                  setClosed({ ...closed, endDate: event.target.value });
                }}
              />
            </Field>
            <button
              type="button"
              disabled={closed.startDate === '' || busy}
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
              onClick={() => {
                const endDate = closed.endDate === '' ? closed.startDate : closed.endDate;
                if (endDate < closed.startDate) {
                  setMessage({ tone: 'error', text: 'The last day must not be before the first.' });
                  return;
                }
                change({
                  blackouts: [...value.blackouts, { startDate: closed.startDate, endDate }],
                });
                setClosed({ startDate: '', endDate: '' });
              }}
            >
              Add
            </button>
          </div>
        ) : null}
      </LegacyCard>

      {ownRules > 0 ? (
        <p className="m-0 text-sm text-ink-2">
          {ownRules === 1
            ? 'One staff member has a rule'
            : `Staff members have ${String(ownRules)} rules`}{' '}
          of their own; those stay as they are.
        </p>
      ) : null}
      {message === null ? null : <Notice tone={message.tone}>{message.text}</Notice>}
      {manages ? (
        <button
          type="button"
          disabled={busy}
          className={buttonClass({ className: 'w-full desk:w-auto desk:justify-self-start' })}
          onClick={() => void save(value)}
        >
          {busy ? 'Saving…' : 'Save rules'}
        </button>
      ) : (
        <p className="m-0 text-ink-2">Only owners and managers change these.</p>
      )}
    </div>
  );
}

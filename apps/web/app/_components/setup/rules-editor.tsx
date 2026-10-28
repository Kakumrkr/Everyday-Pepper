'use client';

import {
  BookingRulesResponseSchema,
  RULE_LIMITS,
  type Rule,
  type RuleDefaults,
  type SlotIntervalMinutes,
} from '@pepper/contracts';
import { Button, Input, Select } from '@pepper/ui';
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
import { Notice } from '../form-parts';

/**
 * The business-wide booking rules (`PUT /v1/rules`): the start-time grid, notice, how far
 * ahead, a daily limit per staff member and closed days. Each value may be left on the default
 * (the industry template's, else Pepper's). Staff members' own rules are kept as they are.
 * Read-only for staff; the api checks it again. On the kit since S42.2: quiet sections, the
 * fields of the kit, Save at the end, full width on phones.
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
    <div className="flex flex-col gap-6">
      <section aria-labelledby="rules-when" className="flex flex-col gap-3">
        <h2 id="rules-when" className="m-0 type-heading">
          When clients can book
        </h2>
        <fieldset
          disabled={!manages || busy}
          className="m-0 flex flex-col gap-4 rounded-lg border-0 bg-surface p-4"
        >
          <Select
            label="Start times every"
            name="slotInterval"
            value={value.slotIntervalMinutes ?? ''}
            options={[
              { value: '', label: `Default (${String(defaults.slotIntervalMinutes)} minutes)` },
              ...RULE_LIMITS.slotIntervalMinutes.map((minutes) => ({
                value: String(minutes),
                label: `${String(minutes)} minutes`,
              })),
            ]}
            onChange={(event) => {
              change({
                slotIntervalMinutes: optional(event.target.value) as SlotIntervalMinutes | null,
              });
            }}
          />
          <Select
            label="Notice needed"
            hint="How soon before a start time it can still be booked."
            name="notice"
            value={value.minimumNoticeMinutes ?? ''}
            options={[
              { value: '', label: `Default (${noticeLabel(defaults.minimumNoticeMinutes)})` },
              ...choicesWith(NOTICE_CHOICES, value.minimumNoticeMinutes).map((minutes) => ({
                value: String(minutes),
                label: noticeLabel(minutes),
              })),
            ]}
            onChange={(event) => {
              change({ minimumNoticeMinutes: optional(event.target.value) });
            }}
          />
          <Select
            label="Bookable up to"
            name="advance"
            value={value.maximumAdvanceDays ?? ''}
            options={[
              { value: '', label: `Default (${daysLabel(defaults.maximumAdvanceDays)} ahead)` },
              ...choicesWith(ADVANCE_CHOICES, value.maximumAdvanceDays).map((days) => ({
                value: String(days),
                label: `${daysLabel(days)} ahead`,
              })),
            ]}
            onChange={(event) => {
              change({ maximumAdvanceDays: optional(event.target.value) });
            }}
          />
          <Input
            label="Most appointments per person a day"
            hint={`Empty: ${
              defaults.maxBookingsPerDay === null
                ? 'no limit'
                : `the default, ${String(defaults.maxBookingsPerDay)}`
            }.`}
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
        </fieldset>
      </section>

      <section aria-labelledby="rules-closed" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="rules-closed" className="m-0 type-heading">
            Closed days
          </h2>
          <p className="m-0 type-body text-ink-2">Holidays and other days no one can be booked.</p>
        </div>
        <div className="flex flex-col gap-3 rounded-lg bg-surface p-4">
          {value.blackouts.length === 0 ? (
            <p className="m-0 type-body text-ink-2">
              No closed days{manages ? '. Add a holiday below.' : '.'}
            </p>
          ) : (
            <ul className="m-0 list-none divide-y divide-line p-0" data-testid="closed-days">
              {value.blackouts.map((blackout, index) => (
                <li
                  key={`${blackout.startDate}-${blackout.endDate}`}
                  className="flex min-h-14 items-center justify-between gap-3 py-2"
                >
                  <span className="type-body text-ink tabular-nums">
                    {closedDaysLabel(blackout)}
                  </span>
                  {manages ? (
                    <Button
                      variant="quiet"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        change({ blackouts: value.blackouts.filter((_, i) => i !== index) });
                      }}
                    >
                      Remove
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {manages ? (
            <div className="grid grid-cols-2 items-end gap-2 desk:grid-cols-[1fr_1fr_auto]">
              <Input
                label="First day"
                name="closedFrom"
                type="date"
                value={closed.startDate}
                onChange={(event) => {
                  setClosed({ ...closed, startDate: event.target.value });
                }}
              />
              <Input
                label="Last day"
                name="closedTo"
                type="date"
                value={closed.endDate}
                min={closed.startDate || undefined}
                onChange={(event) => {
                  setClosed({ ...closed, endDate: event.target.value });
                }}
              />
              <Button
                variant="secondary"
                className="col-span-2 desk:col-span-1"
                disabled={closed.startDate === '' || busy}
                onClick={() => {
                  const endDate = closed.endDate === '' ? closed.startDate : closed.endDate;
                  if (endDate < closed.startDate) {
                    setMessage({
                      tone: 'error',
                      text: 'The last day must not be before the first.',
                    });
                    return;
                  }
                  change({
                    blackouts: [...value.blackouts, { startDate: closed.startDate, endDate }],
                  });
                  setClosed({ startDate: '', endDate: '' });
                }}
              >
                Add
              </Button>
            </div>
          ) : null}
        </div>
      </section>

      {ownRules > 0 ? (
        <p className="m-0 type-caption text-ink-2">
          {ownRules === 1
            ? 'One staff member has a rule'
            : `Staff members have ${String(ownRules)} rules`}{' '}
          of their own; those stay as they are.
        </p>
      ) : null}
      {message === null ? null : <Notice tone={message.tone}>{message.text}</Notice>}
      {manages ? (
        <Button
          size="lg"
          busy={busy}
          className="w-full desk:w-auto desk:self-start"
          onClick={() => void save(value)}
        >
          {busy ? 'Saving…' : 'Save rules'}
        </Button>
      ) : (
        <p className="m-0 type-body text-ink-2">Only owners and managers change these.</p>
      )}
    </div>
  );
}

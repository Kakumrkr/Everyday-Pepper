'use client';

import {
  ReminderSettingsViewSchema,
  type ReminderSettings,
  type ReminderSettingsPatch,
  type ReminderSettingsView,
} from '@pepper/contracts';
import { Segmented, Switch, Toast } from '@pepper/ui';
import { useId, useState } from 'react';
import { sendJson } from '../../../lib/client-api';
import {
  dayBeforeHint,
  leadLabel,
  REMINDER_SETTINGS_PATH,
  SAME_DAY_LEADS,
  sameDayGoes,
  sameDayHint,
  savedNote,
  textsHint,
  withPatch,
} from '../../../lib/reminder-settings';

/** The toast after a change; `id` makes a second save show a fresh one. */
interface SaveNote {
  id: number;
  text: string;
  tone: 'note' | 'error';
}

/**
 * The reminder switches and the same-day lead (S62.2, AC-X-77). A change shows at once, saves
 * with `PATCH /v1/reminders/settings`, and goes back if refused; a Toast says what changed.
 * Read-only for staff, with the reason above.
 */
export function ReminderSettingsForm({ initial }: { initial: ReminderSettingsView }) {
  const [settings, setSettings] = useState(initial.settings);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<SaveNote | null>(null);
  const leadId = useId();
  const { canChange } = initial;
  const locked = !canChange || busy;

  async function change(patch: ReminderSettingsPatch): Promise<void> {
    const before = settings;
    setSettings(withPatch(settings, patch));
    setBusy(true);
    const answer = await sendJson('PATCH', REMINDER_SETTINGS_PATH, patch);
    setBusy(false);
    const parsed = answer.ok ? ReminderSettingsViewSchema.safeParse(answer.data) : null;
    if (parsed?.success === true) {
      setSettings(parsed.data.settings);
      const text = savedNote(patch, parsed.data.settings);
      setNote((last) => ({ id: (last?.id ?? 0) + 1, text, tone: 'note' }));
    } else {
      setSettings(before);
      const text = answer.ok ? 'Something went wrong. Nothing changed.' : answer.message;
      setNote((last) => ({ id: (last?.id ?? 0) + 1, text, tone: 'error' }));
    }
  }

  const toggle =
    (key: keyof Omit<ReminderSettings, 'sameDayLeadHours'>) =>
    (event: { target: { checked: boolean } }) => {
      void change({ [key]: event.target.checked });
    };

  return (
    <div className="flex flex-col gap-6">
      {canChange ? null : (
        <p className="m-0 rounded-md bg-info-soft px-4 py-3 type-body text-ink">
          Only owners and managers change these. This is what your clients get today.
        </p>
      )}
      <div className="rounded-lg bg-surface px-4 py-1">
        <Switch
          label="Texts to clients"
          hint={textsHint(settings)}
          checked={settings.texts}
          disabled={locked}
          onChange={toggle('texts')}
        />
      </div>
      <section aria-labelledby={`${leadId}-heading`} className="flex flex-col gap-2">
        <h2 id={`${leadId}-heading`} className="m-0 type-heading">
          Reminders before a visit
        </h2>
        <div className="flex flex-col divide-y divide-line rounded-lg bg-surface px-4">
          <Switch
            label="The day before"
            hint={dayBeforeHint(settings)}
            checked={settings.dayBefore}
            disabled={locked}
            onChange={toggle('dayBefore')}
          />
          <div className="flex flex-col gap-2 pb-3">
            <Switch
              label="On the day"
              hint={sameDayHint(settings)}
              checked={sameDayGoes(settings)}
              disabled={locked || !settings.texts}
              onChange={toggle('sameDay')}
            />
            {sameDayGoes(settings) ? (
              canChange ? (
                <div className="flex flex-col gap-1">
                  <span aria-hidden="true" className="type-label text-ink-2">
                    How long before
                  </span>
                  <Segmented
                    label="How long before"
                    options={SAME_DAY_LEADS.map((hours) => ({
                      value: String(hours),
                      label: leadLabel(hours),
                    }))}
                    value={String(settings.sameDayLeadHours)}
                    onValueChange={(value) => {
                      const hours = SAME_DAY_LEADS.find((lead) => String(lead) === value);
                      if (hours !== undefined && !busy) void change({ sameDayLeadHours: hours });
                    }}
                  />
                </div>
              ) : (
                <p className="m-0 type-caption text-ink-2" data-testid="same-day-lead">
                  {leadLabel(settings.sameDayLeadHours)} before.
                </p>
              )
            ) : null}
          </div>
        </div>
        <p className="m-0 type-caption text-ink-2">
          Texts never go at night: one due then waits until the morning.
        </p>
      </section>
      {note === null ? null : (
        <Toast
          key={note.id}
          open
          tone={note.tone}
          title={note.text}
          onOpenChange={(open) => {
            if (!open) setNote(null);
          }}
        />
      )}
    </div>
  );
}

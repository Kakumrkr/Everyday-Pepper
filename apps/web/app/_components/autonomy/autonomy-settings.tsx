'use client';

import {
  levelAllowed,
  AutonomyLevelSchema,
  AutonomyPresetSchema,
  AutonomyViewSchema,
  type ActionTrackRecord,
  type AutonomyAction,
  type AutonomyLevel,
  type AutonomyPreset,
  type AutonomyTrackRecord,
  type AutonomyView,
  type BookingRulesResponse,
  type LocalDate,
} from '@pepper/contracts';
import {
  AUTONOMY_GROUPS,
  Button,
  buttonStyle,
  cx,
  DIAL_LABEL,
  Icon,
  LEVEL_HELP,
  LEVEL_LABEL,
  offerLine,
  PRESET_HELP,
  PRESET_LABEL,
  standingRules,
  Switch,
  Toast,
  trackLine,
} from '@pepper/ui';
import Link from 'next/link';
import { useId, useState } from 'react';
import { ROUTES } from '../../../lib/account';
import { sendJson } from '../../../lib/client-api';

const LEVELS = AutonomyLevelSchema.options;
const PRESETS = AutonomyPresetSchema.options;

/** The toast after a change; `id` makes a second save show a fresh one. */
interface SaveNote {
  id: number;
  text: string;
  tone: 'note' | 'error';
}

/**
 * The autonomy dial (S26, ADR-0028; Microsoft HAX G17: global controls): what Pepper may do on
 * its own. S53 (ADR-0055) puts three presets on top (Careful, Balanced, Hands-off; a radio
 * group, a tap saves), reads the standing rules back in words (the dial and the booking rules,
 * with where to change them), and keeps the 13 actions behind "Customise each action", open by
 * default for "your own mix". Each action shows how often Pepper did it in the last 30 days and,
 * once earned, an offer of more room. "Just do it" is locked for one message to more than 10
 * clients, and shows why. "Ask me first for everything" overrides the rest while on. Owners and
 * managers change it (the api checks); everyone else sees it read-only. Each save is confirmed by
 * a kit Toast (S43), in view on a phone wherever the change was made.
 */
export function AutonomySettings({
  initial,
  canChange,
  trackRecord,
  rules,
  today,
}: {
  initial: AutonomyView;
  canChange: boolean;
  /** `null`: the counts could not be read; the dial shows without them. */
  trackRecord: AutonomyTrackRecord | null;
  /** `null`: the member may not read the booking rules, or they could not be read. */
  rules: BookingRulesResponse | null;
  /** The business's local date, for which blackouts are still ahead. */
  today: LocalDate;
}) {
  const [autonomy, setAutonomy] = useState(initial);
  const [note, setNote] = useState<SaveNote | null>(null);
  const [busy, setBusy] = useState(false);
  const [customising, setCustomising] = useState(initial.preset === null);
  const customiseId = useId();
  const presetLabelId = useId();

  /** Shows the change at once, saves it, and puts it back if the save is refused. */
  async function change(next: AutonomyView, body: object, done: string): Promise<void> {
    const before = autonomy;
    setAutonomy(next);
    setBusy(true);
    const answer = await sendJson('PUT', '/v1/autonomy', body);
    setBusy(false);
    const parsed = answer.ok ? AutonomyViewSchema.safeParse(answer.data) : null;
    if (parsed?.success === true) {
      setAutonomy(parsed.data);
      setNote((last) => ({ id: (last?.id ?? 0) + 1, text: done, tone: 'note' }));
    } else {
      setAutonomy(before);
      const text = answer.ok ? 'Something went wrong. Nothing changed.' : answer.message;
      setNote((last) => ({ id: (last?.id ?? 0) + 1, text, tone: 'error' }));
    }
  }

  const changeLevel = (action: AutonomyAction, level: AutonomyLevel) =>
    void change(
      { ...autonomy, levels: { ...autonomy.levels, [action]: level } },
      { levels: { [action]: level } },
      `Saved. ${DIAL_LABEL[action]}: ${LEVEL_LABEL[level]}.`,
    );
  const recordOf = (action: AutonomyAction): ActionTrackRecord | undefined =>
    trackRecord?.actions.find((row) => row.action === action);
  const lines = standingRules(autonomy, rules, today);

  return (
    <div className="flex flex-col gap-6">
      {canChange ? null : (
        <p className="m-0 rounded-md bg-info-soft px-4 py-3 type-body text-ink">
          Only owners and managers change these. This is what Pepper may do for you today.
        </p>
      )}
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id={presetLabelId} className="m-0 type-heading">
            How much I do on my own
          </h2>
          <p className="m-0 type-body text-ink-2">
            {autonomy.preset === null
              ? 'Your own mix. Pick one to start over, or change each action below.'
              : 'Pick one. You can still change each action below.'}
          </p>
        </div>
        <div
          role="radiogroup"
          aria-labelledby={presetLabelId}
          className="grid grid-cols-1 gap-2 md:grid-cols-3"
        >
          {PRESETS.map((preset) => (
            <PresetOption
              key={preset}
              preset={preset}
              selected={autonomy.preset === preset}
              disabled={!canChange || busy}
              onChoose={() =>
                void change(
                  { ...autonomy, preset },
                  { preset },
                  `Saved. ${PRESET_LABEL[preset]}: ${PRESET_HELP[preset]}`,
                )
              }
            />
          ))}
        </div>
      </section>
      <div className="rounded-lg bg-surface px-4 py-1">
        <Switch
          label="Ask me first for everything"
          hint="While on, I wait for an OK before every change, whatever the settings below say."
          checked={autonomy.askFirst}
          disabled={!canChange || busy}
          onChange={(event) => {
            const on = event.target.checked;
            void change(
              { ...autonomy, askFirst: on },
              { askFirst: on },
              on
                ? 'Saved. I’ll ask you first for everything.'
                : 'Saved. The settings below apply again.',
            );
          }}
        />
      </div>
      <section className="flex flex-col gap-3" aria-labelledby={`${customiseId}-rules`}>
        <div className="flex flex-col gap-1">
          <h2 id={`${customiseId}-rules`} className="m-0 type-heading">
            Your standing rules
          </h2>
          <p className="m-0 type-body text-ink-2">
            What I follow every day, from these settings and your booking rules.
          </p>
        </div>
        <ul
          data-testid="standing-rules"
          className="m-0 flex list-none flex-col gap-2 rounded-lg bg-surface p-0 px-4 py-3"
        >
          {lines.map((line) => (
            <li key={line.text} className="flex gap-2 type-body text-ink">
              <Icon
                name={line.changedOn === 'rules' ? 'calendar' : 'dial'}
                className="mt-1 size-4 shrink-0 text-ink-2"
              />
              <span>{line.text}</span>
            </li>
          ))}
        </ul>
        {rules === null ? null : (
          <Link
            href={ROUTES.rules}
            className={cx(buttonStyle({ variant: 'quiet', size: 'sm' }), 'self-start -ml-3')}
          >
            Change booking rules
          </Link>
        )}
      </section>
      <section className="flex flex-col gap-1">
        <h2 className="m-0 type-heading">Looking things up</h2>
        <p className="m-0 type-body text-ink-2">
          Checking availability, finding clients, reading your day. These never change anything, so
          I always just do them.
        </p>
      </section>
      <Button
        variant="secondary"
        className="self-start"
        aria-expanded={customising}
        aria-controls={customiseId}
        onClick={() => {
          setCustomising((open) => !open);
        }}
      >
        {customising ? 'Hide each action' : 'Customise each action'}
      </Button>
      <div id={customiseId} hidden={!customising} className="flex flex-col gap-6">
        {AUTONOMY_GROUPS.map((group) => (
          <section key={group.title} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="m-0 type-heading">{group.title}</h2>
              <p className="m-0 type-body text-ink-2">{group.description}</p>
            </div>
            <ul className="m-0 list-none divide-y divide-line rounded-lg bg-surface p-0 px-4">
              {group.actions.map((action) => (
                <DialRow
                  key={action}
                  action={action}
                  level={autonomy.levels[action]}
                  record={recordOf(action)}
                  showCount={trackRecord !== null}
                  disabled={!canChange || busy}
                  canChange={canChange}
                  overridden={autonomy.askFirst}
                  onChange={(level) => {
                    changeLevel(action, level);
                  }}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
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

/** One preset: a radio with its name and what it means, the whole card one target. */
function PresetOption({
  preset,
  selected,
  disabled,
  onChoose,
}: {
  preset: AutonomyPreset;
  selected: boolean;
  disabled: boolean;
  onChoose: () => void;
}) {
  return (
    <label
      className={cx(
        'flex min-h-11 cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3',
        'transition motion-base ease-standard',
        'has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-brand',
        selected ? 'border-brand bg-surface shadow-raised' : 'border-line bg-surface hover:border-ink-2',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <input
        type="radio"
        name="autonomy-preset"
        value={preset}
        checked={selected}
        disabled={disabled}
        onChange={onChoose}
        className="sr-only"
      />
      <span className="flex items-center gap-2 type-body font-semibold text-ink">
        {selected ? <Icon name="check" className="size-4 text-brand" /> : null}
        {PRESET_LABEL[preset]}
      </span>
      <span className="type-caption text-ink-2">{PRESET_HELP[preset]}</span>
    </label>
  );
}

function DialRow({
  action,
  level,
  record,
  showCount,
  disabled,
  canChange,
  overridden,
  onChange,
}: {
  action: AutonomyAction;
  level: AutonomyLevel;
  record: ActionTrackRecord | undefined;
  showCount: boolean;
  disabled: boolean;
  canChange: boolean;
  overridden: boolean;
  onChange: (level: AutonomyLevel) => void;
}) {
  const offer = canChange && !overridden ? offerLine(record, level) : null;
  const labelId = useId();
  const helpId = useId();
  const askOnly = !levelAllowed(action, 'notify');
  const locked = askOnly || !levelAllowed(action, 'auto');
  return (
    <li className="flex flex-col gap-3 py-4">
      <div className="flex flex-col gap-0.5">
        <span id={labelId} className="type-body font-semibold text-ink">
          {DIAL_LABEL[action]}
        </span>
        <span id={helpId} className="type-caption text-ink-2">
          {askOnly
            ? 'Always needs your OK: a new rule changes when clients can book.'
            : locked
              ? 'Always needs your OK when more than 10 people would get it. This protects your clients from a costly mistake.'
              : overridden
                ? 'Waiting for your OK while “Ask me first for everything” is on.'
                : LEVEL_HELP[level]}
        </span>
        {showCount ? (
          <span className="type-caption text-ink-2" data-testid={`count-${action}`}>
            {trackLine(record)}
          </span>
        ) : null}
      </div>
      {offer === null ? null : (
        <div className="flex flex-col gap-2 rounded-md bg-info-soft px-3 py-3">
          <p className="m-0 type-body text-ink">{offer.text}</p>
          <Button
            size="sm"
            className="self-start"
            disabled={disabled}
            onClick={() => {
              onChange(offer.to);
            }}
          >
            Yes, {LEVEL_LABEL[offer.to].toLowerCase()}
          </Button>
        </div>
      )}
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={helpId}
        className="grid grid-cols-3 gap-1 rounded-md bg-surface-2 p-1"
      >
        {LEVELS.map((option) => {
          const unavailable = !levelAllowed(action, option);
          return (
            <label
              key={option}
              className={cx(
                'flex min-h-11 cursor-pointer items-center justify-center gap-1 rounded-sm px-1 text-center type-label leading-tight',
                'transition motion-base ease-standard',
                'has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-brand',
                level === option
                  ? 'bg-surface text-ink shadow-raised'
                  : 'text-ink-2 hover:text-ink',
                (disabled || unavailable) && 'cursor-not-allowed opacity-60',
              )}
            >
              <input
                type="radio"
                name={`dial-${action}`}
                value={option}
                checked={level === option}
                disabled={disabled || unavailable}
                onChange={() => {
                  onChange(option);
                }}
                className="sr-only"
              />
              {unavailable ? <Icon name="lock" className="size-4" /> : null}
              {LEVEL_LABEL[option]}
            </label>
          );
        })}
      </div>
    </li>
  );
}

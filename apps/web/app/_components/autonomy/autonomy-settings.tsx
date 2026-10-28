'use client';

import {
  levelAllowed,
  AutonomyLevelSchema,
  BusinessAutonomySchema,
  type AutonomyAction,
  type AutonomyLevel,
  type BusinessAutonomy,
} from '@pepper/contracts';
import {
  AUTONOMY_GROUPS,
  cx,
  DIAL_LABEL,
  Icon,
  LEVEL_HELP,
  LEVEL_LABEL,
  Switch,
} from '@pepper/ui';
import { useId, useState } from 'react';
import { sendJson } from '../../../lib/client-api';

const LEVELS = AutonomyLevelSchema.options;

/**
 * The autonomy dial (S26, ADR-0028; Microsoft HAX G17: global controls): what Pepper may do on
 * its own, grouped by risk. Each action is a radio group (arrow keys move, a change saves at
 * once and is announced). "Just do it" is locked for one message to more than 10 clients, and
 * shows why. "Ask me first for everything" overrides the rest while on. Owners and managers
 * change it (the api checks); everyone else sees it read-only. On the kit since S42.3: the
 * kit Switch (its whole row one 44 px target) and each group's actions as quiet hairline rows.
 */
export function AutonomySettings({
  initial,
  canChange,
}: {
  initial: BusinessAutonomy;
  canChange: boolean;
}) {
  const [autonomy, setAutonomy] = useState(initial);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

  /** Shows the change at once, saves it, and puts it back if the save is refused. */
  async function change(next: BusinessAutonomy, body: object, done: string): Promise<void> {
    const before = autonomy;
    setAutonomy(next);
    setBusy(true);
    const answer = await sendJson('PUT', '/v1/autonomy', body);
    setBusy(false);
    const parsed = answer.ok ? BusinessAutonomySchema.safeParse(answer.data) : null;
    if (parsed?.success === true) {
      setAutonomy(parsed.data);
      setSaved(done);
    } else {
      setAutonomy(before);
      setSaved(answer.ok ? 'Something went wrong. Nothing changed.' : answer.message);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {canChange ? null : (
        <p className="m-0 rounded-md bg-info-soft px-4 py-3 type-body text-ink">
          Only owners and managers change these. This is what Pepper may do for you today.
        </p>
      )}
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
      <section className="flex flex-col gap-1">
        <h2 className="m-0 type-heading">Looking things up</h2>
        <p className="m-0 type-body text-ink-2">
          Checking availability, finding clients, reading your day. These never change anything, so
          I always just do them.
        </p>
      </section>
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
                disabled={!canChange || busy}
                overridden={autonomy.askFirst}
                onChange={(level) =>
                  void change(
                    { ...autonomy, levels: { ...autonomy.levels, [action]: level } },
                    { levels: { [action]: level } },
                    `Saved. ${DIAL_LABEL[action]}: ${LEVEL_LABEL[level]}.`,
                  )
                }
              />
            ))}
          </ul>
        </section>
      ))}
      <p role="status" className="m-0 min-h-5 type-label text-ink">
        {saved}
      </p>
    </div>
  );
}

function DialRow({
  action,
  level,
  disabled,
  overridden,
  onChange,
}: {
  action: AutonomyAction;
  level: AutonomyLevel;
  disabled: boolean;
  overridden: boolean;
  onChange: (level: AutonomyLevel) => void;
}) {
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
      </div>
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
                level === option ? 'bg-surface text-ink shadow-raised' : 'text-ink-2 hover:text-ink',
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

'use client';

import {
  AUTONOMY_ACTIONS,
  AutonomyLevelSchema,
  BusinessAutonomySchema,
  type AutonomyAction,
  type AutonomyLevel,
  type BusinessAutonomy,
} from '@pepper/contracts';
import { AUTONOMY_GROUPS, Card, cx, DIAL_LABEL, Icon, LEVEL_HELP, LEVEL_LABEL } from '@pepper/ui';
import { useId, useState } from 'react';
import { sendJson } from '../../../lib/client-api';

const LEVELS = AutonomyLevelSchema.options;

/**
 * The autonomy dial (S26, ADR-0028; Microsoft HAX G17: global controls): what Pepper may do on
 * its own, grouped by risk. Each action is a radio group (arrow keys move, a change saves at
 * once and is announced). "Just do it" is locked for one message to more than 10 clients, and
 * shows why. "Ask me first for everything" overrides the rest while on. Owners and managers
 * change it (the api checks); everyone else sees it read-only.
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
  const switchId = useId();

  async function change(body: object, done: string): Promise<void> {
    setBusy(true);
    const answer = await sendJson('PUT', '/v1/autonomy', body);
    setBusy(false);
    const parsed = answer.ok ? BusinessAutonomySchema.safeParse(answer.data) : null;
    if (parsed?.success === true) {
      setAutonomy(parsed.data);
      setSaved(done);
    } else {
      setSaved(answer.ok ? 'Something went wrong. Nothing changed.' : answer.message);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {canChange ? null : (
        <p className="m-0 rounded-md bg-info-soft p-3 text-sm">
          Only owners and managers change these. This is what Pepper may do for you today.
        </p>
      )}
      <Card>
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor={switchId} className="font-bold">
              Ask me first for everything
            </label>
            <p className="m-0 text-sm text-ink-2">
              While on, I wait for an OK before every change, whatever the settings below say.
            </p>
          </div>
          <input
            id={switchId}
            type="checkbox"
            role="switch"
            checked={autonomy.askFirst}
            disabled={!canChange || busy}
            onChange={(event) => {
              const on = event.target.checked;
              void change(
                { askFirst: on },
                on
                  ? 'Saved. I’ll ask you first for everything.'
                  : 'Saved. The settings below apply again.',
              );
            }}
            className="mt-1 size-6 shrink-0 accent-brand-strong"
          />
        </div>
      </Card>
      <section className="flex flex-col gap-2">
        <h2 className="m-0 text-lg font-bold">Looking things up</h2>
        <p className="m-0 text-sm text-ink-2">
          Checking availability, finding clients, reading your day. These never change anything, so
          I always just do them.
        </p>
      </section>
      {AUTONOMY_GROUPS.map((group) => (
        <section key={group.title} className="flex flex-col gap-3">
          <div>
            <h2 className="m-0 text-lg font-bold">{group.title}</h2>
            <p className="m-0 text-sm text-ink-2">{group.description}</p>
          </div>
          {group.actions.map((action) => (
            <DialRow
              key={action}
              action={action}
              level={autonomy.levels[action]}
              disabled={!canChange || busy}
              overridden={autonomy.askFirst}
              onChange={(level) =>
                void change(
                  { levels: { [action]: level } },
                  `Saved. ${DIAL_LABEL[action]}: ${LEVEL_LABEL[level]}.`,
                )
              }
            />
          ))}
        </section>
      ))}
      <p role="status" className="m-0 min-h-5 text-sm font-semibold">
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
  const locked = !AUTONOMY_ACTIONS[action].allowsAuto;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface p-4">
      <div className="flex flex-col gap-0.5">
        <span id={labelId} className="font-semibold">
          {DIAL_LABEL[action]}
        </span>
        <span id={helpId} className="text-sm text-ink-2">
          {locked
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
        className="grid grid-cols-3 gap-1 rounded-[14px] bg-surface-2 p-1"
      >
        {LEVELS.map((option) => {
          const unavailable = locked && option === 'auto';
          return (
            <label
              key={option}
              className={cx(
                'flex min-h-11 cursor-pointer items-center justify-center gap-1 rounded-[10px] px-1 text-center text-[13px] leading-tight font-semibold',
                'has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-brand',
                level === option ? 'bg-surface text-ink shadow' : 'text-ink-2',
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
    </div>
  );
}

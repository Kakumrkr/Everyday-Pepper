'use client';

import type { FeedItem } from '@pepper/contracts';
import { useId, useState } from 'react';
import { Card } from '../card.js';
import { buttonClass } from '../class-names.js';
import { briefingLines } from './feed-lines.js';
import type { FeedChange } from './feed-suggestions.js';

export interface DailyBriefingProps {
  /** Today's briefing for this member, or `null` before the morning run (or once read). */
  briefing: FeedItem | null;
  timeZone: string;
  canChangeSettings: boolean;
  /** The business's own hour, or `null` for the template's. */
  morningHour: number | null;
  templateMorningHour: number;
  onRead: (id: string) => FeedChange;
  onHour: (hour: number | null) => FeedChange;
}

/** The hours a business may brief at: the template range (5–11 in the morning). */
const HOURS = [5, 6, 7, 8, 9, 10, 11];
const hourLabel = (hour: number) => `${String(hour)}:00 am`;

/**
 * The daily briefing on Home (S38a, ADR-0042, playbook F-4): today in a few lines worded from
 * the numbers by `briefingLines`, never by the model, with "Got it" to put it away until
 * tomorrow. Owners and managers choose the morning hour (the template's by default); before the
 * morning run it says when the briefing comes.
 */
export function DailyBriefing({
  briefing,
  timeZone,
  canChangeSettings,
  morningHour,
  templateMorningHour,
  onRead,
  onHour,
}: DailyBriefingProps) {
  const headingId = useId();
  const hourId = useId();
  const [read, setRead] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hour = morningHour ?? templateMorningHour;
  const shown = briefing?.kind === 'daily_briefing' && !read ? briefing : null;
  const words = shown === null ? null : briefingLines(shown.payload, timeZone);

  const markRead = async (id: string) => {
    setError(null);
    const failed = await onRead(id);
    if (failed === null) setRead(true);
    else setError(failed);
  };
  const changeHour = async (value: string) => {
    setBusy(true);
    setError(null);
    const failed = await onHour(value === 'template' ? null : Number(value));
    setBusy(false);
    if (failed !== null) setError(failed);
  };

  if (words === null && !canChangeSettings) return null;
  return (
    <div data-testid="daily-briefing">
      <Card labelledBy={headingId} className="flex flex-col gap-3">
        <h2 id={headingId} className="m-0 text-lg font-bold">
          {words?.title ?? 'Your daily briefing'}
        </h2>
        {error !== null ? (
          <p role="alert" className="m-0 text-sm text-danger">
            {error}
          </p>
        ) : null}
        {words === null ? (
          <p className="m-0 text-sm text-ink-2">
            Every morning at {hourLabel(hour)} I sum up the day here: bookings, gaps and what needs
            you.
          </p>
        ) : (
          <ul className="m-0 flex flex-col gap-1 pl-5 text-sm">
            {words.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {shown === null ? null : (
            <button
              type="button"
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
              onClick={() => void markRead(shown.id)}
            >
              Got it
            </button>
          )}
          {canChangeSettings ? (
            <label htmlFor={hourId} className="flex items-center gap-2 text-sm text-ink-2">
              Briefing at
              <select
                id={hourId}
                disabled={busy}
                value={
                  morningHour === null || morningHour === templateMorningHour
                    ? 'template'
                    : String(morningHour)
                }
                onChange={(event) => void changeHour(event.target.value)}
                className="rounded-md border border-line bg-surface px-2 py-1 text-ink"
              >
                <option value="template">{hourLabel(templateMorningHour)} (default)</option>
                {HOURS.filter((each) => each !== templateMorningHour).map((each) => (
                  <option key={each} value={String(each)}>
                    {hourLabel(each)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

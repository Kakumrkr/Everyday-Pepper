'use client';

import type { AiActionView, AiEmailStatus } from '@pepper/contracts';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { ACTION_LABEL, formatDate, formatInstant, undoLine } from '../cards/labels.js';
import { Badge } from '../kit/marks.js';
import { Button } from '../kit/button.js';

// The Activity log (S52, ADR-0043, AC-W7-4): everything Pepper did that the member may see,
// newest first, by local day, in plain words from the receipt's record (its summary, who
// approved it, its emails), never the model's prose. Quiet hairline rows: nothing here needs a
// decision, only Undo while its window is open.

/** A page of the log: its actions and the cursor of the next page (`null`: none). */
export interface ActivityPage {
  actions: AiActionView[];
  next: string | null;
}

export interface ActivityLogProps {
  initial: ActivityPage;
  timeZone: string;
  now: number;
  /** Reads the page after `next`; a message when it can't. */
  onMore: (next: string) => Promise<ActivityPage | string>;
  /**
   * Undoes the action: the receipt as it is now and what to say (its emails taken back or
   * already gone), or a message when it can't.
   */
  onUndo: (id: string) => Promise<{ action: AiActionView; notice: string } | string>;
  /** What to do while the log is empty (DESIGN D5): a link to ask Pepper for something. */
  emptyAction?: ReactNode;
}

const EMAIL_WORDS: Record<AiEmailStatus, (n: number) => string> = {
  sent: (n) => `emailed ${n === 1 ? '1 client' : `${String(n)} clients`}`,
  waiting: (n) => `${n === 1 ? '1 email waits' : `${String(n)} emails wait`} to go`,
  taken_back: (n) => `${n === 1 ? '1 email' : `${String(n)} emails`} taken back`,
  failed: (n) => `${n === 1 ? '1 email' : `${String(n)} emails`} couldn’t be sent`,
};

/** The local date of an instant, `YYYY-MM-DD`, in the business's time zone. */
export function localDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/** "Today", "Yesterday", or "Mon, Nov 2". */
export function dayHeading(day: string, timeZone: string, now: number): string {
  const today = localDay(new Date(now).toISOString(), timeZone);
  if (day === today) return 'Today';
  // The calendar day before, not 24 hours before: a DST day is 23 or 25 hours long.
  const [year = 0, month = 1, date = 1] = today.split('-').map(Number);
  const yesterday = new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
  if (day === yesterday) return 'Yesterday';
  return formatDate(day);
}

/** One receipt in words: what was done, and when, by whose OK, and what it sent. */
export function activityLine(
  action: AiActionView,
  timeZone: string,
): { title: string; meta: string } {
  const title =
    action.summary === null || action.summary === '' ? ACTION_LABEL[action.action] : action.summary;
  const time = formatInstant(action.createdAt, timeZone).split(', ').at(-1) ?? '';
  const how =
    action.approvedByName !== null
      ? `approved by ${action.approvedByName}`
      : action.outcome === 'propose'
        ? 'after approval'
        : 'on its own, as Autonomy allows';
  const counts = new Map<AiEmailStatus, number>();
  for (const email of action.emails) counts.set(email.status, (counts.get(email.status) ?? 0) + 1);
  const emails = [...counts].map(([status, n]) => EMAIL_WORDS[status](n));
  const undone =
    action.undoneAt === null
      ? []
      : [`undone at ${formatInstant(action.undoneAt, timeZone).split(', ').at(-1) ?? ''}`];
  const meta = [`${time}, ${how}`, ...emails, ...undone].join(' · ');
  return { title, meta: meta.charAt(0).toUpperCase() + meta.slice(1) };
}

/** The log, by local day, with "Show older" and Undo. */
export function ActivityLog({
  initial,
  timeZone,
  now: start,
  onMore,
  onUndo,
  emptyAction,
}: ActivityLogProps) {
  // Undo windows and "Today" read against the clock, so it moves while the page is open.
  const [now, setNow] = useState(start);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const [actions, setActions] = useState(initial.actions);
  const [next, setNext] = useState(initial.next);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const more = async () => {
    if (next === null) return;
    setBusy('more');
    setError(null);
    const page = await onMore(next);
    setBusy(null);
    if (typeof page === 'string') {
      setError(page);
      return;
    }
    // A receipt already shown (a page read twice) is kept once.
    setActions((shown) => [
      ...shown,
      ...page.actions.filter((action) => !shown.some((old) => old.id === action.id)),
    ]);
    setNext(page.next);
  };
  const undo = async (id: string) => {
    setBusy(id);
    setError(null);
    const answer = await onUndo(id);
    setBusy(null);
    if (typeof answer === 'string') {
      setError(answer);
      return;
    }
    setActions((shown) => shown.map((action) => (action.id === id ? answer.action : action)));
    setNotice(answer.notice);
  };

  const days: { day: string; items: AiActionView[] }[] = [];
  for (const action of actions) {
    const day = localDay(action.createdAt, timeZone);
    const last = days.at(-1);
    if (last?.day === day) last.items.push(action);
    else days.push({ day, items: [action] });
  }

  return (
    <div className="flex flex-col gap-6">
      {error === null ? null : (
        <p role="alert" className="m-0 type-label text-danger">
          {error}
        </p>
      )}
      <p role="status" className="m-0 type-label text-ink-2 empty:hidden">
        {notice}
      </p>
      {actions.length === 0 ? (
        <div
          className="flex flex-col items-start gap-2 rounded-lg bg-surface-2 px-5 py-4"
          data-testid="activity-empty"
        >
          <p className="m-0 type-body text-ink-2">
            <strong className="text-ink">Nothing yet.</strong> Everything I do for you, like
            bookings, emails and to-dos, will be listed here with who it was for and what was sent.
          </p>
          {emptyAction}
        </div>
      ) : (
        days.map(({ day, items }) => (
          <Day
            key={day}
            heading={dayHeading(day, timeZone, now)}
            items={items}
            timeZone={timeZone}
            now={now}
            busy={busy}
            onUndo={(id) => void undo(id)}
          />
        ))
      )}
      {next === null ? null : (
        <Button
          variant="secondary"
          className="self-start"
          disabled={busy !== null}
          onClick={() => void more()}
        >
          Show older
        </Button>
      )}
    </div>
  );
}

function Day({
  heading,
  items,
  timeZone,
  now,
  busy,
  onUndo,
}: {
  heading: string;
  items: AiActionView[];
  timeZone: string;
  now: number;
  busy: string | null;
  onUndo: (id: string) => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1">
      <h2 id={headingId} className="m-0 type-heading">
        {heading}
      </h2>
      <ul className="m-0 list-none divide-y divide-line p-0">
        {items.map((action) => {
          const line = activityLine(action, timeZone);
          const window = action.canUndo ? undoLine(action.undoUntil, timeZone, now) : null;
          return (
            <li
              key={action.id}
              className="flex min-h-14 items-start gap-3 py-3"
              data-testid="activity-row"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="type-body font-semibold text-ink">{line.title}</span>
                <span className="type-caption text-ink-2">{line.meta}</span>
                {window === null ? null : <span className="type-caption text-ink-2">{window}</span>}
              </div>
              {action.status === 'undone' ? (
                <Badge className="mt-0.5">Undone</Badge>
              ) : window !== null ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy !== null}
                  aria-label={`Undo: ${line.title}`}
                  onClick={() => {
                    onUndo(action.id);
                  }}
                >
                  Undo
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

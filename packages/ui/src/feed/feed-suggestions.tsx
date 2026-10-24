'use client';

import type {
  FeedInsightKind,
  FeedItem,
  FeedSettings,
  FeedSettingsChange,
} from '@pepper/contracts';
import { useId, useState, type ReactNode } from 'react';
import { Card } from '../card.js';
import { buttonClass, cx } from '../class-names.js';
import { FEED_KIND_NOUN, feedLine } from './feed-lines.js';

/** What a close or a switch change came to: `null` when it worked, else a message to show. */
export type FeedChange = Promise<string | null>;

/** The primary action of a suggestion: where it leads ("Show on calendar", "Open Maria"). */
export interface FeedAction {
  label: string;
  href: string;
}

export interface FeedSuggestionsProps {
  items: readonly FeedItem[];
  settings: FeedSettings;
  canChangeSettings: boolean;
  askToTurnOff: FeedInsightKind | null;
  timeZone: string;
  now: number;
  /** The suggestion's primary action, or `null` for none. */
  actionFor: (item: FeedItem) => FeedAction | null;
  /** Renders the action's link (the app's router link); `onFollow` records it as acted on. */
  renderAction: (action: FeedAction, onFollow: () => void) => ReactNode;
  onClose: (id: string, outcome: 'dismissed' | 'done') => FeedChange;
  onSettings: (change: FeedSettingsChange) => FeedChange;
  /** Shown at the card's end (S36: the mailing address rebooking emails carry). */
  footer?: ReactNode;
}

/**
 * The feed's "Suggestions" (S35, ADR-0039): what the rules found, each with its reason in plain
 * words, a primary action and Dismiss (snoozed for 30 days). Owners and managers get the
 * "Pause suggestions" switch and, once per kind, the offer to turn off a kind they keep
 * dismissing. Empty states say what will appear. Every sentence comes from `feedLine`.
 */
export function FeedSuggestions({
  items,
  settings,
  canChangeSettings,
  askToTurnOff,
  timeZone,
  now,
  actionFor,
  renderAction,
  onClose,
  onSettings,
  footer,
}: FeedSuggestionsProps) {
  const headingId = useId();
  const pauseId = useId();
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = items.filter((item) => !closed.has(item.id));

  const close = async (item: FeedItem, outcome: 'dismissed' | 'done') => {
    setError(null);
    const failed = await onClose(item.id, outcome);
    if (failed !== null) {
      setError(failed);
      return;
    }
    setClosed((previous) => new Set([...previous, item.id]));
    if (outcome === 'dismissed') {
      setNotice(
        `Snoozed for 30 days. I won't suggest ${FEED_KIND_NOUN[item.kind]} for this again until then.`,
      );
    }
  };
  const change = async (next: FeedSettingsChange) => {
    setBusy(true);
    setError(null);
    const failed = await onSettings(next);
    setBusy(false);
    if (failed !== null) setError(failed);
  };

  return (
    <Card labelledBy={headingId} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id={headingId} className="m-0 text-lg font-bold">
          Suggestions
        </h2>
        {canChangeSettings ? (
          <div className="flex items-center gap-2">
            <span id={pauseId} className="text-sm font-semibold text-ink-2">
              Pause suggestions
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.suggestionsPaused}
              aria-labelledby={pauseId}
              disabled={busy}
              onClick={() => void change({ suggestionsPaused: !settings.suggestionsPaused })}
              className={cx(
                'relative h-7 w-12 shrink-0 rounded-full border-0 p-0',
                'focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand',
                'after:absolute after:top-[3px] after:left-[3px] after:h-[22px] after:w-[22px] after:rounded-full after:bg-surface after:transition-[left] motion-reduce:after:transition-none',
                settings.suggestionsPaused ? 'bg-brand-strong after:left-[23px]' : 'bg-line',
              )}
            />
          </div>
        ) : null}
      </div>
      {error !== null ? (
        <p role="alert" className="m-0 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <p role="status" className="m-0 text-sm text-ink-2 empty:hidden">
        {notice}
      </p>
      {askToTurnOff !== null && canChangeSettings && !settings.suggestionsPaused ? (
        <div className="flex flex-col gap-2 rounded-md border border-dashed border-accent p-3 text-sm">
          <p className="m-0">
            You've dismissed {FEED_KIND_NOUN[askToTurnOff]} 3 times in 2 weeks. Should I stop
            looking for them?
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              className={buttonClass({ size: 'sm' })}
              onClick={() =>
                void change({
                  disabledKinds: [...settings.disabledKinds, askToTurnOff],
                  askAnswered: askToTurnOff,
                })
              }
            >
              Turn off {FEED_KIND_NOUN[askToTurnOff]}
            </button>
            <button
              type="button"
              disabled={busy}
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
              onClick={() => void change({ askAnswered: askToTurnOff })}
            >
              Keep them
            </button>
          </div>
        </div>
      ) : null}
      {settings.suggestionsPaused ? (
        <EmptyState
          title="Suggestions are paused."
          text="I won't add new ones. Requests that need your OK still show."
        />
      ) : shown.length === 0 ? (
        <EmptyState
          title="All clear."
          text="I look for open gaps, regulars who are due and days that are too full every hour, and again after every booking change."
        />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {shown.map((item) => {
            const line = feedLine(item, timeZone, now);
            const action = actionFor(item);
            return (
              <li key={item.id}>
                <article
                  aria-label={line.title}
                  className="flex flex-col gap-2 rounded-md border border-line bg-bg p-3"
                  data-testid="feed-suggestion"
                  data-kind={item.kind}
                >
                  <p className="m-0 font-semibold leading-snug">{line.title}</p>
                  <p className="m-0 text-sm text-ink-2">{line.why}</p>
                  <div className="flex flex-wrap gap-2">
                    {action === null ? null : renderAction(action, () => void close(item, 'done'))}
                    <button
                      type="button"
                      className={buttonClass({ variant: 'secondary', size: 'sm' })}
                      onClick={() => void close(item, 'dismissed')}
                    >
                      Dismiss
                    </button>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      )}
      {footer}
    </Card>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <p className="m-0 rounded-md bg-surface-2 p-3 text-sm text-ink-2">
      <strong className="text-ink">{title}</strong> {text}
    </p>
  );
}

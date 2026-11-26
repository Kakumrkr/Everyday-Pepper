'use client';

import type {
  FeedInsightKind,
  FeedItem,
  FeedSettings,
  FeedSettingsChange,
} from '@pepper/contracts';
import { useId, useState, type ReactNode } from 'react';
import { cx } from '../class-names.js';
import { List, ListRow, type KitLink } from '../kit/blocks.js';
import { buttonStyle, FOCUS_RING } from '../kit/button.js';
import { MoneyChip } from '../kit/marks.js';
import { boardOf, groupLine, groupRowLine, type BoardCard, type BoardItem } from './board.js';
import { FEED_KIND_NOUN, feedLine } from './feed-lines.js';

/** What a close or a switch change came to: `null` when it worked, else a message to show. */
export type FeedChange = Promise<string | null>;

/** The primary action of a suggestion: where it leads ("Show on calendar", "Open Maria"). */
export interface FeedAction {
  label: string;
  href: string;
}

export interface FeedSuggestionsProps {
  /** The open suggestions, with the dollars at stake when the api priced them (S52). */
  items: readonly BoardItem[];
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
  /**
   * A grouped card's "Dismiss all" (S52): its items closed together, as one dismissal. Without
   * it, each item is closed on its own.
   */
  onCloseMany?: (ids: readonly string[], outcome: 'dismissed') => FeedChange;
  onSettings: (change: FeedSettingsChange) => FeedChange;
  /** Shown at the card's end (S36: the mailing address rebooking emails carry). */
  footer?: ReactNode;
  /**
   * The board's quiet start (S52, AC-W4-5): the business has no booking history yet, so no
   * suggestion is shown, only what will come; `quietAction` is how to start.
   */
  quiet?: boolean;
  quietAction?: ReactNode;
  /** The rows under a grouped card link with this (the app's router link). */
  renderLink?: KitLink;
}

/**
 * The feed's "Suggestions" (S35, ADR-0039): what the rules found, each with its reason in plain
 * words, a primary action and Dismiss (snoozed for 30 days). Owners and managers get the
 * "Pause suggestions" switch and, once per kind, the offer to turn off a kind they keep
 * dismissing. Empty states say what will appear. Every sentence comes from `feedLine`.
 * On the kit (S41): each suggestion is a raised card (it needs a decision); the section around
 * them is flat.
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
  onCloseMany,
  onSettings,
  footer,
  quiet = false,
  quietAction,
  renderLink,
}: FeedSuggestionsProps) {
  const headingId = useId();
  const pauseId = useId();
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = boardOf(items.filter((item) => !closed.has(item.id)));
  // Notes that only inform (S71.2: a booking kept over a Google Calendar change) show even in the
  // quiet start and while paused: they tell of something done, not a suggestion.
  const informing = shown.filter(
    (card) => card.type === 'single' && card.item.kind === 'calendar_kept',
  );

  const close = async (item: FeedItem, outcome: 'dismissed' | 'done') => {
    setError(null);
    const failed = await onClose(item.id, outcome);
    if (failed !== null) {
      setError(failed);
      return false;
    }
    setClosed((previous) => new Set([...previous, item.id]));
    if (outcome === 'dismissed') {
      setNotice(
        `Snoozed for 30 days. I won't suggest ${FEED_KIND_NOUN[item.kind]} for this again until then.`,
      );
    }
    return true;
  };
  /** "Dismiss all" on a grouped card: its items together (one dismissal), or one by one. */
  const dismissAll = async (card: Extract<BoardCard, { type: 'group' }>) => {
    if (onCloseMany === undefined) {
      for (const item of card.items) {
        if (!(await close(item, 'dismissed'))) return;
      }
    } else {
      setError(null);
      const failed = await onCloseMany(
        card.items.map((item) => item.id),
        'dismissed',
      );
      if (failed !== null) {
        setError(failed);
        return;
      }
      setClosed((previous) => new Set([...previous, ...card.items.map((item) => item.id)]));
    }
    setNotice(
      `Snoozed for 30 days. I won't suggest these ${FEED_KIND_NOUN[card.kind]} again until then.`,
    );
  };
  const change = async (next: FeedSettingsChange) => {
    setBusy(true);
    setError(null);
    const failed = await onSettings(next);
    setBusy(false);
    if (failed !== null) setError(failed);
  };

  const cardList = (cards: readonly BoardCard[]) => (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {cards.map((card) =>
        card.type === 'single' ? (
          <li key={card.key}>
            <SingleCard
              item={card.item}
              valueCents={card.valueCents}
              timeZone={timeZone}
              now={now}
              action={actionFor(card.item)}
              renderAction={renderAction}
              onClose={(outcome) => void close(card.item, outcome)}
            />
          </li>
        ) : (
          <li key={card.key}>
            <GroupCard
              card={card}
              actionFor={actionFor}
              renderLink={renderLink}
              onFollow={(item) => void close(item, 'done')}
              onDismissAll={() => void dismissAll(card)}
            />
          </li>
        ),
      )}
    </ul>
  );

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <h2 id={headingId} className="m-0 type-heading">
          Suggestions
        </h2>
        {canChangeSettings ? (
          <div className="flex items-center gap-1">
            <span id={pauseId} className="type-label text-ink-2">
              Pause suggestions
            </span>
            {/* A 44 px target around the kit's 52 × 32 track (D3). */}
            <button
              type="button"
              role="switch"
              aria-checked={settings.suggestionsPaused}
              aria-labelledby={pauseId}
              disabled={busy}
              onClick={() => void change({ suggestionsPaused: !settings.suggestionsPaused })}
              className={cx(
                'group inline-flex min-h-11 shrink-0 items-center rounded-pill border-0 bg-transparent px-1 py-0',
                'disabled:opacity-50',
                FOCUS_RING,
              )}
            >
              <span
                aria-hidden="true"
                className={cx(
                  'relative h-8 w-13 rounded-pill border transition motion-fast ease-standard',
                  settings.suggestionsPaused
                    ? 'border-brand bg-brand'
                    : 'border-line-strong bg-surface-2',
                )}
              >
                <span
                  className={cx(
                    'absolute top-0.75 left-0.75 size-6 rounded-pill shadow-raised transition motion-fast ease-standard',
                    settings.suggestionsPaused ? 'translate-x-5 bg-brand-ink' : 'bg-line-strong',
                  )}
                />
              </span>
            </button>
          </div>
        ) : null}
      </div>
      {error !== null ? (
        <p role="alert" className="m-0 type-label text-danger">
          {error}
        </p>
      ) : null}
      <p role="status" className="m-0 type-label text-ink-2 empty:hidden">
        {notice}
      </p>
      {askToTurnOff !== null && canChangeSettings && !settings.suggestionsPaused ? (
        <div className="flex flex-col gap-3 rounded-lg bg-surface p-5 type-body text-ink shadow-raised">
          <p className="m-0">
            You've dismissed {FEED_KIND_NOUN[askToTurnOff]} 3 times in 2 weeks. Should I stop
            looking for them?
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              className={buttonStyle({ size: 'sm' })}
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
              className={buttonStyle({ variant: 'secondary', size: 'sm' })}
              onClick={() => void change({ askAnswered: askToTurnOff })}
            >
              Keep them
            </button>
          </div>
        </div>
      ) : null}
      {settings.suggestionsPaused ? (
        <>
          {informing.length > 0 ? cardList(informing) : null}
          <EmptyState
            title="Suggestions are paused."
            text="I won't add new ones. Requests that need your OK still show."
          />
        </>
      ) : quiet ? (
        <>
          {informing.length > 0 ? cardList(informing) : null}
          <div
            className="flex flex-col items-start gap-2 rounded-lg bg-surface-2 px-5 py-4"
            data-testid="feed-quiet"
          >
            <p className="m-0 type-body text-ink-2">
              <strong className="text-ink">Quiet for now.</strong> Once clients start booking, I'll
              show you what's worth the most here: open time to fill, regulars who are due and freed
              times for your waitlist.
            </p>
            {quietAction}
          </div>
        </>
      ) : shown.length === 0 ? (
        <EmptyState
          title="All clear."
          text="I look for open gaps, regulars who are due and days that are too full every hour, and again after every booking change."
        />
      ) : (
        cardList(shown)
      )}
      {footer}
    </section>
  );
}

function SingleCard({
  item,
  valueCents,
  timeZone,
  now,
  action,
  renderAction,
  onClose,
}: {
  item: FeedItem;
  valueCents: number | null;
  timeZone: string;
  now: number;
  action: FeedAction | null;
  renderAction: FeedSuggestionsProps['renderAction'];
  onClose: (outcome: 'dismissed' | 'done') => void;
}) {
  const line = feedLine(item, timeZone, now);
  return (
    <article
      aria-label={line.title}
      className="flex flex-col gap-2 rounded-lg bg-surface p-5 shadow-raised"
      data-testid="feed-suggestion"
      data-kind={item.kind}
    >
      <CardTitle title={line.title} valueCents={valueCents} />
      <p className="m-0 type-body text-ink-2">{line.why}</p>
      <div className="mt-1 flex flex-wrap gap-2">
        {action === null
          ? null
          : renderAction(action, () => {
              onClose('done');
            })}
        <button
          type="button"
          className={buttonStyle({ variant: 'secondary', size: 'sm' })}
          onClick={() => {
            onClose('dismissed');
          }}
        >
          Dismiss
        </button>
      </div>
    </article>
  );
}

/**
 * Similar suggestions as one card (S52, AC-W4-3): what they add up to, then each of them as a
 * quiet row that opens it (following one marks it done), and "Dismiss all".
 */
function GroupCard({
  card,
  actionFor,
  renderLink,
  onFollow,
  onDismissAll,
}: {
  card: Extract<BoardCard, { type: 'group' }>;
  actionFor: FeedSuggestionsProps['actionFor'];
  renderLink: KitLink | undefined;
  onFollow: (item: FeedItem) => void;
  onDismissAll: () => void;
}) {
  const line = groupLine(card);
  return (
    <article
      aria-label={line.title}
      className="flex flex-col gap-2 rounded-lg bg-surface p-5 shadow-raised"
      data-testid="feed-suggestion"
      data-kind={card.kind}
      data-group={String(card.items.length)}
    >
      <CardTitle title={line.title} valueCents={card.valueCents} />
      <p className="m-0 type-body text-ink-2">{line.why}</p>
      <List label={line.title}>
        {card.items.map((item) => {
          const action = actionFor(item);
          // The row's link records the visit as acted on, as a single card's action does.
          const link: KitLink | undefined =
            action === null
              ? undefined
              : (props) => (
                  <span
                    className="contents"
                    onClickCapture={() => {
                      onFollow(item);
                    }}
                  >
                    {renderLink === undefined ? (
                      <a href={props.href} className={props.className}>
                        {props.children}
                      </a>
                    ) : (
                      renderLink(props)
                    )}
                  </span>
                );
          return (
            <ListRow
              key={item.id}
              title={groupRowLine(item)}
              trailing={
                item.valueCents === undefined ||
                item.valueCents === null ||
                item.valueCents === 0 ? undefined : (
                  <MoneyChip cents={item.valueCents} kind="estimate" />
                )
              }
              href={action?.href}
              renderLink={link}
            />
          );
        })}
      </List>
      <div className="mt-1 flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonStyle({ variant: 'secondary', size: 'sm' })}
          onClick={onDismissAll}
        >
          Dismiss all
        </button>
      </div>
    </article>
  );
}

/** A card's title, with the dollars at stake beside it when there are some. */
function CardTitle({ title, valueCents }: { title: string; valueCents: number | null }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <p className="m-0 type-subheading text-ink">{title}</p>
      {valueCents === null || valueCents === 0 ? null : (
        <MoneyChip cents={valueCents} kind="estimate" className="mt-0.5 shrink-0" />
      )}
    </div>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <p className="m-0 rounded-lg bg-surface-2 px-5 py-4 type-body text-ink-2">
      <strong className="text-ink">{title}</strong> {text}
    </p>
  );
}

'use client';

import { CLIENT_TEXT_REPLY_MAX, type FeedInsight, type FeedItem } from '@pepper/contracts';
import { useId, useState, type ReactNode } from 'react';
import { Receipt } from '../kit/blocks.js';
import { Button, buttonStyle } from '../kit/button.js';
import { Textarea } from '../kit/fields.js';
import { clockTime, feedLine } from './feed-lines.js';

// Clients' own texts on Home (S80, ADR-0072, AC-X-232, AC-X-233): one raised card a client a
// day for owners and managers, quoting the latest text (shown as the client wrote it, never
// inside Pepper's sentences), naming the visit it's likely about, with Reply (a text in the
// member's words, from the business), "Open {client}" and Done. A reply queued shows a receipt
// with Undo until it goes. Every sentence but the quote comes from `feedLine`.

export type ClientTextItem = FeedItem & Extract<FeedInsight, { kind: 'client_text' }>;

/** What a reply came to: queued (with when it goes), or a message to show. */
export type ClientTextReplyResult =
  { ok: true; replyId: string; sendsAt: string } | { ok: false; message: string };

export interface ClientTextCardsProps {
  items: readonly ClientTextItem[];
  /** The business's name, as the reply's text starts with it. */
  businessName: string;
  timeZone: string;
  now: number;
  onReply: (item: ClientTextItem, body: string) => Promise<ClientTextReplyResult>;
  /** Undo of a queued reply: `null` when it was taken back, else a message. */
  onUndo: (item: ClientTextItem, replyId: string) => Promise<string | null>;
  /** "Done": the card closes (`null`) or says why not. */
  onDone: (item: ClientTextItem) => Promise<string | null>;
  /** The link to the client's profile ("Open Maria"), the app's router link. */
  renderClientLink: (item: ClientTextItem) => ReactNode;
}

/** Nothing to show without texts: the section only appears when a client texted. */
export function ClientTextCards({ items, ...rest }: ClientTextCardsProps) {
  const headingId = useId();
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="m-0 type-heading">
        Texts from clients
      </h2>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {items.map((item) => (
          <li key={item.id}>
            <ClientTextCard item={item} {...rest} />
          </li>
        ))}
      </ul>
    </section>
  );
}

type CardState =
  | { step: 'open' }
  | { step: 'writing'; body: string; error: string | null; busy: boolean }
  | { step: 'queued'; replyId: string; sendsAt: string; soon: boolean; error: string | null }
  | { step: 'closed' };

function ClientTextCard({
  item,
  businessName,
  timeZone,
  now,
  onReply,
  onUndo,
  onDone,
  renderClientLink,
}: Omit<ClientTextCardsProps, 'items'> & { item: ClientTextItem }) {
  const titleId = useId();
  const [state, setState] = useState<CardState>({ step: 'open' });
  const [error, setError] = useState<string | null>(null);
  const line = feedLine(item, timeZone, now);
  const client = item.names.client ?? 'this client';
  if (state.step === 'closed') return null;

  const send = async (body: string) => {
    setState({ step: 'writing', body, error: null, busy: true });
    const result = await onReply(item, body.trim());
    if (result.ok) {
      // Within a minute (the hold for Undo); later, when the quiet hours end.
      const soon = Date.parse(result.sendsAt) - Date.now() < 60_000;
      setState({
        step: 'queued',
        replyId: result.replyId,
        sendsAt: result.sendsAt,
        soon,
        error: null,
      });
    } else {
      setState({ step: 'writing', body, error: result.message, busy: false });
    }
  };

  if (state.step === 'queued') {
    const { soon } = state;
    return (
      <article
        aria-labelledby={titleId}
        className="flex flex-col gap-3 rounded-lg bg-surface p-5 shadow-raised"
        data-testid="client-text-card"
      >
        <h3 id={titleId} className="sr-only">
          {line.title}
        </h3>
        <Receipt
          undo={{
            until: soon ? 'it goes' : clockTime(state.sendsAt, timeZone),
            onUndo: () => {
              void onUndo(item, state.replyId).then((failed) => {
                setState(failed === null ? { step: 'open' } : { ...state, error: failed });
              });
            },
          }}
        >
          {soon
            ? `Reply to ${client} goes by text in a few seconds.`
            : `Reply to ${client} waits for the morning. It goes at ${clockTime(state.sendsAt, timeZone)}.`}
        </Receipt>
        {state.error === null ? null : (
          <p role="alert" className="m-0 type-body text-danger">
            {state.error}
          </p>
        )}
      </article>
    );
  }

  return (
    <article
      aria-labelledby={titleId}
      className="flex flex-col gap-2 rounded-lg bg-surface p-5 shadow-raised"
      data-testid="client-text-card"
    >
      <h3 id={titleId} className="m-0 type-subheading">
        {line.title}
      </h3>
      <blockquote
        className="m-0 rounded-md bg-surface-2 px-4 py-3 type-body break-words whitespace-pre-wrap text-ink"
        data-testid="client-text-quote"
      >
        {item.payload.body}
      </blockquote>
      <p className="m-0 type-body text-ink-2">{line.why}</p>
      {state.step === 'writing' ? (
        <ReplyForm
          client={client}
          businessName={businessName}
          state={state}
          onChange={(body) => {
            setState({ ...state, body, error: null });
          }}
          onSend={(body) => void send(body)}
          onCancel={() => {
            setState({ step: 'open' });
          }}
        />
      ) : (
        <div className="mt-1 flex flex-wrap gap-2">
          <Button
            size="sm"
            icon="send"
            onClick={() => {
              setError(null);
              setState({ step: 'writing', body: '', error: null, busy: false });
            }}
          >
            Reply
          </Button>
          {renderClientLink(item)}
          <button
            type="button"
            className={buttonStyle({ variant: 'quiet', size: 'sm' })}
            onClick={() => {
              setError(null);
              void onDone(item).then((failed) => {
                if (failed === null) setState({ step: 'closed' });
                else setError(failed);
              });
            }}
          >
            Done
          </button>
        </div>
      )}
      {error === null ? null : (
        <p role="alert" className="m-0 type-body text-danger">
          {error}
        </p>
      )}
    </article>
  );
}

function ReplyForm({
  client,
  businessName,
  state,
  onChange,
  onSend,
  onCancel,
}: {
  client: string;
  businessName: string;
  state: Extract<CardState, { step: 'writing' }>;
  onChange: (body: string) => void;
  onSend: (body: string) => void;
  onCancel: () => void;
}) {
  const counterId = useId();
  const left = CLIENT_TEXT_REPLY_MAX - state.body.length;
  const empty = state.body.trim().length === 0;
  return (
    <form
      className="mt-1 flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!empty) onSend(state.body);
      }}
    >
      <Textarea
        label={`Your reply to ${client}`}
        hint={`Goes by text from ${businessName}. Quiet hours hold it until 8:00 AM.`}
        value={state.body}
        maxLength={CLIENT_TEXT_REPLY_MAX}
        // The field opens for writing: focus moves into it.
        autoFocus
        onChange={(event) => {
          onChange(event.target.value);
        }}
        {...(state.error === null ? {} : { error: state.error })}
      />
      <p id={counterId} className="m-0 type-caption text-ink-3 tabular-nums" aria-live="polite">
        {`${String(left)} characters left`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" busy={state.busy} disabled={empty}>
          Send reply
        </Button>
        <button
          type="button"
          className={buttonStyle({ variant: 'quiet', size: 'sm' })}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

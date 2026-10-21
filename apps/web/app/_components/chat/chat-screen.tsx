'use client';

import type { ChatStatus, LocalSlot } from '@pepper/contracts';
import {
  BookingCard,
  buttonClass,
  ChatNotice,
  chipClass,
  ClientChoice,
  cx,
  DayCard,
  formatDate,
  Icon,
  Mark,
  PlanCard,
  SlotPicker,
  type RenderLink,
} from '@pepper/ui';
import Link from 'next/link';
import { useCallback, useEffect, useReducer, useRef, useState, type SubmitEvent } from 'react';
import { ROUTES } from '../../../lib/account';
import { blocksOf, chatReducer, type ChatItem, type ChatState } from '../../../lib/chat-state';
import { runTurn } from '../../../lib/chat-stream';
import { messageFor } from '../../../lib/client-api';
import { LiveChangeCard, type ApproveOutcome } from './live-change';

const renderLink: RenderLink = (link) => (
  <Link href={link.href} className="font-semibold text-brand underline underline-offset-2">
    {link.label}
  </Link>
);

/** Ideas when the chat is empty (Microsoft HAX G1: make clear what the AI can do). */
const SUGGESTIONS: Record<'lead' | 'staff', string[]> = {
  lead: [
    'What does tomorrow look like?',
    'Find a free time for a haircut this week',
    'Block Jess’s lunch tomorrow 12 to 1',
    'Remind me to call the supplier on Friday',
  ],
  staff: [
    'What does my day look like tomorrow?',
    'When am I free on Friday?',
    'Block my lunch tomorrow 12 to 1',
    'Remind me to restock the towels',
  ],
};

const OFF_TEXT: Record<Exclude<ChatStatus['state'], 'on'>, string> = {
  off: 'Pepper’s AI isn’t switched on here. Everything else works as usual: your calendar, clients and team.',
  paused:
    'This month’s AI allowance is used up, so I’m paused until the 1st. Everything else works as usual.',
};

/**
 * Chat with Pepper (S26, ADR-0031): mobile-first, one thumb. The AI's words stream into one
 * bubble as plain text (never HTML or Markdown links, OWASP LLM10); its actions come as typed
 * cards checked against the contract. The transcript is a polite live log, busy while a turn
 * streams so a screen reader reads each answer once; a status line says what Pepper is doing.
 * Nothing takes focus by itself. Stop or leaving the chat cancels a running turn.
 */
export function ChatScreen({
  status,
  initial,
  timeZone,
  lead,
}: {
  status: ChatStatus['state'];
  initial: ChatState;
  timeZone: string;
  /** Owners and managers (their suggestions are the team's). */
  lead: boolean;
}) {
  const [state, dispatch] = useReducer(chatReducer, initial);
  const [draft, setDraft] = useState('');
  const [said, setSaid] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const streaming = useRef<AbortController | null>(null);
  const queued = useRef<string | null>(null);
  const approvers = useRef(new Map<string, () => Promise<ApproveOutcome>>());
  const [planBusy, setPlanBusy] = useState(false);
  const running = state.turn !== null;
  const available = status === 'on';

  const send = useCallback(
    async (text: string): Promise<void> => {
      const message = text.trim();
      if (message === '' || !available) return;
      // A choice tapped on a card while Pepper is still finishing its sentence goes right after.
      if (stateRef.current.turn !== null) {
        queued.current = message;
        return;
      }
      const clientTurnId = crypto.randomUUID();
      const conversationId = stateRef.current.conversationId;
      dispatch({ type: 'sent', clientTurnId, text: message });
      setSaid(null);
      const controller = new AbortController();
      streaming.current = controller;
      const result = await runTurn({
        start: (signal) =>
          fetch('/v1/chat/turns', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
            body: JSON.stringify({ clientTurnId, conversationId, message }),
            credentials: 'same-origin',
            signal,
          }),
        resume: (turnId, after, signal) =>
          fetch(`/v1/chat/turns/${turnId}/events`, {
            headers: { accept: 'text/event-stream', 'last-event-id': String(after) },
            credentials: 'same-origin',
            signal,
          }),
        onEvent: (envelope) => {
          dispatch({ type: 'event', envelope });
        },
        signal: controller.signal,
      });
      streaming.current = null;
      switch (result.kind) {
        case 'finished':
          setSaid('Pepper answered.');
          return;
        case 'refused':
          dispatch({ type: 'ended', notice: messageFor(result.status, result.body) });
          return;
        case 'lost':
          dispatch({
            type: 'ended',
            notice:
              'The connection dropped. I may still finish: open the chat again in a moment to see.',
          });
          return;
        case 'stopped':
          dispatch({ type: 'ended', notice: 'Stopped.' });
          return;
      }
    },
    [available],
  );

  /** Asks the running turn to stop (it ends at its next step; a write already started finishes). */
  const stop = useCallback((keepalive: boolean): void => {
    const turnId = stateRef.current.turn?.turnId ?? null;
    if (turnId === null) {
      streaming.current?.abort();
      return;
    }
    void fetch(`/v1/chat/turns/${turnId}/cancel`, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive,
    }).catch(() => undefined);
  }, []);

  // Sends what was queued once the running turn has ended.
  useEffect(() => {
    if (running || queued.current === null) return;
    const next = queued.current;
    queued.current = null;
    void send(next);
  }, [running, send]);

  // Leaving the chat (another screen, closing the tab) cancels a running turn.
  useEffect(() => {
    const leave = () => {
      if (stateRef.current.turn !== null) stop(true);
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
      streaming.current?.abort();
    };
  }, [stop]);

  // New content scrolls into view only if the member was already at the bottom: reading back
  // up is never interrupted, and the page never jumps.
  const nearBottom = useRef(true);
  useEffect(() => {
    const track = () => {
      nearBottom.current =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    };
    window.addEventListener('scroll', track, { passive: true });
    return () => {
      window.removeEventListener('scroll', track);
    };
  }, []);
  useEffect(() => {
    if (nearBottom.current) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [state.items]);

  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    const text = draft;
    setDraft('');
    void send(text);
  }

  const pickSlot = useCallback(
    (slot: LocalSlot) => {
      const weekday = formatDate(slot.date).split(',')[0] ?? '';
      void send(`Book ${weekday} ${slot.date} at ${slot.time} with ${slot.staffName} instead`);
    },
    [send],
  );

  async function approveAll(ids: string[]): Promise<void> {
    setPlanBusy(true);
    // Each change exactly as shown, in order; the first that isn't done stops the rest.
    for (const id of ids) {
      const approve = approvers.current.get(id);
      if (approve === undefined) continue;
      if ((await approve()) !== 'executed') break;
    }
    setPlanBusy(false);
  }

  const blocks = blocksOf(state.items);
  const statusLine = state.activity ?? said ?? '';
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="m-0 font-display text-2xl font-bold">Chat with Pepper</h1>
        <div className="flex items-center gap-2">
          <Link href={ROUTES.autonomy} className={buttonClass({ variant: 'quiet', size: 'sm' })}>
            <Icon name="dial" />
            Autonomy
          </Link>
          {state.items.length === 0 ? null : (
            <button
              type="button"
              disabled={running}
              onClick={() => {
                dispatch({ type: 'reset' });
              }}
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
            >
              New chat
            </button>
          )}
        </div>
      </div>
      {available ? null : (
        <ChatNotice
          tone="info"
          text={OFF_TEXT[status]}
          link={{ label: 'Open the calendar', href: ROUTES.calendar }}
          renderLink={renderLink}
        />
      )}
      <div
        role="log"
        aria-label="Conversation with Pepper"
        aria-busy={running}
        className="flex flex-col gap-4"
      >
        {state.items.length === 0 && available ? (
          <p className="m-0 text-ink-2">
            Ask me to book, move or cancel appointments, block time, add to-dos, or plan your day. I
            check with you first whenever your settings say so.
          </p>
        ) : null}
        {blocks.map((block) =>
          block.kind === 'plan' ? (
            <PlanCard
              key={block.id}
              pending={block.items.filter((item) => item.status === 'awaiting_approval').length}
              busy={planBusy}
              onApproveAll={() => void approveAll(block.items.map((item) => item.id))}
            >
              {block.items.map((item) => (
                <ItemView
                  key={item.id}
                  item={item}
                  timeZone={timeZone}
                  onPickSlot={pickSlot}
                  onPickClient={(name) => void send(`I mean ${name}`)}
                  register={(approve) => {
                    if (approve === null) approvers.current.delete(item.id);
                    else approvers.current.set(item.id, approve);
                  }}
                />
              ))}
            </PlanCard>
          ) : (
            <ItemView
              key={block.item.id}
              item={block.item}
              timeZone={timeZone}
              onPickSlot={pickSlot}
              onPickClient={(name) => void send(`I mean ${name}`)}
            />
          ),
        )}
      </div>
      <p role="status" className="m-0 min-h-5 text-sm text-ink-2">
        {statusLine}
      </p>
      <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] -mx-4 flex flex-col gap-2 border-t border-line bg-bg px-4 py-3 desk:bottom-0 desk:mx-0 desk:px-0">
        {state.items.length === 0 && available ? (
          <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Try asking" role="group">
            {SUGGESTIONS[lead ? 'lead' : 'staff'].map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className={chipClass({ className: 'shrink-0 whitespace-nowrap' })}
                onClick={() => void send(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}
        <form onSubmit={submit} className="flex items-center gap-2" autoComplete="off">
          <label htmlFor="chat-message" className="sr-only">
            Message Pepper
          </label>
          <input
            id="chat-message"
            name="message"
            value={draft}
            maxLength={4000}
            disabled={!available}
            enterKeyHint="send"
            placeholder={available ? 'Ask Pepper…' : 'The AI is off; every screen still works'}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            className="min-h-12 min-w-0 flex-1 rounded-full border-[1.5px] border-line bg-surface px-5 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand"
          />
          {running ? (
            <button
              type="button"
              onClick={() => {
                stop(false);
              }}
              className={buttonClass({ variant: 'secondary', className: 'w-12 px-0' })}
              aria-label="Stop"
            >
              <Icon name="stop" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!available || draft.trim() === ''}
              className={buttonClass({ className: 'w-12 px-0' })}
              aria-label="Send"
            >
              <Icon name="send" />
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

function ItemView({
  item,
  timeZone,
  onPickSlot,
  onPickClient,
  register,
}: {
  item: ChatItem;
  timeZone: string;
  onPickSlot: (slot: LocalSlot) => void;
  onPickClient: (name: string) => void;
  register?: (approve: (() => Promise<ApproveOutcome>) | null) => void;
}) {
  const [pickedSlot, setPickedSlot] = useState<LocalSlot | null>(null);
  const [pickedClient, setPickedClient] = useState<string | null>(null);
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <p className="m-0 max-w-[82%] rounded-[20px_20px_6px_20px] bg-brand-strong px-4 py-2.5 whitespace-pre-wrap text-on-brand">
            <span className="sr-only">You: </span>
            {item.text}
          </p>
        </div>
      );
    case 'assistant':
      return (
        <div className="flex items-start gap-2.5">
          <Mark className="mt-0.5 size-7 shrink-0" />
          <p
            aria-busy={item.streaming}
            className={cx(
              'm-0 max-w-[62ch] min-w-0 whitespace-pre-wrap',
              item.streaming && 'min-h-6',
            )}
          >
            <span className="sr-only">Pepper: </span>
            {item.text}
          </p>
        </div>
      );
    case 'notice':
      return <ChatNotice text={item.text} link={item.link} renderLink={renderLink} />;
    case 'card': {
      const { card } = item;
      switch (card.kind) {
        case 'change':
          return (
            <LiveChangeCard
              card={card}
              timeZone={timeZone}
              onPickSlot={onPickSlot}
              {...(register !== undefined && { register })}
            />
          );
        case 'slot_picker':
          return (
            <SlotPicker
              slots={card.slots}
              picked={pickedSlot}
              onPick={(slot) => {
                setPickedSlot(slot);
                onPickSlot(slot);
              }}
            />
          );
        case 'client_choice':
          return (
            <ClientChoice
              clients={card.clients}
              picked={pickedClient}
              onPick={(client) => {
                setPickedClient(client.clientId);
                onPickClient(client.name);
              }}
            />
          );
        case 'booking':
          return <BookingCard booking={card.booking} />;
        case 'day':
          return <DayCard day={card} />;
      }
    }
  }
}

import type {
  ChatEventEnvelope,
  ChatHistoryItem,
  ScreenLink,
  ToolCallStatus,
  ToolCard,
  ToolErrorCode,
} from '@pepper/contracts';

// What the chat screen shows (S26, ADR-0031), as a pure reducer over the turn's typed events:
// the member's words, the AI's words (streamed into one growing bubble, plain text), its cards,
// and the clear states (fallback, turn limit, AI off). Each event is applied once, by its
// sequence, so a resumed stream never shows anything twice.

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | {
      kind: 'assistant';
      id: string;
      text: string;
      streaming: boolean;
      /** The remembered facts the answer used (the "Remembered" chip, S32); live by id. */
      factIds: string[];
    }
  | {
      kind: 'card';
      id: string;
      /** The turn it came from: a turn's changes are grouped into one plan. */
      turnId: string | null;
      tool: string;
      status: ToolCallStatus;
      card: ToolCard;
    }
  | { kind: 'notice'; id: string; text: string; link: ScreenLink | null };

export interface ChatState {
  conversationId: string | null;
  items: ChatItem[];
  /** The running turn: `turnId` once the server said so; `lastSeq` its last event applied. */
  turn: { clientTurnId: string; turnId: string | null; lastSeq: number } | null;
  /** What the AI is doing now, for the polite status line ("Checking the calendar…"). */
  activity: string | null;
}

export type ChatAction =
  | { type: 'sent'; clientTurnId: string; text: string }
  | { type: 'event'; envelope: ChatEventEnvelope }
  | { type: 'ended'; notice: string | null }
  | { type: 'reset' };

export const emptyChat: ChatState = { conversationId: null, items: [], turn: null, activity: null };

/** What a refusal without a card tells the member (the model explains the rest). */
const REFUSAL_NOTICE: Partial<Record<ToolErrorCode, string>> = {
  turn_limit:
    'I stopped after as many changes as one message may make. Tell me to carry on and I will.',
};

const ACTIVITY: Record<string, string> = {
  find_availability: 'Checking the free times…',
  find_clients: 'Looking up the client…',
  get_day: 'Reading the schedule…',
  get_booking: 'Reading the booking…',
  list_services_and_staff: 'Checking your services and team…',
};

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return emptyChat;
    case 'sent':
      return {
        ...state,
        items: [...state.items, { kind: 'user', id: action.clientTurnId, text: action.text }],
        turn: { clientTurnId: action.clientTurnId, turnId: null, lastSeq: 0 },
        activity: 'Pepper is thinking…',
      };
    case 'ended':
      return {
        ...state,
        items: [
          ...finishStreaming(state.items),
          ...(action.notice === null
            ? []
            : [
                {
                  kind: 'notice' as const,
                  id: `n-${String(state.items.length)}`,
                  text: action.notice,
                  link: null,
                },
              ]),
        ],
        turn: null,
        activity: null,
      };
    case 'event':
      return applyEvent(state, action.envelope);
  }
}

function applyEvent(state: ChatState, { seq, event }: ChatEventEnvelope): ChatState {
  const turn = state.turn;
  if (turn === null || seq <= turn.lastSeq) return state;
  const next: ChatState = { ...state, turn: { ...turn, lastSeq: seq } };
  const key = `${turn.clientTurnId}-${String(seq)}`;
  switch (event.type) {
    case 'turn.started':
      return {
        ...next,
        conversationId: event.conversationId,
        turn: { ...turn, lastSeq: seq, turnId: event.turnId },
      };
    case 'text.delta': {
      const last = next.items.at(-1);
      if (last?.kind === 'assistant' && last.streaming) {
        return {
          ...next,
          items: [...next.items.slice(0, -1), { ...last, text: last.text + event.delta }],
          activity: null,
        };
      }
      return {
        ...next,
        items: [
          ...next.items,
          { kind: 'assistant', id: key, text: event.delta, streaming: true, factIds: [] },
        ],
        activity: null,
      };
    }
    case 'tool.started':
      return { ...next, activity: ACTIVITY[event.tool] ?? 'Working on it…' };
    case 'tool.finished': {
      const items = finishStreaming(next.items);
      if (event.card !== null) {
        items.push({
          kind: 'card',
          id: key,
          turnId: turn.turnId,
          tool: event.tool,
          status: event.status,
          card: event.card,
        });
      } else if (event.code !== null && REFUSAL_NOTICE[event.code] !== undefined) {
        items.push({ kind: 'notice', id: key, text: REFUSAL_NOTICE[event.code] ?? '', link: null });
      }
      return { ...next, items, activity: 'Pepper is thinking…' };
    }
    case 'message.completed': {
      const last = next.items.at(-1);
      const done = {
        kind: 'assistant' as const,
        id: event.messageId,
        text: event.text,
        streaming: false,
        factIds: event.factIds,
      };
      if (last?.kind === 'assistant' && last.streaming) {
        return { ...next, items: [...next.items.slice(0, -1), done], activity: null };
      }
      return event.text.trim() === ''
        ? next
        : { ...next, items: [...next.items, done], activity: null };
    }
    case 'turn.completed':
      return { ...next, items: finishStreaming(next.items), turn: null, activity: null };
    case 'turn.failed':
      return {
        ...next,
        items: [
          ...finishStreaming(next.items),
          { kind: 'notice', id: key, text: event.fallback.text, link: event.fallback.link },
        ],
        turn: null,
        activity: null,
      };
  }
}

function finishStreaming(items: readonly ChatItem[]): ChatItem[] {
  return items.map((item) =>
    item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item,
  );
}

/** A conversation's history as the chat shows it (cards are snapshots; each card re-reads its live state). */
export function itemsOfHistory(history: readonly ChatHistoryItem[]): ChatItem[] {
  return history.flatMap((item): ChatItem[] => {
    switch (item.kind) {
      case 'user':
        return [{ kind: 'user', id: item.id, text: item.text }];
      case 'assistant':
        return [
          {
            kind: 'assistant',
            id: item.id,
            text: item.text,
            streaming: false,
            factIds: item.factIds,
          },
        ];
      case 'tool':
        return item.card === null
          ? []
          : [
              {
                kind: 'card',
                id: item.id,
                turnId: null,
                tool: item.tool,
                status:
                  item.card.kind === 'change'
                    ? item.card.state === 'proposed'
                      ? 'awaiting_approval'
                      : 'done'
                    : 'answered',
                card: item.card,
              },
            ];
    }
  });
}

export type ChatBlock =
  | { kind: 'item'; item: ChatItem }
  /** Two or more changes from one turn: one plan card (S25 log). */
  | { kind: 'plan'; id: string; items: Extract<ChatItem, { kind: 'card' }>[] };

/** Groups each turn's consecutive change cards into a plan when there are two or more. */
export function blocksOf(items: readonly ChatItem[]): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  let run: Extract<ChatItem, { kind: 'card' }>[] = [];
  const flush = () => {
    const first = run[0];
    if (run.length >= 2 && first !== undefined) {
      blocks.push({ kind: 'plan', id: `plan-${first.id}`, items: run });
    } else {
      for (const item of run) blocks.push({ kind: 'item', item });
    }
    run = [];
  };
  for (const item of items) {
    if (item.kind === 'card' && item.card.kind === 'change') {
      const first = run[0];
      if (first !== undefined && (item.turnId === null || item.turnId !== first.turnId)) flush();
      run.push(item);
      continue;
    }
    flush();
    blocks.push({ kind: 'item', item });
  }
  flush();
  return blocks;
}

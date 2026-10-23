import {
  ChatEventSchema,
  ChatHistoryItemSchema,
  type ChatEvent,
  type ChatEventEnvelope,
  type ToolCard,
} from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { blocksOf, chatReducer, emptyChat, itemsOfHistory, type ChatState } from './chat-state';

const ID = '0199f4b2-7c1e-7a00-8000-0000000000a1';
const TURN = '0199f4b2-7c1e-7a00-8000-0000000000a2';
const FP = 'a'.repeat(64);

const change = (state: 'proposed' | 'done'): ToolCard =>
  ({
    kind: 'change',
    tool: 'add_todo',
    action: 'task.create',
    state,
    proposalId: state === 'proposed' ? ID : null,
    fingerprint: state === 'proposed' ? FP : null,
    executionId: state === 'done' ? ID : null,
    undoUntil: null,
    before: null,
    after: null,
    emails: [],
  }) as ToolCard;

function run(events: ChatEvent[], from: ChatState = emptyChat): ChatState {
  let state = chatReducer(from, { type: 'sent', clientTurnId: 'c1', text: 'Remind me' });
  events.forEach((event, index) => {
    const envelope = { seq: index + 1, event };
    state = chatReducer(state, { type: 'event', envelope });
  });
  return state;
}

const started = {
  type: 'turn.started',
  conversationId: ID,
  turnId: TURN,
  requestMessageId: ID,
} as ChatEvent;

const FACT = '0199f4b2-7c1e-7a00-8000-0000000000f1';

describe('chatReducer', () => {
  it('streams the answer into one bubble, then completes it and ends the turn', () => {
    const state = run([
      started,
      { type: 'text.delta', delta: 'On ' },
      { type: 'text.delta', delta: 'it.' },
      { type: 'message.completed', messageId: ID, text: 'On it.', factIds: [FACT] } as ChatEvent,
      { type: 'turn.completed', reason: 'answered' },
    ]);
    expect(state.conversationId).toBe(ID);
    expect(state.turn).toBeNull();
    expect(state.items).toEqual([
      { kind: 'user', id: 'c1', text: 'Remind me' },
      // The facts the answer used come with it (the "Remembered" chip, S32).
      { kind: 'assistant', id: ID, text: 'On it.', streaming: false, factIds: [FACT] },
    ]);
  });

  it('applies each event once, by its sequence (a resumed stream repeats some)', () => {
    let state = run([started, { type: 'text.delta', delta: 'Hi' }]);
    const repeat = { seq: 2, event: { type: 'text.delta', delta: 'Hi' } } as ChatEventEnvelope;
    state = chatReducer(state, { type: 'event', envelope: repeat });
    expect(state.items.at(-1)).toMatchObject({ text: 'Hi', streaming: true });
  });

  it('adds cards with their turn, says what the AI is doing, and the turn limit in words', () => {
    const state = run([started, { type: 'tool.started', tool: 'find_clients', step: 1 }]);
    expect(state.activity).toBe('Looking up the client…');
    const after = run([
      started,
      {
        type: 'tool.finished',
        tool: 'add_todo',
        status: 'awaiting_approval',
        summary: 'x',
        code: null,
        card: change('proposed'),
      },
      {
        type: 'tool.finished',
        tool: 'add_todo',
        status: 'refused',
        summary: 'x',
        code: 'turn_limit',
        card: null,
      },
    ]);
    expect(after.items.slice(1)).toEqual([
      expect.objectContaining({ kind: 'card', turnId: TURN, status: 'awaiting_approval' }),
      expect.objectContaining({
        kind: 'notice',
        text: expect.stringContaining('carry on') as string,
      }),
    ]);
  });

  it('a failed turn shows its fallback with its link, never anything the model wrote as markup', () => {
    const state = run([
      started,
      {
        type: 'turn.failed',
        fallback: {
          reason: 'provider_unavailable',
          text: 'I can’t reach my AI right now.',
          link: { label: 'Calendar', href: '/calendar' },
        },
      },
    ]);
    expect(state.turn).toBeNull();
    expect(state.items.at(-1)).toMatchObject({
      kind: 'notice',
      text: 'I can’t reach my AI right now.',
      link: { href: '/calendar' },
    });
  });

  it('ignores events when no turn is running, and resets', () => {
    const envelope = { seq: 1, event: started };
    expect(chatReducer(emptyChat, { type: 'event', envelope })).toBe(emptyChat);
    const ended = chatReducer(run([started, { type: 'text.delta', delta: 'Hal' }]), {
      type: 'ended',
      notice: 'The connection dropped.',
    });
    expect(ended.items.at(-2)).toMatchObject({ streaming: false });
    expect(ended.items.at(-1)).toMatchObject({ kind: 'notice', text: 'The connection dropped.' });
    expect(chatReducer(ended, { type: 'reset' })).toBe(emptyChat);
  });
});

describe('itemsOfHistory and blocksOf', () => {
  it('reads history and groups a turn’s changes into one plan', () => {
    const items = itemsOfHistory(
      [
        { kind: 'user', id: ID, text: 'Two things', createdAt: '2026-10-27T10:00:00.000Z' },
        {
          kind: 'tool',
          id: '0199f4b2-7c1e-7a00-8000-0000000000b1',
          tool: 'add_todo',
          card: change('proposed'),
          createdAt: '2026-10-27T10:00:00.000Z',
        },
        {
          kind: 'tool',
          id: '0199f4b2-7c1e-7a00-8000-0000000000b2',
          tool: 'get_day',
          card: null,
          createdAt: '2026-10-27T10:00:00.000Z',
        },
        {
          kind: 'assistant',
          id: '0199f4b2-7c1e-7a00-8000-0000000000b3',
          text: 'Done.',
          factIds: [FACT],
          createdAt: '2026-10-27T10:00:00.000Z',
        },
      ].map((item) => ChatHistoryItemSchema.parse(item)),
    );
    expect(items.map((item) => item.kind)).toEqual(['user', 'card', 'assistant']);
    expect(items[2]).toMatchObject({ factIds: [FACT] });
    expect(items[1]).toMatchObject({ status: 'awaiting_approval' });

    const streamed = run([
      started,
      {
        type: 'tool.finished',
        tool: 'add_todo',
        status: 'awaiting_approval',
        summary: 'x',
        code: null,
        card: change('proposed'),
      },
      {
        type: 'tool.finished',
        tool: 'add_todo',
        status: 'done',
        summary: 'x',
        code: null,
        card: change('done'),
      },
      ChatEventSchema.parse({ type: 'message.completed', messageId: ID, text: 'Two things.' }),
    ]);
    const blocks = blocksOf(streamed.items);
    expect(blocks.map((block) => block.kind)).toEqual(['item', 'plan', 'item']);
    const plan = blocks[1];
    expect(plan?.kind === 'plan' && plan.items).toHaveLength(2);
    // One change alone is just a card.
    expect(blocksOf(streamed.items.slice(0, 2)).map((block) => block.kind)).toEqual([
      'item',
      'item',
    ]);
  });
});

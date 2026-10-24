import { describe, expect, it } from 'vitest';
import {
  ChatEventEnvelopeSchema,
  ChatEventSchema,
  ChatFallbackSchema,
  ChatHistoryItemSchema,
  ChatTurnRequestSchema,
  isFinalChatEvent,
  ScreenLinkSchema,
} from './chat.js';
import { memoryFactRefsIn } from './memory-ids.js';

const ID = '0199f4b2-7c1e-7a00-8000-0000000000a1';

describe('ChatTurnRequestSchema', () => {
  it('takes a message, trimmed, with the client’s turn id', () => {
    expect(
      ChatTurnRequestSchema.parse({ clientTurnId: ID, conversationId: null, message: '  hi ' }),
    ).toEqual({ clientTurnId: ID, conversationId: null, message: 'hi' });
  });

  it('refuses an empty or over-long message, extra fields and a business id', () => {
    const base = { clientTurnId: ID, conversationId: null };
    expect(ChatTurnRequestSchema.safeParse({ ...base, message: '   ' }).success).toBe(false);
    expect(ChatTurnRequestSchema.safeParse({ ...base, message: 'x'.repeat(4_001) }).success).toBe(
      false,
    );
    expect(ChatTurnRequestSchema.safeParse({ ...base, message: 'hi', tenantId: ID }).success).toBe(
      false,
    );
  });
});

describe('ChatEventSchema', () => {
  it('parses every event type', () => {
    const events = [
      { type: 'turn.started', conversationId: ID, turnId: ID, requestMessageId: ID },
      { type: 'text.delta', delta: 'Sure' },
      { type: 'tool.started', tool: 'get_day', step: 1 },
      {
        type: 'tool.finished',
        tool: 'get_day',
        status: 'refused',
        summary: 'Not found.',
        code: 'not_found',
        card: null,
      },
      { type: 'message.completed', messageId: ID, text: 'Done.', factIds: [ID] },
      { type: 'turn.completed', reason: 'answered' },
      {
        type: 'turn.failed',
        fallback: {
          reason: 'provider_unavailable',
          text: 'I can’t reach my AI right now.',
          link: { label: 'Calendar', href: '/calendar' },
        },
      },
    ];
    for (const event of events) expect(ChatEventSchema.parse(event)).toEqual(event);
    expect(events.map((event) => isFinalChatEvent(ChatEventSchema.parse(event)))).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it('refuses an unknown event, an empty delta and a sequence below 1', () => {
    expect(ChatEventSchema.safeParse({ type: 'tool.args', args: '{}' }).success).toBe(false);
    expect(ChatEventSchema.safeParse({ type: 'text.delta', delta: '' }).success).toBe(false);
    expect(
      ChatEventEnvelopeSchema.safeParse({ seq: 0, event: { type: 'text.delta', delta: 'a' } })
        .success,
    ).toBe(false);
  });

  it('never gives a fallback for an answered turn, and links only inside the app', () => {
    expect(
      ChatFallbackSchema.safeParse({ reason: 'answered', text: 'x', link: null }).success,
    ).toBe(false);
    expect(ScreenLinkSchema.safeParse({ label: 'x', href: 'https://evil.test' }).success).toBe(
      false,
    );
    expect(ScreenLinkSchema.safeParse({ label: 'x', href: '//evil.test' }).success).toBe(false);
    expect(ScreenLinkSchema.safeParse({ label: 'x', href: '/clients' }).success).toBe(true);
  });
});

describe('the facts an answer used (S32)', () => {
  const messageId = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708190';
  const factId = '0199F0A4-7C1E-7D2A-9B3C-4D5E6F708191';

  it('are none in events and history written before S32', () => {
    expect(
      ChatEventSchema.parse({ type: 'message.completed', messageId, text: 'Hi' }),
    ).toMatchObject({ factIds: [] });
    expect(
      ChatHistoryItemSchema.parse({
        kind: 'assistant',
        id: messageId,
        text: 'Hi',
        createdAt: '2026-10-23T12:00:00.000Z',
      }),
    ).toMatchObject({ factIds: [] });
  });

  it('are fact ids only, at most 100', () => {
    expect(
      ChatEventSchema.parse({
        type: 'message.completed',
        messageId,
        text: 'Hi',
        factIds: [factId],
      }),
    ).toMatchObject({ factIds: [factId.toLowerCase()] });
    expect(
      ChatEventSchema.safeParse({
        type: 'message.completed',
        messageId,
        text: 'Hi',
        factIds: ['PPD'],
      }).success,
    ).toBe(false);
    expect(
      ChatEventSchema.safeParse({
        type: 'message.completed',
        messageId,
        text: 'Hi',
        factIds: Array.from({ length: 101 }, () => factId),
      }).success,
    ).toBe(false);
  });

  it('are read from the references a stored tool answer holds', () => {
    expect(
      memoryFactRefsIn(`{"memory":[{"$fact":"${factId}"},{"$fact":"not-an-id"}],"x":"$fact"}`),
    ).toEqual([factId]);
  });
});

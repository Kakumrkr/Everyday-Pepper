import { describe, expect, it } from 'vitest';
import {
  ChatEventEnvelopeSchema,
  ChatEventSchema,
  ChatFallbackSchema,
  ChatTurnRequestSchema,
  isFinalChatEvent,
  ScreenLinkSchema,
} from './chat.js';

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
      { type: 'message.completed', messageId: ID, text: 'Done.' },
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

import { describe, expect, it } from 'vitest';
import { InviteTokenSchema, type InviteToken } from '@floty/contracts';
import { hashInviteToken, newInviteToken } from './invite-token.js';

describe('newInviteToken', () => {
  it('is a valid token, different every time', () => {
    const tokens = new Set(Array.from({ length: 100 }, newInviteToken));
    expect(tokens.size).toBe(100);
    for (const token of tokens) expect(InviteTokenSchema.safeParse(token).success).toBe(true);
  });
});

describe('hashInviteToken', () => {
  it('is the SHA-256 hex digest of the token', () => {
    const token = 'q1W2e3R4t5Y6u7I8o9P0a_S-d1F2g3H4j5K6l7Z8x9C' as InviteToken;
    expect(hashInviteToken(token)).toBe(
      '5a9ef171beab8a63243463b8a76b79a4441337c9f0e03857a2939fc3a1cbb3a4',
    );
    expect(hashInviteToken(token)).not.toBe(hashInviteToken(newInviteToken()));
  });

  it('refuses something that is not a token', () => {
    expect(() => hashInviteToken('short')).toThrow();
  });
});

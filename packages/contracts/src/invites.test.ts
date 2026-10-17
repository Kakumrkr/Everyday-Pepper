import { describe, expect, it } from 'vitest';
import {
  AcceptInviteResponseSchema,
  CreateInviteRequestSchema,
  CreateInviteResponseSchema,
  InviteEmailSchema,
  InvitePreviewResponseSchema,
  InviteTokenRequestSchema,
  InviteTokenSchema,
} from './invites.js';

const TOKEN = 'q1W2e3R4t5Y6u7I8o9P0a_S-d1F2g3H4j5K6l7Z8x9C';
const INVITE = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708196';
const USER = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193';

describe('InviteTokenSchema', () => {
  it('accepts 43 base64url characters (32 bytes)', () => {
    expect(InviteTokenSchema.parse(TOKEN)).toBe(TOKEN);
  });

  it.each([
    ['too short', TOKEN.slice(1)],
    ['too long', `${TOKEN}A`],
    ['standard base64', `${TOKEN.slice(0, 42)}+`],
    ['padding', `${TOKEN.slice(0, 42)}=`],
    ['empty', ''],
  ])('rejects a token that is %s', (_label, token) => {
    expect(InviteTokenSchema.safeParse(token).success).toBe(false);
  });
});

describe('InviteEmailSchema', () => {
  it('trims and lowercases', () => {
    expect(InviteEmailSchema.parse('  Jess.Lee@Example.TEST ')).toBe('jess.lee@example.test');
  });

  it.each(['', 'jess', 'jess@', `${'a'.repeat(250)}@example.test`])('rejects %j', (email) => {
    expect(InviteEmailSchema.safeParse(email).success).toBe(false);
  });
});

describe('CreateInviteRequestSchema', () => {
  it('accepts an email and a role', () => {
    expect(CreateInviteRequestSchema.parse({ email: 'Jess@Example.test', role: 'staff' })).toEqual({
      email: 'jess@example.test',
      role: 'staff',
    });
  });

  it.each([
    ['an unknown role', { email: 'jess@example.test', role: 'admin' }],
    ['no role', { email: 'jess@example.test' }],
    // The business comes from the session, never from the body.
    ['a tenant id', { email: 'jess@example.test', role: 'staff', tenantId: INVITE }],
  ])('rejects %s', (_label, body) => {
    expect(CreateInviteRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('responses', () => {
  const invite = {
    id: INVITE,
    email: 'jess@example.test',
    role: 'staff',
    invitedBy: USER,
    createdAt: '2026-10-17T12:00:00.000Z',
    expiresAt: '2026-10-24T12:00:00.000Z',
  };

  it('a created invite carries its token once', () => {
    const body = { invite, token: TOKEN };
    expect(CreateInviteResponseSchema.parse(body)).toEqual(body);
    expect(CreateInviteResponseSchema.safeParse({ invite }).success).toBe(false);
  });

  it('an invite whose inviter was deleted has no inviter', () => {
    const body = { invite: { ...invite, invitedBy: null }, token: TOKEN };
    expect(CreateInviteResponseSchema.parse(body).invite.invitedBy).toBeNull();
  });

  it('preview and accept bodies', () => {
    const preview = { businessName: 'Juniper', role: 'manager', expiresAt: invite.expiresAt };
    expect(InvitePreviewResponseSchema.parse(preview)).toEqual(preview);
    const accepted = { tenantId: INVITE.toUpperCase(), role: 'staff' };
    expect(AcceptInviteResponseSchema.parse(accepted).tenantId).toBe(INVITE);
  });

  it('the token request takes only a token', () => {
    expect(InviteTokenRequestSchema.parse({ token: TOKEN })).toEqual({ token: TOKEN });
    expect(InviteTokenRequestSchema.safeParse({ token: TOKEN, role: 'owner' }).success).toBe(false);
  });
});

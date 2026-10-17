import { describe, expect, it } from 'vitest';
import {
  AuditActorSchema,
  AuditChangeSchema,
  AuditLogEntrySchema,
  AuditLogQuerySchema,
} from './audit.js';

const TENANT = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192';
const USER = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193';
const MEMBERSHIP = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708195';
const INVITE = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708196';

const inviteCreated = {
  action: 'invite.created',
  entity: { type: 'invite', id: INVITE },
  before: null,
  after: { role: 'staff', expiresAt: '2026-10-24T12:00:00.000Z' },
} as const;

const roleChanged = {
  action: 'membership.role_changed',
  entity: { type: 'membership', id: MEMBERSHIP },
  before: { userId: USER, role: 'staff' },
  after: { userId: USER, role: 'manager' },
} as const;

describe('AuditChangeSchema', () => {
  it.each([
    [
      'tenant.created',
      {
        action: 'tenant.created',
        entity: { type: 'tenant', id: TENANT },
        before: null,
        after: {
          slug: 'juniper',
          timeZone: 'America/New_York',
          locale: 'en-US',
          ownerUserId: USER,
        },
      },
    ],
    ['membership.role_changed', roleChanged],
    [
      'membership.removed',
      {
        action: 'membership.removed',
        entity: { type: 'membership', id: MEMBERSHIP },
        before: { userId: USER, role: 'staff' },
        after: null,
      },
    ],
    ['invite.created', inviteCreated],
    [
      'invite.revoked',
      {
        action: 'invite.revoked',
        entity: { type: 'invite', id: INVITE },
        before: { role: 'manager' },
        after: null,
      },
    ],
    [
      'invite.accepted',
      {
        action: 'invite.accepted',
        entity: { type: 'invite', id: INVITE },
        before: { role: 'staff' },
        after: { userId: USER, role: 'staff', membershipId: MEMBERSHIP },
      },
    ],
  ])('accepts %s', (_action, change) => {
    expect(AuditChangeSchema.parse(change)).toEqual(change);
  });

  it.each([
    ['an unknown action', { ...roleChanged, action: 'membership.deleted' }],
    ['the wrong entity type', { ...roleChanged, entity: { type: 'tenant', id: MEMBERSHIP } }],
    // Allowlisted fields only: personal data cannot ride along in before/after.
    [
      'an extra field in after',
      { ...roleChanged, after: { ...roleChanged.after, email: 'a@b.c' } },
    ],
    ['an extra top-level field', { ...roleChanged, note: 'free text' }],
    // The invitee's email never goes into the audit log.
    [
      "an invitee's email",
      { ...inviteCreated, after: { ...inviteCreated.after, email: 'jess@example.test' } },
    ],
    [
      'an invite on a membership entity',
      { ...inviteCreated, entity: { type: 'membership', id: INVITE } },
    ],
    ['a missing before', { ...roleChanged, before: null }],
  ])('rejects %s', (_label, change) => {
    expect(AuditChangeSchema.safeParse(change).success).toBe(false);
  });
});

describe('AuditActorSchema', () => {
  it('accepts a user or the system, nothing else', () => {
    expect(AuditActorSchema.parse({ kind: 'user', userId: USER })).toEqual({
      kind: 'user',
      userId: USER,
    });
    expect(AuditActorSchema.parse({ kind: 'system' })).toEqual({ kind: 'system' });
    expect(AuditActorSchema.safeParse({ kind: 'user' }).success).toBe(false);
    expect(AuditActorSchema.safeParse({ kind: 'system', userId: USER }).success).toBe(false);
  });
});

describe('AuditLogEntrySchema', () => {
  it('accepts an entry whose user was deleted', () => {
    const entry = {
      id: MEMBERSHIP,
      at: '2026-10-17T12:00:00.000Z',
      actor: { kind: 'user', userId: null },
      ...roleChanged,
    };
    expect(AuditLogEntrySchema.parse(entry)).toEqual(entry);
  });
});

describe('AuditLogQuerySchema', () => {
  it('defaults the page size and reads numbers from query strings', () => {
    expect(AuditLogQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(AuditLogQuerySchema.parse({ limit: '10', before: TENANT })).toEqual({
      limit: 10,
      before: TENANT,
    });
  });

  it.each([
    { limit: '0' },
    { limit: '101' },
    { limit: '1.5' },
    { before: 'x' },
    { tenantId: TENANT },
  ])('rejects %j', (query) => {
    expect(AuditLogQuerySchema.safeParse(query).success).toBe(false);
  });
});

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
const SERVICE = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708197';
const STAFF = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708198';
const TIME_OFF = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708199';
const CLIENT = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708190';
const BOOKING = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f70819b';
const WAITLIST_ENTRY = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f70819c';

const serviceValues = {
  name: "Women's haircut",
  category: 'Cuts',
  durationMinutes: 60,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 10,
  priceFromCents: 6500,
  priceToCents: null,
  active: true,
};
const staffValues = { active: true, userId: USER, serviceIds: [SERVICE] };
const staffCreated = {
  action: 'staff_member.created',
  entity: { type: 'staff_member', id: STAFF },
  before: null,
  after: staffValues,
} as const;
const timeOffValues = {
  staffMemberId: STAFF,
  startsAt: '2026-10-20T13:00:00.000Z',
  endsAt: '2026-10-20T17:00:00.000Z',
};

const bookingValues = {
  clientId: CLIENT,
  serviceId: SERVICE,
  staffMemberId: STAFF,
  startsAt: '2026-10-20T14:00:00.000Z',
  endsAt: '2026-10-20T15:00:00.000Z',
  status: 'confirmed',
  source: 'team',
  overridden: false,
} as const;
const bookingCreated = {
  action: 'booking.created',
  entity: { type: 'booking', id: BOOKING },
  before: null,
  after: bookingValues,
} as const;
const waitlistValues = {
  clientId: CLIENT,
  serviceId: SERVICE,
  staffMemberId: null,
  expiresAt: '2026-10-23T22:00:00.000Z',
  status: 'waiting',
} as const;
const clientCreated = {
  action: 'client.created',
  entity: { type: 'client', id: CLIENT },
  before: null,
  after: { source: 'team' },
} as const;

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
    [
      'tenant.created (with a template, S13)',
      {
        action: 'tenant.created',
        entity: { type: 'tenant', id: TENANT },
        before: null,
        after: {
          slug: 'juniper',
          timeZone: 'America/New_York',
          locale: 'en-US',
          templateId: 'barber',
          ownerUserId: USER,
        },
      },
    ],
    [
      'tenant.updated',
      {
        action: 'tenant.updated',
        entity: { type: 'tenant', id: TENANT },
        before: { brandColor: null },
        after: { brandColor: '#7a3e6c' },
      },
    ],
    [
      'tenant.updated (profile, S47)',
      {
        action: 'tenant.updated',
        entity: { type: 'tenant', id: TENANT },
        before: { brandColor: null, profileChanged: ['phone', 'publicAddress'] },
        after: { brandColor: '#7a3e6c', profileChanged: ['phone', 'publicAddress'] },
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
    [
      'service.created',
      {
        action: 'service.created',
        entity: { type: 'service', id: SERVICE },
        before: null,
        after: serviceValues,
      },
    ],
    [
      'service.updated',
      {
        action: 'service.updated',
        entity: { type: 'service', id: SERVICE },
        before: serviceValues,
        after: { ...serviceValues, active: false },
      },
    ],
    ['staff_member.created', staffCreated],
    [
      'staff_member.updated',
      {
        action: 'staff_member.updated',
        entity: { type: 'staff_member', id: STAFF },
        before: staffValues,
        after: { ...staffValues, userId: null, serviceIds: [] },
      },
    ],
    [
      'working_hours.replaced',
      {
        action: 'working_hours.replaced',
        entity: { type: 'staff_member', id: STAFF },
        before: { intervals: [] },
        after: { intervals: [{ weekday: 1, start: '09:00', end: '17:00' }] },
      },
    ],
    [
      'time_off.created',
      {
        action: 'time_off.created',
        entity: { type: 'time_off', id: TIME_OFF },
        before: null,
        after: timeOffValues,
      },
    ],
    [
      'time_off.deleted',
      {
        action: 'time_off.deleted',
        entity: { type: 'time_off', id: TIME_OFF },
        before: timeOffValues,
        after: null,
      },
    ],
    ['client.created', clientCreated],
    [
      'client.updated',
      {
        action: 'client.updated',
        entity: { type: 'client', id: CLIENT },
        before: null,
        after: { changed: ['email', 'phone'] },
      },
    ],
    [
      'client.merged',
      {
        action: 'client.merged',
        entity: { type: 'client', id: CLIENT },
        before: null,
        after: { mergedClientId: CLIENT, moved: { visits: 2, waitlistEntries: 0, notes: 1 } },
      },
    ],
    [
      'client.deleted',
      {
        action: 'client.deleted',
        entity: { type: 'client', id: CLIENT },
        before: null,
        after: { pastVisitsKept: 3, notesForgotten: 1 },
      },
    ],
    ['booking.created', bookingCreated],
    [
      'booking.updated',
      {
        action: 'booking.updated',
        entity: { type: 'booking', id: BOOKING },
        before: bookingValues,
        after: { ...bookingValues, status: 'cancelled' },
      },
    ],
    [
      'waitlist_entry.created',
      {
        action: 'waitlist_entry.created',
        entity: { type: 'waitlist_entry', id: WAITLIST_ENTRY },
        before: null,
        after: waitlistValues,
      },
    ],
    [
      'waitlist_entry.updated',
      {
        action: 'waitlist_entry.updated',
        entity: { type: 'waitlist_entry', id: WAITLIST_ENTRY },
        before: waitlistValues,
        after: { ...waitlistValues, status: 'cancelled' },
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
    // A staff member's name is a person's name: never in the audit log.
    [
      "a staff member's display name",
      { ...staffCreated, after: { ...staffValues, displayName: 'Jess Lee' } },
    ],
    // A client's name, email and phone are personal data: never in the audit log.
    ["a client's name", { ...clientCreated, after: { source: 'team', name: 'Maria Lopez' } }],
    [
      "a client's new email on an edit",
      {
        action: 'client.updated',
        entity: { type: 'client', id: CLIENT },
        before: null,
        after: { changed: ['email'], email: 'maria@example.test' },
      },
    ],
    [
      'an edit that changed nothing',
      {
        action: 'client.updated',
        entity: { type: 'client', id: CLIENT },
        before: null,
        after: { changed: [] },
      },
    ],
    [
      "a client's email on a booking",
      { ...bookingCreated, after: { ...bookingValues, clientEmail: 'maria@example.test' } },
    ],
    [
      'a stored "expired" waitlist status (it is derived)',
      {
        action: 'waitlist_entry.updated',
        entity: { type: 'waitlist_entry', id: WAITLIST_ENTRY },
        before: waitlistValues,
        after: { ...waitlistValues, status: 'expired' },
      },
    ],
  ])('rejects %s', (_label, change) => {
    expect(AuditChangeSchema.safeParse(change).success).toBe(false);
  });
});

describe('trust-layer audit actions (ADR-0028)', () => {
  const PROPOSAL = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f7081a1';
  const EXECUTION = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f7081a2';
  const execution = {
    action: 'booking.create',
    outcome: 'execute_and_notify',
    status: 'done',
    proposalId: PROPOSAL,
    undoUntil: '2026-10-22T12:00:00.000Z',
  } as const;

  it.each([
    {
      action: 'autonomy.updated',
      entity: { type: 'tenant', id: TENANT },
      before: { askFirst: false, levels: {} },
      after: { askFirst: true, levels: { 'booking.create': 'notify' } },
    },
    {
      action: 'ai_proposal.created',
      entity: { type: 'ai_action_proposal', id: PROPOSAL },
      before: null,
      after: { action: 'booking.cancel', status: 'pending', expiresAt: '2026-10-22T12:00:00.000Z' },
    },
    {
      action: 'ai_proposal.decided',
      entity: { type: 'ai_action_proposal', id: PROPOSAL },
      before: { action: 'booking.cancel', status: 'pending' },
      after: { action: 'booking.cancel', status: 'approved' },
    },
    {
      action: 'ai_action.executed',
      entity: { type: 'ai_action_execution', id: EXECUTION },
      before: null,
      after: execution,
    },
    {
      action: 'ai_action.undone',
      entity: { type: 'ai_action_execution', id: EXECUTION },
      before: execution,
      after: { ...execution, status: 'undone', undoReason: 'wrong' },
    },
  ])('accepts $action', (change) => {
    expect(AuditChangeSchema.parse(change)).toEqual(change);
  });

  it('keeps payloads out of proposal entries', () => {
    expect(
      AuditChangeSchema.safeParse({
        action: 'ai_proposal.created',
        entity: { type: 'ai_action_proposal', id: PROPOSAL },
        before: null,
        after: {
          action: 'booking.cancel',
          status: 'pending',
          expiresAt: '2026-10-22T12:00:00.000Z',
          payload: { bookingId: BOOKING },
        },
      }).success,
    ).toBe(false);
  });

  it('refuses "just do it" for bulk messages in autonomy entries', () => {
    expect(
      AuditChangeSchema.safeParse({
        action: 'autonomy.updated',
        entity: { type: 'tenant', id: TENANT },
        before: { askFirst: false, levels: {} },
        after: { askFirst: false, levels: { 'message.bulk': 'auto' } },
      }).success,
    ).toBe(false);
  });
});

describe('AuditActorSchema', () => {
  it('accepts the AI acting for a member, with the member', () => {
    expect(AuditActorSchema.parse({ kind: 'ai_on_behalf_of', userId: USER })).toEqual({
      kind: 'ai_on_behalf_of',
      userId: USER,
    });
    expect(AuditActorSchema.safeParse({ kind: 'ai_on_behalf_of' }).success).toBe(false);
    expect(AuditActorSchema.safeParse({ kind: 'ai' }).success).toBe(false);
  });

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

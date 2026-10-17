import {
  InviteTokenSchema,
  TenantIdSchema,
  type InviteToken,
  type MembershipRole,
  type TenantId,
  type UserId,
} from '@floty/contracts';
import {
  addMembership,
  findMembership,
  listAuditEntries,
  updateMembershipRole,
  withTenant,
  type Database,
} from '@floty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from './actor.js';
import { ManualClock } from './clock.js';
import {
  AlreadyAMemberError,
  ForbiddenError,
  InviteInvalidError,
  InviteLimitReachedError,
  InviteNotFoundError,
  InviteWrongAccountError,
} from './errors.js';
import { newInviteToken } from './invite-token.js';
import { createBusiness } from './services/business.js';
import {
  acceptInvite,
  createInvite,
  INVITE_LIFETIME_MS,
  INVITE_LIMIT_PER_BUSINESS,
  listInvites,
  previewInvite,
  revokeInvite,
  type Invitee,
} from './services/invites.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// Invites against real Postgres (ADR-0014): who may invite as what, the link's lifetime and
// single use, the email binding, other businesses, the limit, and an audit entry per change.

let database: TestDatabase;
let db: Database;
let counter = 0;
const clock = new ManualClock('2026-10-17T12:00:00.000Z');

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}`;
}

interface Team {
  tenantId: TenantId;
  owner: UserId;
  manager: UserId;
  staff: UserId;
}

async function newTeam(): Promise<Team> {
  const owner = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, owner, {
    name: 'Juniper Hair Studio',
    slug: unique('juniper'),
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const [manager, staff] = [await insertUser(db, 'Marco'), await insertUser(db, 'Priya')];
  await withTenant(db, tenantId, async (tx) => {
    await addMembership(tx, { userId: manager, role: 'manager' });
    await addMembership(tx, { userId: staff, role: 'staff' });
  });
  return { tenantId, owner, manager, staff };
}

function as(team: Team, userId: UserId, role: MembershipRole, requestId?: string): Actor {
  return { context: { tenantId: team.tenantId, userId, role }, requestId };
}

/** A signed-up person who has not joined yet. */
async function newInvitee(): Promise<Invitee> {
  const email = `${unique('jess')}@example.test`;
  return { userId: await insertUser(db, 'Jess', email), email };
}

const options = { clock };

async function invite(team: Team, email: string, role: MembershipRole = 'staff') {
  return createInvite(db, as(team, team.owner, 'owner'), { email, role }, options);
}

async function auditActions(team: Team) {
  const entries = await withTenant(db, team.tenantId, (tx) => listAuditEntries(tx, { limit: 100 }));
  return entries.reverse();
}

describe('createInvite and listInvites', () => {
  it('creates an invite with a 7-day link, lists it without its token and audits it', async () => {
    const team = await newTeam();
    const { invite: created, token } = await createInvite(
      db,
      as(team, team.owner, 'owner', 'req-invite-1'),
      { email: ' Jess.New@Example.TEST ', role: 'manager' },
      options,
    );
    expect(InviteTokenSchema.safeParse(token).success).toBe(true);
    expect(created).toMatchObject({
      email: 'jess.new@example.test',
      role: 'manager',
      invitedBy: team.owner,
      expiresAt: new Date(clock.now().getTime() + INVITE_LIFETIME_MS).toISOString(),
    });
    const listed = await listInvites(db, as(team, team.manager, 'manager'), options);
    expect(listed).toEqual([created]);
    expect(JSON.stringify(listed)).not.toContain(token);
    const [entry] = (await auditActions(team)).filter((e) => e.action === 'invite.created');
    expect(entry).toMatchObject({
      actor: { kind: 'user', userId: team.owner },
      entity: { type: 'invite', id: created.id },
      before: null,
      after: { role: 'manager', expiresAt: created.expiresAt },
    });
    // No email in the audit log.
    expect(JSON.stringify(await auditActions(team))).not.toContain('jess.new');
  });

  it.each<[MembershipRole, MembershipRole, boolean]>([
    ['owner', 'owner', true],
    ['owner', 'manager', true],
    ['owner', 'staff', true],
    ['manager', 'owner', false],
    ['manager', 'manager', true],
    ['manager', 'staff', true],
    ['staff', 'staff', false],
  ])('a(n) %s inviting as %s: allowed %s', async (actorRole, role, allowed) => {
    const team = await newTeam();
    const actor = as(team, team[actorRole], actorRole);
    const result = createInvite(db, actor, { email: `${unique('x')}@example.test`, role }, options);
    if (allowed) await expect(result).resolves.toMatchObject({ invite: { role } });
    else await expect(result).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('re-reads the actor role: a manager demoted since the request was authorised cannot invite', async () => {
    const team = await newTeam();
    await withTenant(db, team.tenantId, (tx) => updateMembershipRole(tx, team.manager, 'staff'));
    await expect(
      createInvite(
        db,
        as(team, team.manager, 'manager'),
        { email: `${unique('x')}@example.test`, role: 'staff' },
        options,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('staff can neither list nor create invites', async () => {
    const team = await newTeam();
    const staff = as(team, team.staff, 'staff');
    await expect(listInvites(db, staff, options)).rejects.toThrow(
      new ForbiddenError('members.read'),
    );
    await expect(
      createInvite(db, staff, { email: 'a@example.test', role: 'staff' }, options),
    ).rejects.toThrow(new ForbiddenError('members.invite'));
  });

  it('refuses to invite someone who is already a member', async () => {
    const team = await newTeam();
    const member = await newInvitee();
    await withTenant(db, team.tenantId, (tx) =>
      addMembership(tx, { userId: member.userId, role: 'staff' }),
    );
    await expect(invite(team, member.email.toUpperCase())).rejects.toBeInstanceOf(
      AlreadyAMemberError,
    );
  });

  it('inviting the same email again replaces the earlier link', async () => {
    const team = await newTeam();
    const invitee = await newInvitee();
    const first = await invite(team, invitee.email);
    const second = await invite(team, invitee.email, 'manager');
    await expect(acceptInvite(db, invitee, first.token, options)).rejects.toBeInstanceOf(
      InviteInvalidError,
    );
    const listed = await listInvites(db, as(team, team.owner, 'owner'), options);
    expect(listed.map((i) => i.id)).toEqual([second.invite.id]);
    const actions = (await auditActions(team)).map((e) => e.action);
    expect(actions.slice(-3)).toEqual(['invite.created', 'invite.revoked', 'invite.created']);
    await expect(acceptInvite(db, invitee, second.token, options)).resolves.toMatchObject({
      role: 'manager',
    });
  });

  it("a manager cannot replace an owner's invite to become an owner", async () => {
    const team = await newTeam();
    const email = `${unique('future-owner')}@example.test`;
    await invite(team, email, 'owner');
    await expect(
      createInvite(db, as(team, team.manager, 'manager'), { email, role: 'staff' }, options),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it(`stops at ${String(INVITE_LIMIT_PER_BUSINESS)} open invites; expired ones do not count`, async () => {
    const team = await newTeam();
    const local = new ManualClock(clock.now());
    const emails = Array.from(
      { length: INVITE_LIMIT_PER_BUSINESS },
      () => `${unique('bulk')}@example.test`,
    );
    for (const email of emails) {
      await createInvite(
        db,
        as(team, team.owner, 'owner'),
        { email, role: 'staff' },
        { clock: local },
      );
    }
    const one = { email: `${unique('one-more')}@example.test`, role: 'staff' } as const;
    await expect(
      createInvite(db, as(team, team.owner, 'owner'), one, { clock: local }),
    ).rejects.toBeInstanceOf(InviteLimitReachedError);
    // Replacing one of them is not an extra invite.
    await expect(
      createInvite(
        db,
        as(team, team.owner, 'owner'),
        { email: emails[0] ?? '', role: 'staff' },
        {
          clock: local,
        },
      ),
    ).resolves.toBeTruthy();
    local.advanceBy(INVITE_LIFETIME_MS);
    await expect(
      createInvite(db, as(team, team.owner, 'owner'), one, { clock: local }),
    ).resolves.toBeTruthy();
  });
});

describe('revokeInvite', () => {
  it('revokes an open invite: the link stops working and revoking again is not found', async () => {
    const team = await newTeam();
    const invitee = await newInvitee();
    const { invite: created, token } = await invite(team, invitee.email, 'manager');
    await revokeInvite(db, as(team, team.manager, 'manager'), created.id, options);
    await expect(acceptInvite(db, invitee, token, options)).rejects.toBeInstanceOf(
      InviteInvalidError,
    );
    await expect(
      revokeInvite(db, as(team, team.owner, 'owner'), created.id, options),
    ).rejects.toBeInstanceOf(InviteNotFoundError);
    const [entry] = (await auditActions(team)).filter((e) => e.action === 'invite.revoked');
    expect(entry).toMatchObject({
      actor: { userId: team.manager },
      entity: { id: created.id },
      before: { role: 'manager' },
    });
  });

  it('only owners revoke an owner invite; staff cannot revoke at all', async () => {
    const team = await newTeam();
    const { invite: created } = await invite(team, `${unique('o')}@example.test`, 'owner');
    await expect(
      revokeInvite(db, as(team, team.manager, 'manager'), created.id, options),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      revokeInvite(db, as(team, team.staff, 'staff'), created.id, options),
    ).rejects.toThrow(new ForbiddenError('members.invite'));
    await expect(
      revokeInvite(db, as(team, team.owner, 'owner'), created.id, options),
    ).resolves.toBeUndefined();
  });

  it("another business's invite is not found there, and not listed", async () => {
    const team = await newTeam();
    const other = await newTeam();
    const { invite: created } = await invite(team, `${unique('x')}@example.test`);
    await expect(
      revokeInvite(db, as(other, other.owner, 'owner'), created.id, options),
    ).rejects.toBeInstanceOf(InviteNotFoundError);
    await expect(listInvites(db, as(other, other.owner, 'owner'), options)).resolves.toEqual([]);
    await expect(listInvites(db, as(team, team.owner, 'owner'), options)).resolves.toHaveLength(1);
  });
});

describe('previewInvite and acceptInvite', () => {
  it('shows the business, then makes the invitee a member, audited, once', async () => {
    const team = await newTeam();
    const invitee = await newInvitee();
    const { invite: created, token } = await invite(team, invitee.email, 'manager');
    await expect(previewInvite(db, invitee, token, options)).resolves.toEqual({
      businessName: 'Juniper Hair Studio',
      role: 'manager',
      expiresAt: created.expiresAt,
    });
    const accepted = await acceptInvite(db, invitee, token, {
      ...options,
      requestId: 'req-accept',
    });
    expect(accepted).toEqual({ tenantId: team.tenantId, role: 'manager' });
    const membership = await withTenant(db, team.tenantId, (tx) =>
      findMembership(tx, invitee.userId),
    );
    expect(membership?.role).toBe('manager');
    const [entry] = (await auditActions(team)).filter((e) => e.action === 'invite.accepted');
    expect(entry).toMatchObject({
      actor: { kind: 'user', userId: invitee.userId },
      entity: { type: 'invite', id: created.id },
      before: { role: 'manager' },
      after: { userId: invitee.userId, role: 'manager', membershipId: membership?.id },
    });
    await expect(listInvites(db, as(team, team.owner, 'owner'), options)).resolves.toEqual([]);
    // Reused: the link is spent, even for the same person.
    await expect(acceptInvite(db, invitee, token, options)).rejects.toBeInstanceOf(
      InviteInvalidError,
    );
    await expect(previewInvite(db, invitee, token, options)).rejects.toBeInstanceOf(
      InviteInvalidError,
    );
  });

  it('expires after 7 days', async () => {
    const team = await newTeam();
    const invitee = await newInvitee();
    const local = new ManualClock(clock.now());
    const { token } = await createInvite(
      db,
      as(team, team.owner, 'owner'),
      { email: invitee.email, role: 'staff' },
      { clock: local },
    );
    local.advanceBy(INVITE_LIFETIME_MS - 1);
    await expect(previewInvite(db, invitee, token, { clock: local })).resolves.toBeTruthy();
    local.advanceBy(1);
    await expect(previewInvite(db, invitee, token, { clock: local })).rejects.toBeInstanceOf(
      InviteInvalidError,
    );
    await expect(acceptInvite(db, invitee, token, { clock: local })).rejects.toBeInstanceOf(
      InviteInvalidError,
    );
  });

  it('works only for the email it was sent to; a forwarded link reveals nothing', async () => {
    const team = await newTeam();
    const invitee = await newInvitee();
    const stranger = await newInvitee();
    const { token } = await invite(team, invitee.email);
    await expect(previewInvite(db, stranger, token, options)).rejects.toBeInstanceOf(
      InviteWrongAccountError,
    );
    await expect(acceptInvite(db, stranger, token, options)).rejects.toBeInstanceOf(
      InviteWrongAccountError,
    );
    await expect(
      withTenant(db, team.tenantId, (tx) => findMembership(tx, stranger.userId)),
    ).resolves.toBeUndefined();
    // Still usable by the right person; their email is compared lowercased.
    await expect(
      acceptInvite(db, { ...invitee, email: invitee.email.toUpperCase() }, token, options),
    ).resolves.toMatchObject({ tenantId: team.tenantId });
  });

  it('an unknown token is invalid', async () => {
    const invitee = await newInvitee();
    const token: InviteToken = newInviteToken();
    await expect(previewInvite(db, invitee, token, options)).rejects.toBeInstanceOf(
      InviteInvalidError,
    );
    await expect(acceptInvite(db, invitee, token, options)).rejects.toBeInstanceOf(
      InviteInvalidError,
    );
  });

  it('someone who joined meanwhile is told they are already a member', async () => {
    const team = await newTeam();
    const invitee = await newInvitee();
    const { token } = await invite(team, invitee.email, 'manager');
    await withTenant(db, team.tenantId, (tx) =>
      addMembership(tx, { userId: invitee.userId, role: 'staff' }),
    );
    await expect(acceptInvite(db, invitee, token, options)).rejects.toBeInstanceOf(
      AlreadyAMemberError,
    );
    // Nothing changed: still staff.
    await expect(
      withTenant(db, team.tenantId, (tx) => findMembership(tx, invitee.userId)),
    ).resolves.toMatchObject({ role: 'staff' });
  });

  it('joins only the business of the invite, not the other businesses of its inviter', async () => {
    const team = await newTeam();
    const second = await createBusiness(db, team.owner, {
      name: 'Second',
      slug: unique('second'),
      timeZone: 'UTC',
    });
    const invitee = await newInvitee();
    const { token } = await invite(team, invitee.email);
    await acceptInvite(db, invitee, token, options);
    await expect(
      withTenant(db, TenantIdSchema.parse(second.id), (tx) => findMembership(tx, invitee.userId)),
    ).resolves.toBeUndefined();
  });

  it('concurrent acceptances of one link: exactly one wins (5 rounds)', async () => {
    for (let round = 0; round < 5; round++) {
      const team = await newTeam();
      const invitee = await newInvitee();
      const { token } = await invite(team, invitee.email);
      const results = await Promise.allSettled([
        acceptInvite(db, invitee, token, options),
        acceptInvite(db, invitee, token, options),
        acceptInvite(db, invitee, token, options),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const result of results) {
        if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(InviteInvalidError);
      }
      const accepted = (await auditActions(team)).filter((e) => e.action === 'invite.accepted');
      expect(accepted).toHaveLength(1);
    }
  });
});

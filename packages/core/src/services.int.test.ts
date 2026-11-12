import {
  TenantIdSchema,
  UsagePeriodSchema,
  type MembershipRole,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import {
  addMembership,
  BusinessLimitReachedError,
  countOwners,
  deleteMembership,
  findMembership,
  listAuditEntries,
  updateMembershipRole,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from './actor.js';
import { ManualClock } from './clock.js';
import { ForbiddenError, LastOwnerError, MemberNotFoundError } from './errors.js';
import { readAuditLog } from './services/audit.js';
import {
  BUSINESS_LIMIT_PER_OWNER,
  createBusiness,
  updateBookingPage,
} from './services/business.js';
import { changeMemberRole, listMembers, removeMember } from './services/team.js';
import { recordUsage, usageFor } from './services/usage.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The domain services against real Postgres: permission checks, the membership rules under
// concurrency, and an audit entry for every change, committed (or not) with the change.

let database: TestDatabase;
let db: Database;
let slugs = 0;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

interface Team {
  tenantId: TenantId;
  owner: UserId;
  manager: UserId;
  staff: UserId;
  colleague: UserId;
}

/** A business with an owner (who created it), a manager and two staff. */
async function newTeam(): Promise<Team> {
  slugs += 1;
  const owner = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, owner, {
    name: 'Juniper Hair Studio',
    slug: `juniper-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const [manager, staff, colleague] = [
    await insertUser(db, 'Marco'),
    await insertUser(db, 'Jess'),
    await insertUser(db, 'Priya'),
  ];
  await withTenant(db, tenantId, async (tx) => {
    await addMembership(tx, { userId: manager, role: 'manager' });
    await addMembership(tx, { userId: staff, role: 'staff' });
    await addMembership(tx, { userId: colleague, role: 'staff' });
  });
  return { tenantId, owner, manager, staff, colleague };
}

function as(team: Team, userId: UserId, role: MembershipRole, requestId?: string): Actor {
  return { context: { tenantId: team.tenantId, userId, role }, requestId };
}

async function roleOf(team: Team, userId: UserId) {
  return (await withTenant(db, team.tenantId, (tx) => findMembership(tx, userId)))?.role;
}

async function auditActions(team: Team) {
  const entries = await withTenant(db, team.tenantId, (tx) => listAuditEntries(tx, { limit: 100 }));
  return entries.map((e) => e.action).reverse();
}

describe('createBusiness', () => {
  it('creates the business, its owner and a tenant.created entry together', async () => {
    const team = await newTeam();
    await expect(roleOf(team, team.owner)).resolves.toBe('owner');
    const [entry] = await withTenant(db, team.tenantId, (tx) => listAuditEntries(tx, { limit: 1 }));
    expect(entry).toMatchObject({
      action: 'tenant.created',
      actor: { kind: 'user', userId: team.owner },
      entity: { type: 'tenant', id: team.tenantId },
      before: null,
      after: { timeZone: 'America/New_York', locale: 'en-US', ownerUserId: team.owner },
    });
  });

  it('records the industry template in tenant.created (ADR-0018)', async () => {
    const owner = await insertUser(db, 'Bo');
    const tenant = await createBusiness(db, owner, {
      name: 'Bo’s Barbers',
      slug: 'bos-barbers',
      timeZone: 'America/Chicago',
      templateId: 'barber',
    });
    expect(tenant.templateId).toBe('barber');
    const tenantId = TenantIdSchema.parse(tenant.id);
    const [entry] = await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 1 }));
    expect(entry?.after).toMatchObject({ templateId: 'barber' });
  });

  it(`stops at ${String(BUSINESS_LIMIT_PER_OWNER)} businesses per owner`, async () => {
    const owner = await insertUser(db, 'Serial');
    for (let i = 0; i < BUSINESS_LIMIT_PER_OWNER; i++) {
      await createBusiness(db, owner, { name: 'B', slug: `serial-${String(i)}`, timeZone: 'UTC' });
    }
    await expect(
      createBusiness(db, owner, { name: 'B', slug: 'serial-x', timeZone: 'UTC' }),
    ).rejects.toBeInstanceOf(BusinessLimitReachedError);
  });
});

describe('updateBookingPage (PCR-001, ADR-0022)', () => {
  it('sets and clears the color, auditing only real changes', async () => {
    const team = await newTeam();
    const manager = as(team, team.manager, 'manager', 'req-color');
    expect((await updateBookingPage(db, manager, { brandColor: '#7A3E6C' })).brandColor).toBe(
      '#7a3e6c',
    );
    await updateBookingPage(db, manager, { brandColor: '#7a3e6c' });
    expect((await updateBookingPage(db, manager, { brandColor: null })).brandColor).toBeNull();
    const entries = await withTenant(db, team.tenantId, (tx) =>
      listAuditEntries(tx, { limit: 10 }),
    );
    expect(
      entries.filter((e) => e.action === 'tenant.updated').map((e) => [e.before, e.after]),
    ).toEqual([
      [{ brandColor: '#7a3e6c' }, { brandColor: null }],
      [{ brandColor: null }, { brandColor: '#7a3e6c' }],
    ]);
  });

  it('sets the profile, keeps what is left out and audits which fields changed (S47)', async () => {
    const team = await newTeam();
    const owner = as(team, team.owner, 'owner', 'req-profile');
    await updateBookingPage(db, owner, { brandColor: '#7a3e6c' });
    const after = await updateBookingPage(db, owner, {
      phone: '555 123 4567',
      publicAddress: '12 Main St\nAustin, TX 78701',
    });
    expect(after).toMatchObject({
      brandColor: '#7a3e6c',
      phone: '+15551234567',
      publicAddress: '12 Main St\nAustin, TX 78701',
      cancellationPolicy: null,
    });
    await updateBookingPage(db, owner, { phone: '+15551234567' });
    await updateBookingPage(db, owner, { brandColor: null, cancellationPolicy: 'Cancel ahead.' });
    const entries = await withTenant(db, team.tenantId, (tx) =>
      listAuditEntries(tx, { limit: 10 }),
    );
    const changes = entries.filter((e) => e.action === 'tenant.updated');
    expect(changes.map((e) => [e.before, e.after])).toEqual([
      [
        { brandColor: '#7a3e6c', profileChanged: ['cancellationPolicy'] },
        { brandColor: null, profileChanged: ['cancellationPolicy'] },
      ],
      [
        { profileChanged: ['phone', 'publicAddress'] },
        { profileChanged: ['phone', 'publicAddress'] },
      ],
      [{ brandColor: null }, { brandColor: '#7a3e6c' }],
    ]);
    // Never the values themselves.
    expect(JSON.stringify(changes)).not.toContain('Main St');
  });

  it('is not for staff', async () => {
    const team = await newTeam();
    await expect(
      updateBookingPage(db, as(team, team.staff, 'staff'), { brandColor: '#7a3e6c' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      updateBookingPage(db, as(team, team.staff, 'staff'), { phone: '5551234567' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('listMembers', () => {
  it('lists the team for owners and managers', async () => {
    const team = await newTeam();
    for (const actor of [as(team, team.owner, 'owner'), as(team, team.manager, 'manager')]) {
      const members = await listMembers(db, actor);
      expect(members.map((m) => [m.name, m.role])).toEqual([
        ['Ana', 'owner'],
        ['Marco', 'manager'],
        ['Jess', 'staff'],
        ['Priya', 'staff'],
      ]);
      expect(members[0]?.joinedAt).toMatch(/Z$/);
    }
  });

  it('is forbidden for staff', async () => {
    const team = await newTeam();
    await expect(listMembers(db, as(team, team.staff, 'staff'))).rejects.toThrow(
      new ForbiddenError('members.read'),
    );
  });
});

describe('changeMemberRole', () => {
  it('changes the role and records who did it, from which request', async () => {
    const team = await newTeam();
    const member = await changeMemberRole(
      db,
      as(team, team.owner, 'owner', 'req-42'),
      team.staff,
      'manager',
    );
    expect(member).toMatchObject({ userId: team.staff, name: 'Jess', role: 'manager' });
    const [entry] = await withTenant(db, team.tenantId, (tx) => listAuditEntries(tx, { limit: 1 }));
    expect(entry).toMatchObject({
      action: 'membership.role_changed',
      actor: { kind: 'user', userId: team.owner },
      before: { userId: team.staff, role: 'staff' },
      after: { userId: team.staff, role: 'manager' },
    });
  });

  it('records nothing for a change to the same role', async () => {
    const team = await newTeam();
    await changeMemberRole(db, as(team, team.owner, 'owner'), team.staff, 'staff');
    await expect(auditActions(team)).resolves.toEqual(['tenant.created']);
  });

  it.each([
    ['promote someone to owner', (t: Team) => [t.staff, 'owner'] as const],
    ['demote an owner', (t: Team) => [t.owner, 'staff'] as const],
    ['promote themselves to owner', (t: Team) => [t.manager, 'owner'] as const],
  ])('a manager cannot %s', async (_label, pick) => {
    const team = await newTeam();
    const [target, role] = pick(team);
    await expect(
      changeMemberRole(db, as(team, team.manager, 'manager'), target, role),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(roleOf(team, target)).resolves.not.toBe(role);
    await expect(auditActions(team)).resolves.toEqual(['tenant.created']);
  });

  it('a manager can promote staff to manager', async () => {
    const team = await newTeam();
    await changeMemberRole(db, as(team, team.manager, 'manager'), team.staff, 'manager');
    await expect(roleOf(team, team.staff)).resolves.toBe('manager');
  });

  it('staff cannot change roles, not even their own', async () => {
    const team = await newTeam();
    for (const target of [team.staff, team.colleague]) {
      await expect(
        changeMemberRole(db, as(team, team.staff, 'staff'), target, 'manager'),
      ).rejects.toThrow(new ForbiddenError('members.manage'));
    }
  });

  it('refuses a user from another business as not found', async () => {
    const team = await newTeam();
    const other = await newTeam();
    await expect(
      changeMemberRole(db, as(team, team.owner, 'owner'), other.staff, 'manager'),
    ).rejects.toBeInstanceOf(MemberNotFoundError);
    await expect(roleOf(other, other.staff)).resolves.toBe('staff');
  });

  it('uses the role the actor has now, not the one the request started with', async () => {
    const team = await newTeam();
    // The owner demoted the manager after the manager's request was authorised.
    await withTenant(db, team.tenantId, (tx) => updateMembershipRole(tx, team.manager, 'staff'));
    await expect(
      changeMemberRole(db, as(team, team.manager, 'manager'), team.staff, 'manager'),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // ...or removed them.
    await withTenant(db, team.tenantId, (tx) => deleteMembership(tx, team.manager));
    await expect(
      changeMemberRole(db, as(team, team.manager, 'manager'), team.staff, 'manager'),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('keeps the last owner', async () => {
    const team = await newTeam();
    await expect(
      changeMemberRole(db, as(team, team.owner, 'owner'), team.owner, 'manager'),
    ).rejects.toBeInstanceOf(LastOwnerError);
    await expect(roleOf(team, team.owner)).resolves.toBe('owner');
  });
});

describe('removeMember', () => {
  it('a manager removes staff, with an audit entry', async () => {
    const team = await newTeam();
    await removeMember(db, as(team, team.manager, 'manager'), team.staff);
    await expect(roleOf(team, team.staff)).resolves.toBeUndefined();
    const [entry] = await withTenant(db, team.tenantId, (tx) => listAuditEntries(tx, { limit: 1 }));
    expect(entry).toMatchObject({
      action: 'membership.removed',
      actor: { kind: 'user', userId: team.manager },
      before: { userId: team.staff, role: 'staff' },
      after: null,
    });
  });

  it('a manager cannot remove an owner', async () => {
    const team = await newTeam();
    await expect(
      removeMember(db, as(team, team.manager, 'manager'), team.owner),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('staff may leave, but not remove others (nor learn whether someone is a member)', async () => {
    const team = await newTeam();
    const stranger = await insertUser(db, 'Stranger');
    for (const target of [team.colleague, stranger]) {
      await expect(removeMember(db, as(team, team.staff, 'staff'), target)).rejects.toThrow(
        new ForbiddenError('members.manage'),
      );
    }
    await removeMember(db, as(team, team.staff, 'staff'), team.staff);
    await expect(roleOf(team, team.staff)).resolves.toBeUndefined();
    await expect(auditActions(team)).resolves.toEqual(['tenant.created', 'membership.removed']);
  });

  it("recognises the actor's own id in any letter case as leaving", async () => {
    const team = await newTeam();
    const upper = team.staff.toUpperCase() as UserId;
    await removeMember(db, as(team, team.staff, 'staff'), upper);
    await expect(roleOf(team, team.staff)).resolves.toBeUndefined();
  });

  it('the last owner cannot leave; one of two owners can', async () => {
    const team = await newTeam();
    const owner = as(team, team.owner, 'owner');
    await expect(removeMember(db, owner, team.owner)).rejects.toBeInstanceOf(LastOwnerError);
    await changeMemberRole(db, owner, team.manager, 'owner');
    await removeMember(db, owner, team.owner);
    await expect(roleOf(team, team.owner)).resolves.toBeUndefined();
  });

  it('refuses someone who is not a member', async () => {
    const team = await newTeam();
    const stranger = await insertUser(db, 'Stranger');
    await expect(removeMember(db, as(team, team.owner, 'owner'), stranger)).rejects.toBeInstanceOf(
      MemberNotFoundError,
    );
  });
});

describe('concurrent changes keep an owner', () => {
  it.each(Array.from({ length: 5 }, (_, i) => i))(
    'two owners demoting each other at once: one wins (round %d)',
    async () => {
      const team = await newTeam();
      const owner = as(team, team.owner, 'owner');
      await changeMemberRole(db, owner, team.manager, 'owner');
      const coOwner = as(team, team.manager, 'owner');
      const results = await Promise.allSettled([
        changeMemberRole(db, owner, team.manager, 'staff'),
        changeMemberRole(db, coOwner, team.owner, 'staff'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      await expect(withTenant(db, team.tenantId, countOwners)).resolves.toBe(1);
    },
  );

  it.each(Array.from({ length: 5 }, (_, i) => i))(
    'two owners leaving at once: one stays (round %d)',
    async () => {
      const team = await newTeam();
      const owner = as(team, team.owner, 'owner');
      await changeMemberRole(db, owner, team.manager, 'owner');
      const results = await Promise.allSettled([
        removeMember(db, owner, team.owner),
        removeMember(db, as(team, team.manager, 'owner'), team.manager),
      ]);
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(LastOwnerError);
      await expect(withTenant(db, team.tenantId, countOwners)).resolves.toBe(1);
    },
  );
});

describe('readAuditLog', () => {
  it("pages through the business's own entries for owners and managers", async () => {
    const team = await newTeam();
    const other = await newTeam();
    const owner = as(team, team.owner, 'owner');
    await changeMemberRole(db, owner, team.staff, 'manager');
    await changeMemberRole(db, owner, team.staff, 'staff');

    const first = await readAuditLog(db, as(team, team.manager, 'manager'), { limit: 2 });
    expect(first.entries.map((e) => e.action)).toEqual([
      'membership.role_changed',
      'membership.role_changed',
    ]);
    expect(first.nextBefore).toBe(first.entries[1]?.id);
    const second = await readAuditLog(db, owner, { limit: 2, before: first.nextBefore ?? '' });
    expect(second.entries.map((e) => e.action)).toEqual(['tenant.created']);
    expect(second.entries[0]?.entity.id).toBe(team.tenantId);
    expect(second.nextBefore).toBeNull();
    // The other business's entries never appear.
    const all = await readAuditLog(db, owner, { limit: 100 });
    expect(all.entries.some((e) => e.entity.id === other.tenantId)).toBe(false);
  });

  it('is forbidden for staff', async () => {
    const team = await newTeam();
    await expect(readAuditLog(db, as(team, team.staff, 'staff'))).rejects.toThrow(
      new ForbiddenError('audit.read'),
    );
  });
});

describe('usage', () => {
  it('meters into the UTC month of the clock and reports every metric', async () => {
    const team = await newTeam();
    const clock = new ManualClock('2026-10-31T23:59:59.000Z');
    await recordUsage(db, team.tenantId, { metric: 'llm_tokens', amount: 900 }, clock);
    clock.advanceBy(1_000); // 2026-11-01T00:00:00Z
    await recordUsage(db, team.tenantId, { metric: 'llm_tokens', amount: 100 }, clock);
    await recordUsage(db, team.tenantId, { metric: 'emails_sent', amount: 1 }, clock);
    await expect(usageFor(db, team.tenantId, UsagePeriodSchema.parse('2026-10'))).resolves.toEqual({
      llm_tokens: 900,
      emails_sent: 0,
      sms_segments: 0,
    });
    await expect(usageFor(db, team.tenantId, UsagePeriodSchema.parse('2026-11'))).resolves.toEqual({
      llm_tokens: 100,
      emails_sent: 1,
      sms_segments: 0,
    });
  });
});

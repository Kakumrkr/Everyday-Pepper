import { randomBytes } from 'node:crypto';
import { TenantIdSchema, type TenantId, type UserId } from '@pepper/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { isUniqueViolation } from './errors.js';
import { newId } from './ids.js';
import {
  countOpenInvites,
  insertInvite,
  listOpenInvites,
  lockInvite,
  lockUnresolvedInvitesFor,
  markInviteAccepted,
  revokeInvite,
  withInviteTenant,
  type NewInvite,
} from './repositories/invites.js';
import { addMembership, isMemberEmail } from './repositories/memberships.js';
import { createTenant } from './repositories/tenants.js';
import { invites, users } from './schema.js';
import { withTenant } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

// The invite repository against real Postgres (ADR-0014). Isolation of the table and of the
// token lookup is in isolation.int.test.ts.

let database: TestDatabase;
let db: Database;
let tenant: TenantId;
let inviter: UserId;
let slugs = 0;

const NOW = new Date('2026-10-17T12:00:00.000Z');
const DAY = 86_400_000;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  tenant = await newTenant();
  inviter = await insertUser(db, 'Ana');
});

afterAll(async () => {
  await database.stop();
});

async function newTenant(): Promise<TenantId> {
  slugs += 1;
  const created = await createTenant(db, {
    name: 'Juniper',
    slug: `invites-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  return TenantIdSchema.parse(created.id);
}

function hash(): string {
  return randomBytes(32).toString('hex');
}

function invite(overrides: Partial<NewInvite> = {}): NewInvite {
  return {
    email: `jess-${newId()}@example.test`,
    role: 'staff',
    tokenHash: hash(),
    invitedBy: inviter,
    expiresAt: new Date(NOW.getTime() + 7 * DAY),
    ...overrides,
  };
}

function inTenant<T>(work: Parameters<typeof withTenant<T>>[2], on: TenantId = tenant) {
  return withTenant(db, on, work);
}

describe('insertInvite', () => {
  it('stores the invite with a lowercased email and returns it', async () => {
    const input = invite({ email: '  Jess.Lee@Example.TEST ' });
    const created = await inTenant((tx) => insertInvite(tx, input));
    expect(created).toMatchObject({
      tenantId: tenant,
      email: 'jess.lee@example.test',
      role: 'staff',
      tokenHash: input.tokenHash,
      invitedByUserId: inviter,
      acceptedAt: null,
      revokedAt: null,
    });
    await inTenant((tx) => revokeInvite(tx, created.id, NOW));
  });

  it('rejects a second unresolved invite for the same email in a business', async () => {
    const email = `twice-${newId()}@example.test`;
    await inTenant((tx) => insertInvite(tx, invite({ email })));
    const error = await inTenant((tx) => insertInvite(tx, invite({ email }))).catch(
      (e: unknown) => e,
    );
    expect(isUniqueViolation(error, 'invites_open_email_unique')).toBe(true);
    // ...but another business may invite the same person.
    const other = await newTenant();
    await expect(
      inTenant((tx) => insertInvite(tx, invite({ email })), other),
    ).resolves.toBeTruthy();
  });

  it('allows a new invite once the earlier one is resolved', async () => {
    const email = `again-${newId()}@example.test`;
    const first = await inTenant((tx) => insertInvite(tx, invite({ email })));
    await inTenant((tx) => revokeInvite(tx, first.id, NOW));
    await expect(inTenant((tx) => insertInvite(tx, invite({ email })))).resolves.toBeTruthy();
  });

  it.each([
    ['a token hash that is not SHA-256 hex', `UPDATE invites SET token_hash = 'plain-token'`],
    ['an email with capitals', `UPDATE invites SET email = 'Jess@Example.test'`],
    ['accepted and revoked at once', 'UPDATE invites SET accepted_at = now(), revoked_at = now()'],
  ])('the database refuses %s', async (_label, statement) => {
    const created = await inTenant((tx) => insertInvite(tx, invite()));
    const error = await inTenant((tx) =>
      tx.execute(sql.raw(`${statement} WHERE id = '${created.id}'`)),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514'); // check_violation
    await inTenant((tx) => revokeInvite(tx, created.id, NOW));
  });

  it('the token hash is unique across businesses', async () => {
    const tokenHash = hash();
    await inTenant((tx) => insertInvite(tx, invite({ tokenHash })));
    const other = await newTenant();
    const error = await inTenant((tx) => insertInvite(tx, invite({ tokenHash })), other).catch(
      (e: unknown) => e,
    );
    expect(isUniqueViolation(error, 'invites_token_hash_unique')).toBe(true);
  });
});

describe('open invites', () => {
  it('lists and counts only invites that are neither accepted, revoked nor expired', async () => {
    const business = await newTenant();
    const accepter = await insertUser(db, 'Jess');
    const ids = await withTenant(db, business, async (tx) => {
      const open = await insertInvite(tx, invite());
      const newer = await insertInvite(tx, invite());
      const expired = await insertInvite(tx, invite({ expiresAt: NOW }));
      const revoked = await insertInvite(tx, invite());
      await revokeInvite(tx, revoked.id, NOW);
      const accepted = await insertInvite(tx, invite());
      await markInviteAccepted(tx, accepted.id, accepter, NOW);
      return { open: open.id, newer: newer.id, expired: expired.id };
    });
    const listed = await withTenant(db, business, (tx) => listOpenInvites(tx, NOW));
    expect(listed.map((i) => i.id)).toEqual([ids.newer, ids.open]);
    await expect(withTenant(db, business, (tx) => countOpenInvites(tx, NOW))).resolves.toBe(2);
    // The expired one is unresolved: it still blocks a duplicate until revoked or replaced.
    const unresolved = await withTenant(db, business, async (tx) => {
      const [row] = await tx.select().from(invites).where(eq(invites.id, ids.expired));
      return lockUnresolvedInvitesFor(tx, row?.email ?? '');
    });
    expect(unresolved.map((i) => i.id)).toEqual([ids.expired]);
  });
});

describe('resolving an invite', () => {
  it('revokes or accepts an unresolved invite only once', async () => {
    const accepter = await insertUser(db, 'Jess');
    const a = await inTenant((tx) => insertInvite(tx, invite()));
    const b = await inTenant((tx) => insertInvite(tx, invite()));
    const later = new Date(NOW.getTime() + 1_000);
    expect((await inTenant((tx) => revokeInvite(tx, a.id, NOW)))?.revokedAt).toEqual(NOW);
    await expect(inTenant((tx) => revokeInvite(tx, a.id, later))).resolves.toBeUndefined();
    await expect(
      inTenant((tx) => markInviteAccepted(tx, a.id, accepter, later)),
    ).resolves.toBeUndefined();

    const accepted = await inTenant((tx) => markInviteAccepted(tx, b.id, accepter, NOW));
    expect(accepted).toMatchObject({ acceptedAt: NOW, acceptedByUserId: accepter });
    await expect(
      inTenant((tx) => markInviteAccepted(tx, b.id, accepter, later)),
    ).resolves.toBeUndefined();
    await expect(inTenant((tx) => revokeInvite(tx, b.id, later))).resolves.toBeUndefined();
  });

  it("another business's invite cannot be locked, revoked or accepted", async () => {
    const created = await inTenant((tx) => insertInvite(tx, invite()));
    const other = await newTenant();
    const accepter = await insertUser(db, 'Jess');
    await expect(
      withTenant(db, other, (tx) => lockInvite(tx, created.id)),
    ).resolves.toBeUndefined();
    await expect(
      withTenant(db, other, (tx) => revokeInvite(tx, created.id, NOW)),
    ).resolves.toBeUndefined();
    await expect(
      withTenant(db, other, (tx) => markInviteAccepted(tx, created.id, accepter, NOW)),
    ).resolves.toBeUndefined();
    expect((await inTenant((tx) => lockInvite(tx, created.id)))?.revokedAt).toBeNull();
  });

  it('a locked invite makes a concurrent acceptance wait, then find it resolved', async () => {
    const created = await inTenant((tx) => insertInvite(tx, invite()));
    const [first, second] = await Promise.all(
      [await insertUser(db, 'One'), await insertUser(db, 'Two')].map((user) =>
        withInviteTenant(db, created.tokenHash, async (tx, found) => {
          const locked = await lockInvite(tx, found.id);
          await tx.execute(sql`SELECT pg_sleep(0.05)`);
          if (locked?.acceptedAt !== null) return 'already accepted';
          return (await markInviteAccepted(tx, found.id, user, NOW)) === undefined
            ? 'lost'
            : 'accepted';
        }),
      ),
    );
    expect([first, second].sort()).toEqual(['accepted', 'already accepted']);
  });
});

describe('deleting users', () => {
  it('nulls the inviter and accepter but keeps the invite', async () => {
    const ana = await insertUser(db, 'Ana');
    const jess = await insertUser(db, 'Jess');
    const created = await inTenant((tx) => insertInvite(tx, invite({ invitedBy: ana })));
    await inTenant((tx) => markInviteAccepted(tx, created.id, jess, NOW));
    await db.delete(users).where(eq(users.id, ana));
    await db.delete(users).where(eq(users.id, jess));
    const row = await inTenant((tx) => lockInvite(tx, created.id));
    expect(row).toMatchObject({ invitedByUserId: null, acceptedByUserId: null, acceptedAt: NOW });
  });
});

describe('isMemberEmail', () => {
  it('finds a member of this business by email, case-insensitively, and nobody elsewhere', async () => {
    const jess = await insertUser(db, 'Jess');
    const [row] = await db.select().from(users).where(eq(users.id, jess));
    const email = row?.email ?? '';
    await inTenant((tx) => addMembership(tx, { userId: jess, role: 'staff' }));
    await expect(inTenant((tx) => isMemberEmail(tx, email.toUpperCase()))).resolves.toBe(true);
    await expect(inTenant((tx) => isMemberEmail(tx, 'nobody@example.test'))).resolves.toBe(false);
    const other = await newTenant();
    await expect(withTenant(db, other, (tx) => isMemberEmail(tx, email))).resolves.toBe(false);
  });
});

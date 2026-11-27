// Approve by text (S63, ADR-0066) against real Postgres: a member's checked number, who gets
// cards by text, consents of two sources side by side, and the lookup behind "Y" and a code
// (`sms_approval_target`, ids only, this number's texts only). Part of the isolation evidence
// with isolation.int.test.ts.
import {
  OutboxMessageIdSchema,
  TenantIdSchema,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import {
  insertApprovalText,
  listCardTextRecipients,
  lockApprovalText,
  markApprovalTextUsed,
  setMembershipCardTexts,
  smsApprovalTarget,
} from './repositories/approval-texts.js';
import { scheduleCurrentTenantDeletion } from './repositories/deletion.js';
import { addMembership } from './repositories/memberships.js';
import { insertOutboxMessage } from './repositories/outbox.js';
import { insertClient } from './repositories/clients.js';
import { findActiveSmsConsent, insertSmsConsent, revokeSmsConsent } from './repositories/sms.js';
import { createTenant } from './repositories/tenants.js';
import { insertProposal } from './repositories/trust.js';
import {
  countUserPhoneCheckMiss,
  findUserPhone,
  lockUserPhone,
  setVerifiedUserPhone,
  startUserPhoneCheck,
} from './repositories/user-phones.js';
import { withTenant, type TenantTx } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

const SHOWN = 'Text me cards that need my OK from A at this number. Reply STOP to opt out.';
// Years ahead: a card's proposal is stamped with the database's real time, so a clock in the past
// would make it expire before it was created (these failed from 2026-11-14 on).
const T0 = new Date('2036-11-13T15:00:00Z');
const HOUR = 3_600_000;
let database: TestDatabase;
let db: Database;
let tenantA: TenantId;
let tenantB: TenantId;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  tenantA = TenantIdSchema.parse(
    (await createTenant(db, { name: 'A', slug: 'approve-a', timeZone: 'America/New_York' })).id,
  );
  tenantB = TenantIdSchema.parse(
    (await createTenant(db, { name: 'B', slug: 'approve-b', timeZone: 'America/Chicago' })).id,
  );
});

afterAll(async () => {
  await database.stop();
});

/** A number of its own for each test, so texts and lookups never meet. */
function phone(): string {
  return `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
}

const hash = () => randomBytes(32).toString('hex');

async function proposal(tx: TenantTx): Promise<string> {
  const row = await insertProposal(tx, {
    action: 'message.waitlist_offer',
    tool: 'send_waitlist_offers',
    targetKey: `waitlist_match:${newId()}`,
    idempotencyKey: `seed:${newId()}`,
    payload: { matchId: newId() },
    preview: { offers: 2 },
    fingerprint: 'f'.repeat(64),
    explanation: {
      requestMessageId: null,
      steps: [],
      facts: [],
      alternatives: [],
      untrustedContext: false,
      decision: { outcome: 'propose', reason: 'setting' },
    },
    requestedBy: null,
    recordOwner: null,
    expiresAt: new Date(T0.getTime() + 24 * HOUR),
  });
  if (row === undefined) throw new Error('proposal not stored');
  return row.id;
}

/** Queues an approval text in the business; its id. */
async function text(
  tenantId: TenantId,
  input: { phone: string; codeHash: string; userId: UserId; expiresAt?: Date; createdAt?: Date },
): Promise<string> {
  return withTenant(db, tenantId, async (tx) => {
    const id = OutboxMessageIdSchema.parse(newId());
    await insertOutboxMessage(tx, {
      id,
      type: 'sms',
      dedupeKey: `approval:${id}`,
      payload: randomBytes(16),
      availableAt: T0,
    });
    await insertApprovalText(tx, {
      id,
      proposalId: await proposal(tx),
      userId: input.userId,
      phone: input.phone,
      fingerprint: 'f'.repeat(64),
      codeHash: input.codeHash,
      expiresAt: input.expiresAt ?? new Date(T0.getTime() + 2 * HOUR),
      createdAt: input.createdAt ?? T0,
    });
    return id;
  });
}

describe('sms_approval_target (AC-X-83…85)', () => {
  it('answers only this number’s text with this code, across businesses, ids only', async () => {
    const owner = await insertUser(db);
    const mine = phone();
    const code = hash();
    const id = await text(tenantB, { phone: mine, codeHash: code, userId: owner });
    const at = new Date(T0.getTime() + 60_000);
    expect(await smsApprovalTarget(db, mine, code, at)).toEqual({
      tenantId: tenantB,
      approvalTextId: id,
      live: true,
    });
    // Spoof: the right code from another number, or a wrong code from the right one.
    expect(await smsApprovalTarget(db, phone(), code, at)).toBeUndefined();
    expect(await smsApprovalTarget(db, mine, hash(), at)).toBeUndefined();
    // Not a number Pepper texts, or not a hash: nothing, without a query error.
    expect(await smsApprovalTarget(db, '+4420', code, at)).toBeUndefined();
    expect(await smsApprovalTarget(db, mine, 'nope', at)).toBeUndefined();
  });

  it('prefers a live text; a used or expired one answers not live for a day, then nothing', async () => {
    const owner = await insertUser(db);
    const mine = phone();
    const code = hash();
    const old = await text(tenantA, {
      phone: mine,
      codeHash: code,
      userId: owner,
      expiresAt: new Date(T0.getTime() + HOUR),
    });
    const at = new Date(T0.getTime() + 2 * HOUR);
    expect(await smsApprovalTarget(db, mine, code, at)).toMatchObject({
      approvalTextId: old,
      live: false,
    });
    const live = await text(tenantA, {
      phone: mine,
      codeHash: code,
      userId: owner,
      createdAt: new Date(T0.getTime() + HOUR),
      expiresAt: new Date(T0.getTime() + 3 * HOUR),
    });
    expect(await smsApprovalTarget(db, mine, code, at)).toMatchObject({
      approvalTextId: live,
      live: true,
    });
    expect(await withTenant(db, tenantA, (tx) => markApprovalTextUsed(tx, live, at))).toBe(true);
    // Once: a second use changes nothing.
    expect(await withTenant(db, tenantA, (tx) => markApprovalTextUsed(tx, live, at))).toBe(false);
    expect(await smsApprovalTarget(db, mine, code, at)).toMatchObject({
      approvalTextId: live,
      live: false,
    });
    expect(
      await smsApprovalTarget(db, mine, code, new Date(T0.getTime() + 28 * HOUR)),
    ).toBeUndefined();
    const row = await withTenant(db, tenantA, (tx) => lockApprovalText(tx, live));
    expect(row?.usedAt).toEqual(at);
  });

  it('leaves out a business being deleted, and a text from the future', async () => {
    const owner = await insertUser(db);
    const tenant = TenantIdSchema.parse(
      (
        await createTenant(db, {
          name: 'C',
          slug: `approve-c-${newId().slice(0, 8)}`,
          timeZone: 'UTC',
        })
      ).id,
    );
    const mine = phone();
    const code = hash();
    await text(tenant, { phone: mine, codeHash: code, userId: owner });
    expect(
      await smsApprovalTarget(db, mine, code, new Date(T0.getTime() - 60_000)),
    ).toBeUndefined();
    await withTenant(db, tenant, (tx) =>
      scheduleCurrentTenantDeletion(tx, new Date(T0.getTime() + 30 * 24 * HOUR)),
    );
    expect(
      await smsApprovalTarget(db, mine, code, new Date(T0.getTime() + 60_000)),
    ).toBeUndefined();
  });

  it('is invisible to another business: the row is RLS-scoped, only the function crosses', async () => {
    const owner = await insertUser(db);
    const id = await text(tenantA, { phone: phone(), codeHash: hash(), userId: owner });
    expect(await withTenant(db, tenantB, (tx) => lockApprovalText(tx, id))).toBeUndefined();
    expect(await withTenant(db, tenantB, (tx) => markApprovalTextUsed(tx, id, T0))).toBe(false);
  });
});

describe('who gets cards by text (AC-X-81, AC-X-82)', () => {
  it('owners and managers with the switch on, a checked number and their own consent', async () => {
    const tenant = TenantIdSchema.parse(
      (
        await createTenant(db, {
          name: 'D',
          slug: `approve-d-${newId().slice(0, 8)}`,
          timeZone: 'UTC',
        })
      ).id,
    );
    const people = await Promise.all(
      ['owner', 'manager', 'staff', 'unchecked', 'noconsent'].map(() => insertUser(db)),
    );
    const [owner, manager, staff, unchecked, noConsent] = people as [
      UserId,
      UserId,
      UserId,
      UserId,
      UserId,
    ];
    const numbers = new Map(people.map((user) => [user, phone()]));
    // A reply approves only with a second factor (as a session would).
    for (const user of people) {
      await db.execute(sql`UPDATE users SET two_factor_enabled = true WHERE id = ${user}`);
    }
    for (const user of [owner, manager, staff, noConsent]) {
      const number = numbers.get(user) ?? '';
      await startUserPhoneCheck(db, {
        userId: user,
        phone: number,
        codeHash: hash(),
        expiresAt: T0,
      });
      await setVerifiedUserPhone(db, user, number, T0);
    }
    await withTenant(db, tenant, async (tx) => {
      await addMembership(tx, { userId: owner, role: 'owner' });
      await addMembership(tx, { userId: manager, role: 'manager' });
      await addMembership(tx, { userId: staff, role: 'staff' });
      await addMembership(tx, { userId: unchecked, role: 'manager' });
      await addMembership(tx, { userId: noConsent, role: 'manager' });
      for (const user of people) {
        expect(await setMembershipCardTexts(tx, user, true)).toBe(true);
        if (user === noConsent) continue;
        await insertSmsConsent(tx, {
          phone: numbers.get(user) ?? '',
          source: 'member_settings',
          userId: user,
          wordingVersion: 'sms-consent-v2',
          shownText: SHOWN,
          givenAt: T0,
        });
      }
    });
    const recipients = await withTenant(db, tenant, (tx) => listCardTextRecipients(tx));
    expect(recipients).toEqual([
      { userId: owner, phone: numbers.get(owner) },
      { userId: manager, phone: numbers.get(manager) },
    ]);
    await withTenant(db, tenant, (tx) => setMembershipCardTexts(tx, manager, false));
    expect(await withTenant(db, tenant, (tx) => listCardTextRecipients(tx))).toEqual([
      { userId: owner, phone: numbers.get(owner) },
    ]);
    // Without a second factor: no texts.
    await db.execute(sql`UPDATE users SET two_factor_enabled = false WHERE id = ${owner}`);
    expect(await withTenant(db, tenant, (tx) => listCardTextRecipients(tx))).toEqual([]);
    // Another business sees none of them.
    expect(await withTenant(db, tenantB, (tx) => listCardTextRecipients(tx))).toEqual([]);
  });

  it('keeps a client’s consent and a member’s own side by side for one number (S63)', async () => {
    const number = phone();
    const member = await insertUser(db);
    await withTenant(db, tenantA, async (tx) => {
      const client = await insertClient(tx, {
        name: 'Sam Lee',
        email: null,
        phone: number,
        source: 'team',
      });
      await insertSmsConsent(tx, {
        phone: number,
        source: 'booking_page',
        clientId: client.id,
        wordingVersion: 'sms-consent-v1',
        shownText: SHOWN,
        givenAt: T0,
      });
      const { replaced } = await insertSmsConsent(tx, {
        phone: number,
        source: 'member_settings',
        userId: member,
        wordingVersion: 'sms-consent-v2',
        shownText: SHOWN,
        givenAt: T0,
      });
      expect(replaced).toBeNull();
      // Stopping the client's texts leaves the member's own.
      expect(await revokeSmsConsent(tx, number, 'booking_page', T0)).not.toBeNull();
      expect((await findActiveSmsConsent(tx, number))?.source).toBe('member_settings');
    });
  });
});

describe('a member’s checked number (AC-X-80)', () => {
  it('starts, counts misses, replaces a check and keeps the verified number apart', async () => {
    const user = await insertUser(db);
    const first = phone();
    await startUserPhoneCheck(db, { userId: user, phone: first, codeHash: hash(), expiresAt: T0 });
    await countUserPhoneCheckMiss(db, user);
    await countUserPhoneCheckMiss(db, user);
    expect(await lockUserPhone(db, user)).toMatchObject({
      checkPhone: first,
      checkAttempts: 2,
      phone: null,
    });
    const second = phone();
    await startUserPhoneCheck(db, { userId: user, phone: second, codeHash: hash(), expiresAt: T0 });
    expect(await findUserPhone(db, user)).toMatchObject({ checkPhone: second, checkAttempts: 0 });
    await setVerifiedUserPhone(db, user, second, T0);
    expect(await findUserPhone(db, user)).toMatchObject({
      phone: second,
      verifiedAt: T0,
      checkPhone: null,
      checkHash: null,
      checkAttempts: 0,
    });
  });

  it('refuses a number Pepper can’t text and a half-made check', async () => {
    const user = await insertUser(db);
    let error: unknown;
    try {
      await db.execute(
        sql`INSERT INTO user_phones (user_id, check_phone) VALUES (${user}, '+15551234567')`,
      );
    } catch (caught) {
      error = caught;
    }
    expect(sqlState(error)).toBe('23514');
    await expect(
      startUserPhoneCheck(db, { userId: user, phone: '+4420123', codeHash: hash(), expiresAt: T0 }),
    ).rejects.toThrow();
  });
});

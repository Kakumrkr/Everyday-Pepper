import {
  ActionProposalIdSchema,
  OutboxMessageIdSchema,
  OutboxSmsSchema,
  TenantIdSchema,
  type ActionProposal,
  type TenantId,
} from '@pepper/contracts';
import {
  addMembership,
  createTenant,
  findOutboxMessage,
  insertProposal,
  listDueOutboxMessages,
  newId,
  updateMembershipRole,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from './actor.js';
import { ManualClock } from './clock.js';
import { openOutboxContent, outboxKeyFrom } from './outbox.js';
import { claimApprovalText, queueApprovalTexts } from './services/approval-texts.js';
import {
  setMemberCardTexts,
  smsCodeKeyFrom,
  startMemberPhoneCheck,
  verifyMemberPhone,
} from './services/member-texts.js';
import { handleInboundSms } from './services/sms.js';
import { insertUser, setTwoFactor, startTestDatabase, type TestDatabase } from './test-support.js';

// Cards by text (S63, ADR-0066 §3–4, AC-X-82…85) at the service level against real Postgres:
// who gets one and when it expires, and what a "Y" and a code may claim: that number's text
// only, once, in time, while the member may still approve by text.

let database: TestDatabase;
let db: Database;
let phones = 0;

const outboxKey = outboxKeyFrom('an-integration-test-outbox-secret-32+');
const codeKey = smsCodeKeyFrom(outboxKey);
const HOUR = 3_600_000;

function newPhone(): string {
  phones += 1;
  return `+1555500${String(phones).padStart(4, '0')}`;
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

/** A business in Chicago with the clock at `at`, and an owner texting cards to `phone`. */
async function business(at: string) {
  const clock = new ManualClock(at);
  const tenantId = TenantIdSchema.parse(
    (
      await createTenant(db, {
        name: 'Plum Salon',
        slug: `plum-${newId().slice(-8)}`,
        timeZone: 'America/Chicago',
      })
    ).id,
  );
  const join = async (role: 'owner' | 'manager' | 'staff', on = true) => {
    const userId = await insertUser(db, 'Ana Reyes');
    await withTenant(db, tenantId, (tx) => addMembership(tx, { userId, role }));
    await setTwoFactor(db, userId, true);
    const actor: Actor = { context: { tenantId, userId, role } };
    const phone = newPhone();
    const coded = { codeKey, outboxKey, clock, drawCode: () => '135790' };
    await startMemberPhoneCheck(db, actor, phone, coded);
    await verifyMemberPhone(db, actor, '135790', coded);
    if (on && role !== 'staff') await setMemberCardTexts(db, actor, true, { clock });
    return { actor, phone };
  };
  return { clock, tenantId, join };
}

async function proposal(tenantId: TenantId, expiresAt: Date): Promise<ActionProposal> {
  const row = await withTenant(db, tenantId, (tx) =>
    insertProposal(tx, {
      action: 'message.waitlist_offer',
      tool: 'send_waitlist_offers',
      targetKey: `waitlist_match:${newId()}`,
      idempotencyKey: `test:${newId()}`,
      payload: { matchId: newId() },
      preview: { offers: 2 },
      fingerprint: 'c'.repeat(64),
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
      expiresAt,
    }),
  );
  if (row === undefined) throw new Error('no proposal');
  return {
    id: ActionProposalIdSchema.parse(row.id),
    fingerprint: row.fingerprint,
    expiresAt: row.expiresAt.toISOString(),
    status: 'pending',
  } as ActionProposal;
}

const SUMMARY = 'Tue 2pm opened with Jess. Offer it to Audy, Marco and Sam?';

async function queue(
  b: Awaited<ReturnType<typeof business>>,
  card: ActionProposal,
  codes: readonly string[] = ['4821', '4822', '4823'],
) {
  let next = 0;
  return withTenant(db, b.tenantId, (tx) =>
    queueApprovalTexts(tx, card, SUMMARY, {
      codeKey,
      outboxKey,
      now: b.clock.now(),
      drawCode: () => codes[next++ % codes.length] ?? '0000',
    }),
  );
}

/** The cards the business has queued: to whom, the words, and when they may go. */
async function cards(tenantId: TenantId) {
  const due = await listDueOutboxMessages(db, new Date('2100-01-01T00:00:00Z'), 1000);
  const found = [];
  for (const message of due.filter((m) => m.tenantId === tenantId)) {
    const row = await withTenant(db, tenantId, (tx) =>
      findOutboxMessage(tx, OutboxMessageIdSchema.parse(message.messageId)),
    );
    if (row?.type !== 'sms' || row.payload === null) continue;
    const sms = OutboxSmsSchema.parse(
      JSON.parse(openOutboxContent(outboxKey, message.messageId, row.payload).toString('utf8')),
    );
    if (sms.body.includes('Reply Y'))
      found.push({ to: sms.to, body: sms.body, at: row.availableAt });
  }
  return found;
}

const claim = (from: string, code: string, at: Date) =>
  claimApprovalText(db, { from, code, receivedAt: at }, { codeKey });

describe('queueApprovalTexts (AC-X-82)', () => {
  it('texts each owner and manager who asked, with a code of their own, never staff', async () => {
    // 11:00 in Chicago.
    const b = await business('2026-11-13T17:00:00Z');
    const owner = await b.join('owner');
    const manager = await b.join('manager');
    await b.join('manager', false);
    await b.join('staff');
    const card = await proposal(b.tenantId, new Date(b.clock.now().getTime() + 24 * HOUR));
    expect(await queue(b, card)).toBe(2);
    const sent = await cards(b.tenantId);
    expect(sent.map((text) => text.to).sort()).toEqual([owner.phone, manager.phone].sort());
    expect(sent.map((text) => text.body).sort()).toEqual([
      `Pepper: ${SUMMARY} Reply Y 4821 by 1:00pm.`,
      `Pepper: ${SUMMARY} Reply Y 4822 by 1:00pm.`,
    ]);
    // A retry of the same card queues nothing twice.
    expect(await queue(b, card)).toBe(0);
  });

  it('holds a card for the quiet hours, and skips one that would expire first', async () => {
    // 21:30 in Chicago: the text can go at 8:00 tomorrow.
    const b = await business('2026-11-14T03:30:00Z');
    const owner = await b.join('owner');
    const card = await proposal(b.tenantId, new Date('2026-11-14T20:00:00Z'));
    expect(await queue(b, card)).toBe(1);
    expect(await cards(b.tenantId)).toEqual([
      {
        to: owner.phone,
        body: `Pepper: ${SUMMARY} Reply Y 4821 by 10:00am.`,
        at: new Date('2026-11-14T14:00:00Z'),
      },
    ]);
    // Expires at 8:10 tomorrow: no text.
    expect(await queue(b, await proposal(b.tenantId, new Date('2026-11-14T14:10:00Z')))).toBe(0);
    // Not pending: no text.
    expect(await queue(b, { ...card, status: 'approved' })).toBe(0);
  });

  it('draws a code no live text to that number has, across cards', async () => {
    const b = await business('2026-11-13T17:00:00Z');
    const owner = await b.join('owner');
    await queue(b, await proposal(b.tenantId, new Date(b.clock.now().getTime() + 24 * HOUR)), [
      '7777',
    ]);
    await queue(b, await proposal(b.tenantId, new Date(b.clock.now().getTime() + 24 * HOUR)), [
      '7777',
      '8888',
    ]);
    expect(
      (await cards(b.tenantId)).map((text) => /Y (\d{4})/.exec(text.body)?.[1]).sort(),
    ).toEqual(['7777', '8888']);
    expect(owner.phone).toMatch(/^\+1/);
  });

  it('skips a number that replied STOP', async () => {
    const b = await business('2026-11-13T17:00:00Z');
    const owner = await b.join('owner');
    await handleInboundSms(
      db,
      {
        provider: 'twilio',
        eventId: `SM${'d'.repeat(28)}${String(phones).padStart(4, '0')}`,
        from: owner.phone,
        body: 'STOP',
        receivedAt: b.clock.now(),
      },
      { helpUrl: 'https://app.example.test/help' },
    );
    expect(
      await queue(b, await proposal(b.tenantId, new Date(b.clock.now().getTime() + 24 * HOUR))),
    ).toBe(0);
  });
});

describe('claimApprovalText (AC-X-83…85)', () => {
  it('claims once, then answers used; an expired one answers expired', async () => {
    const b = await business('2026-11-13T17:00:00Z');
    const owner = await b.join('owner');
    const card = await proposal(b.tenantId, new Date(b.clock.now().getTime() + 24 * HOUR));
    await queue(b, card, ['1357']);
    const at = new Date(b.clock.now().getTime() + 60_000);
    expect(await claim(owner.phone, '1357', at)).toEqual({
      kind: 'claimed',
      tenantId: b.tenantId,
      context: owner.actor.context,
      proposalId: card.id,
      fingerprint: card.fingerprint,
    });
    // Replay: the same reply again.
    expect(await claim(owner.phone, '1357', at)).toEqual({ kind: 'used' });

    const later = await proposal(b.tenantId, new Date(b.clock.now().getTime() + 24 * HOUR));
    await queue(b, later, ['2468']);
    expect(
      await claim(owner.phone, '2468', new Date(b.clock.now().getTime() + 2 * HOUR + 1)),
    ).toEqual({
      kind: 'expired',
    });
  });

  it('is a miss from another number, with a wrong code, or for a member who may no longer', async () => {
    const b = await business('2026-11-13T17:00:00Z');
    const owner = await b.join('owner');
    const manager = await b.join('manager');
    await queue(b, await proposal(b.tenantId, new Date(b.clock.now().getTime() + 24 * HOUR)), [
      '1111',
      '2222',
    ]);
    const at = new Date(b.clock.now().getTime() + 60_000);
    // Spoof: the owner's code from the manager's number, a code never sent, not a number.
    expect(await claim(manager.phone, '1111', at)).toEqual({ kind: 'miss' });
    expect(await claim(owner.phone, '9999', at)).toEqual({ kind: 'miss' });
    expect(await claim('+44 20 7946 0958', '1111', at)).toEqual({ kind: 'miss' });
    expect(await claim(owner.phone, '11111', at)).toEqual({ kind: 'miss' });

    // The manager is made staff: their code no longer counts (and isn't spent).
    await withTenant(db, b.tenantId, (tx) =>
      updateMembershipRole(tx, manager.actor.context.userId, 'staff'),
    );
    expect(await claim(manager.phone, '2222', at)).toEqual({ kind: 'miss' });
    await withTenant(db, b.tenantId, (tx) =>
      updateMembershipRole(tx, manager.actor.context.userId, 'manager'),
    );
    expect(await claim(manager.phone, '2222', at)).toMatchObject({ kind: 'claimed' });

    // The owner turns cards off, or loses the second factor: a miss.
    await setMemberCardTexts(db, owner.actor, false, { clock: b.clock });
    expect(await claim(owner.phone, '1111', at)).toEqual({ kind: 'miss' });
    await setMemberCardTexts(db, owner.actor, true, { clock: b.clock });
    await setTwoFactor(db, owner.actor.context.userId, false);
    expect(await claim(owner.phone, '1111', at)).toEqual({ kind: 'miss' });
    await setTwoFactor(db, owner.actor.context.userId, true);
    expect(await claim(owner.phone, '1111', at)).toMatchObject({ kind: 'claimed' });
  });

  it('is a miss once the member checked another number', async () => {
    const b = await business('2026-11-13T17:00:00Z');
    const owner = await b.join('owner');
    await queue(b, await proposal(b.tenantId, new Date(b.clock.now().getTime() + 24 * HOUR)), [
      '3333',
    ]);
    const coded = { codeKey, outboxKey, clock: b.clock, drawCode: () => '000111' };
    await startMemberPhoneCheck(db, owner.actor, newPhone(), coded);
    await verifyMemberPhone(db, owner.actor, '000111', coded);
    expect(await claim(owner.phone, '3333', new Date(b.clock.now().getTime() + 60_000))).toEqual({
      kind: 'miss',
    });
  });
});

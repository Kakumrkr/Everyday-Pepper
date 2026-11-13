import { ClientIdSchema, TenantIdSchema, type TenantId, type UserId } from '@pepper/contracts';
import {
  addMembership,
  createTenant,
  findActiveMemberSmsConsent,
  findActiveSmsConsent,
  findMembership,
  listActiveSmsConsentsForClient,
  listDueOutboxMessages,
  findUserPhone,
  insertClient,
  listAuditEntries,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from './actor.js';
import { ManualClock } from './clock.js';
import { ForbiddenError, PhoneCheckError, PhoneNotCheckedError } from './errors.js';
import {
  outboxKeyFrom,
  type Mailer,
  type SmsAccepted,
  type SmsMessage,
  type SmsSender,
} from './outbox.js';
import {
  getMemberTexts,
  PHONE_CHECK_MAX_TRIES,
  setMemberCardTexts,
  smsCodeKeyFrom,
  startMemberPhoneCheck,
  verifyMemberPhone,
} from './services/member-texts.js';
import { deliverOutboxMessage } from './services/outbox.js';
import { handleInboundSms, recordSmsConsent, stopClientTexts } from './services/sms.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// A member's own number and "Text me cards" (S63, ADR-0066 §1–2, AC-X-80, AC-X-81) at the
// service level against real Postgres: the code's text goes without a standing consent (a STOP
// still drops it), the code works once in time and in 5 tries, the switch is the member's
// consent beside a client's for the same number, and a new number ends the old one's cards.

let database: TestDatabase;
let db: Database;
let plum: TenantId;
let fade: TenantId;
let phones = 0;

const outboxKey = outboxKeyFrom('an-integration-test-outbox-secret-32+');
const codeKey = smsCodeKeyFrom(outboxKey);
// 11:00 in Chicago: inside the hours.
const clock = new ManualClock('2026-11-13T17:00:00Z');
const mailer: Mailer = { send: () => Promise.reject(new Error('no email in these tests')) };

class FakeSmsSender implements SmsSender {
  readonly sent: SmsMessage[] = [];
  async send(message: SmsMessage): Promise<SmsAccepted> {
    await Promise.resolve();
    this.sent.push(message);
    return {
      provider: 'twilio',
      providerMessageId: `SM${String(this.sent.length).padStart(32, 'a')}${String(phones)}`.slice(
        0,
        34,
      ),
      segments: 1,
      status: 'queued',
    };
  }
}

function newPhone(): string {
  phones += 1;
  return `+1555400${String(phones).padStart(4, '0')}`;
}

const options = (code = '123456') => ({ codeKey, outboxKey, clock, drawCode: () => code });

async function member(
  tenant: TenantId,
  role: 'owner' | 'manager' | 'staff',
  userId?: UserId,
): Promise<Actor> {
  const user = userId ?? (await insertUser(db, 'Ana Owner'));
  await withTenant(db, tenant, (tx) => addMembership(tx, { userId: user, role }));
  return { context: { tenantId: tenant, userId: user, role } };
}

/** Every text of the business that is due, sent through the outbox with a fake sender. */
async function deliverDue(tenant: TenantId, sender: FakeSmsSender) {
  const results = [];
  for (const due of await listDueOutboxMessages(db, clock.now(), 100)) {
    if (due.tenantId !== tenant) continue;
    results.push(
      await deliverOutboxMessage(db, due, {
        key: outboxKey,
        mailer,
        sms: sender,
        smsStatusBaseUrl: 'https://app.example.test',
        clock,
      }),
    );
  }
  return results;
}

async function checked(actor: Actor, phone = newPhone()): Promise<string> {
  await startMemberPhoneCheck(db, actor, phone, options());
  await verifyMemberPhone(db, actor, '123456', options());
  return phone;
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  plum = TenantIdSchema.parse(
    (
      await createTenant(db, {
        name: 'Plum Salon',
        slug: 'plum-member-texts',
        timeZone: 'America/Chicago',
      })
    ).id,
  );
  fade = TenantIdSchema.parse(
    (
      await createTenant(db, {
        name: 'Fade Bros',
        slug: 'fade-member-texts',
        timeZone: 'America/New_York',
      })
    ).id,
  );
});

afterAll(async () => {
  await database.stop();
});

describe('checking a member’s number (AC-X-80)', () => {
  it('texts a code the member asked for, without a standing consent, and verifies it once', async () => {
    const owner = await member(plum, 'owner');
    const phone = newPhone();
    const { expiresAt } = await startMemberPhoneCheck(
      db,
      owner,
      ` (${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)} `,
      options('654321'),
    );
    expect(expiresAt).toEqual(new Date(clock.now().getTime() + 10 * 60_000));
    const sender = new FakeSmsSender();
    expect(await deliverDue(plum, sender)).toContain('sent');
    expect(sender.sent).toEqual([
      expect.objectContaining({
        to: phone,
        body: "Pepper: your code is 654321. It works for 10 minutes. Didn't ask for it? Ignore this text.",
      }),
    ]);
    // The code is never stored, only its HMAC; nothing is the account's yet.
    const row = await findUserPhone(db, owner.context.userId);
    expect(row).toMatchObject({ phone: null, checkPhone: phone });
    expect(row?.checkHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.checkHash).not.toContain('654321');

    expect(await verifyMemberPhone(db, owner, '654321', options())).toEqual({
      phone,
      cardTexts: false,
      canTextCards: true,
    });
    // Once: the check is over.
    await expect(verifyMemberPhone(db, owner, '654321', options())).rejects.toEqual(
      new PhoneCheckError('no_check'),
    );
  });

  it('refuses a number Pepper can’t text, and one that replied STOP', async () => {
    const owner = await member(plum, 'owner');
    await expect(startMemberPhoneCheck(db, owner, '+44 20 7946 0958', options())).rejects.toEqual(
      new PhoneCheckError('not_textable'),
    );
    const stopped = newPhone();
    await handleInboundSms(
      db,
      {
        provider: 'twilio',
        eventId: `SM${'b'.repeat(28)}${String(phones).padStart(4, '0')}`,
        from: stopped,
        body: 'STOP',
        receivedAt: clock.now(),
      },
      { helpUrl: 'https://app.example.test/help' },
    );
    await expect(startMemberPhoneCheck(db, owner, stopped, options())).rejects.toEqual(
      new PhoneCheckError('opted_out'),
    );
  });

  it('counts wrong codes, stops after 5 tries, and lets a code expire', async () => {
    const owner = await member(plum, 'manager');
    await startMemberPhoneCheck(db, owner, newPhone(), options());
    for (let i = 0; i < PHONE_CHECK_MAX_TRIES; i += 1) {
      await expect(verifyMemberPhone(db, owner, '000000', options())).rejects.toEqual(
        new PhoneCheckError('wrong_code'),
      );
    }
    // The right code no longer works: a new one is needed.
    await expect(verifyMemberPhone(db, owner, '123456', options())).rejects.toEqual(
      new PhoneCheckError('too_many_tries'),
    );
    await startMemberPhoneCheck(db, owner, newPhone(), options());
    clock.advanceBy(10 * 60_000);
    await expect(verifyMemberPhone(db, owner, '123456', options())).rejects.toEqual(
      new PhoneCheckError('no_check'),
    );
    clock.advanceBy(-10 * 60_000);
    // A malformed code is a wrong one.
    await startMemberPhoneCheck(db, owner, newPhone(), options());
    await expect(verifyMemberPhone(db, owner, '12345', options())).rejects.toEqual(
      new PhoneCheckError('wrong_code'),
    );
  });

  it('is people only', async () => {
    const owner = await member(plum, 'owner');
    await expect(
      startMemberPhoneCheck(db, { ...owner, via: 'ai' }, newPhone(), options()),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('"Text me cards" (AC-X-81)', () => {
  it('records the member’s consent beside a client’s for the same number, and off revokes only it', async () => {
    const owner = await member(plum, 'owner');
    const phone = await checked(owner);
    // The owner also booked as a client, and ticked the box.
    const client = await withTenant(db, plum, async (tx) => {
      const row = await insertClient(tx, {
        name: 'Ana Ruiz',
        email: null,
        phone,
        source: 'booking_page',
      });
      await recordSmsConsent(
        tx,
        {
          phone,
          source: 'booking_page',
          clientId: row.id,
          wordingVersion: 'sms-consent-v1',
          givenAt: clock.now(),
        },
        { actor: { kind: 'system' } },
      );
      return row;
    });
    expect(await setMemberCardTexts(db, owner, true, { clock })).toEqual({
      phone,
      cardTexts: true,
      canTextCards: true,
    });
    // Again: no second consent.
    await setMemberCardTexts(db, owner, true, { clock });
    const [mine, theirs] = await withTenant(db, plum, async (tx) => [
      await findActiveMemberSmsConsent(tx, phone, owner.context.userId),
      await listActiveSmsConsentsForClient(tx, client.id),
    ]);
    expect(mine).toMatchObject({
      source: 'member_settings',
      wordingVersion: 'sms-consent-v2',
      shownText:
        'Text me cards that need my OK from Plum Salon at this number. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.',
    });
    expect(theirs).toHaveLength(1);
    // Stopping the client's texts leaves the owner's cards; off leaves the client's texts.
    await stopClientTexts(db, owner, ClientIdSchema.parse(client.id), { clock });
    expect((await getMemberTexts(db, owner)).cardTexts).toBe(true);
    expect(await setMemberCardTexts(db, owner, false, { clock })).toMatchObject({
      cardTexts: false,
    });
    expect(await withTenant(db, plum, (tx) => findActiveSmsConsent(tx, phone))).toBeUndefined();
    const audit = await withTenant(db, plum, (tx) => listAuditEntries(tx, { limit: 20 }));
    expect(audit.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['sms.consent_given', 'sms.consent_revoked']),
    );
  });

  it('needs a checked number, and an owner or manager', async () => {
    const owner = await member(plum, 'owner');
    await expect(setMemberCardTexts(db, owner, true, { clock })).rejects.toBeInstanceOf(
      PhoneNotCheckedError,
    );
    const staff = await member(plum, 'staff');
    await checked(staff);
    await expect(setMemberCardTexts(db, staff, true, { clock })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await getMemberTexts(db, staff)).toMatchObject({
      cardTexts: false,
      canTextCards: false,
    });
  });

  it('ends the old number’s cards in every business when the member checks a new one', async () => {
    const owner = await member(plum, 'owner');
    const atFade = await member(fade, 'manager', owner.context.userId);
    const old = await checked(owner);
    await setMemberCardTexts(db, owner, true, { clock });
    await setMemberCardTexts(db, atFade, true, { clock });
    const next = await checked(owner);
    expect(await getMemberTexts(db, owner)).toEqual({
      phone: next,
      cardTexts: false,
      canTextCards: true,
    });
    expect(await getMemberTexts(db, atFade)).toMatchObject({ phone: next, cardTexts: false });
    for (const tenant of [plum, fade]) {
      expect(await withTenant(db, tenant, (tx) => findActiveSmsConsent(tx, old))).toBeUndefined();
      expect(
        (await withTenant(db, tenant, (tx) => findMembership(tx, owner.context.userId)))?.cardTexts,
      ).toBe(false);
    }
  });
});

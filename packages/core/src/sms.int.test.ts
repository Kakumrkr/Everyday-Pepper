import {
  OutboxDedupeKeySchema,
  TenantIdSchema,
  UsagePeriodSchema,
  type OutboxMessageId,
  type TenantId,
} from '@pepper/contracts';
import {
  addMembership,
  createTenant,
  findActiveSmsConsent,
  findOutboxMessage,
  findSmsDelivery,
  insertClient,
  isSmsOptedOut,
  listAuditEntries,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from './actor.js';
import { ManualClock } from './clock.js';
import { ClientNotFoundError, ForbiddenError } from './errors.js';
import { createBusiness } from './services/business.js';
import {
  outboxKeyFrom,
  SmsRejectedError,
  type Mailer,
  type SmsAccepted,
  type SmsMessage,
  type SmsSender,
} from './outbox.js';
import { deliverOutboxMessage } from './services/outbox.js';
import {
  getClientTexts,
  handleInboundSms,
  queueSms,
  recordSmsConsent,
  recordSmsStatus,
  revokeSmsConsentFor,
  smsPermission,
  stopClientTexts,
} from './services/sms.js';
import { usageFor } from './services/usage.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The SMS channel end to end at the service level (S61, ADR-0065, AC-X-57…63): a queued text is
// sent once, only with the business's consent and without a STOP, inside the quiet hours; a
// STOP handled by `handleInboundSms` drops the very next delivery. The provider's HTTP is proven
// in runtime's Twilio contract tests, the webhook in the api.

let database: TestDatabase;
let db: Database;
let plum: TenantId;
let fade: TenantId;
let keys = 0;
let phones = 0;
let providerIds = 0;

const key = outboxKeyFrom('an-integration-test-outbox-secret-32+');
// 11:00 in Chicago (Plum) and in New York 12:00 (Fade): both inside the hours.
const clock = new ManualClock('2026-11-12T17:00:00Z');
const HELP_URL = 'https://app.example.test/help';
const mailer: Mailer = { send: () => Promise.reject(new Error('no email in these tests')) };

/** Records what it sends; throws the queued failures first. */
class FakeSmsSender implements SmsSender {
  readonly sent: SmsMessage[] = [];
  failures: Error[] = [];

  async send(message: SmsMessage): Promise<SmsAccepted> {
    await Promise.resolve();
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    this.sent.push(message);
    return {
      provider: 'twilio',
      // Unique across the file, as Twilio's are.
      providerMessageId: `SM${String((providerIds += 1)).padStart(32, '0')}`,
      segments: message.body.length > 160 ? 2 : 1,
      status: 'queued',
    };
  }
}

let sender: FakeSmsSender;

function newPhone(): string {
  phones += 1;
  return `+1555300${String(phones).padStart(4, '0')}`;
}

async function consentFor(tenant: TenantId, phone: string): Promise<void> {
  await withTenant(db, tenant, async (tx) => {
    const client = await insertClient(tx, {
      name: 'Sam',
      email: null,
      phone,
      source: 'booking_page',
    });
    await recordSmsConsent(
      tx,
      {
        phone,
        source: 'booking_page',
        clientId: client.id,
        wordingVersion: 'sms-consent-v1',
        givenAt: clock.now(),
      },
      { actor: { kind: 'system' } },
    );
  });
}

async function queue(
  tenant: TenantId,
  to: string,
  body = 'Plum Salon: see you tomorrow at 2:30pm. Reply STOP to opt out.',
  extra: { urgent?: true } = {},
): Promise<OutboxMessageId> {
  keys += 1;
  const id = await withTenant(db, tenant, (tx) =>
    queueSms(
      tx,
      { to, body, wordsBy: 'template', ...extra },
      {
        key,
        dedupeKey: OutboxDedupeKeySchema.parse(`test.sms:${String(keys)}`),
        now: clock.now(),
      },
    ),
  );
  if (id === undefined) throw new Error('not queued');
  return id;
}

const deliver = (tenant: TenantId, messageId: OutboxMessageId, sms: SmsSender | null = sender) =>
  deliverOutboxMessage(
    db,
    { messageId, tenantId: tenant },
    { key, mailer, sms, smsStatusBaseUrl: 'https://app.example.test', clock },
  );

const stored = (tenant: TenantId, id: OutboxMessageId) =>
  withTenant(db, tenant, (tx) => findOutboxMessage(tx, id));

let eventIds = 0;
const inbound = (from: string, body: string, eventId?: string) => {
  eventIds += 1;
  return handleInboundSms(
    db,
    {
      provider: 'twilio',
      eventId: eventId ?? `SM${String(eventIds).padStart(32, 'f')}`,
      from,
      body,
      receivedAt: clock.now(),
    },
    { helpUrl: HELP_URL },
  );
};

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  plum = TenantIdSchema.parse(
    (await createTenant(db, { name: 'Plum Salon', slug: 'plum-sms', timeZone: 'America/Chicago' }))
      .id,
  );
  fade = TenantIdSchema.parse(
    (await createTenant(db, { name: 'Fade Bros', slug: 'fade-sms', timeZone: 'America/New_York' }))
      .id,
  );
});

beforeEach(() => {
  sender = new FakeSmsSender();
  clock.set('2026-11-12T17:00:00Z');
});

afterAll(async () => {
  await database.stop();
});

describe('sending (AC-X-57)', () => {
  it('sends a queued text once, sealed until then, and records its delivery and segments', async () => {
    const phone = newPhone();
    await consentFor(plum, phone);
    const id = await queue(plum, phone);
    expect((await stored(plum, id))?.payload?.includes(Buffer.from(phone))).toBe(false);

    expect(await deliver(plum, id)).toBe('sent');
    expect(await deliver(plum, id)).toBe('skipped');
    expect(sender.sent).toEqual([
      {
        to: phone,
        body: 'Plum Salon: see you tomorrow at 2:30pm. Reply STOP to opt out.',
        id,
        statusCallbackUrl: `https://app.example.test/v1/webhooks/sms/status?t=${plum}&m=${id}`,
      },
    ]);
    expect(await stored(plum, id)).toMatchObject({ status: 'sent', payload: null });
    expect(await withTenant(db, plum, (tx) => findSmsDelivery(tx, id))).toMatchObject({
      provider: 'twilio',
      status: 'queued',
      segments: 1,
    });
    const usage = await usageFor(db, plum, UsagePeriodSchema.parse('2026-11'));
    expect(usage.sms_segments).toBeGreaterThanOrEqual(1);
    expect(usage.emails_sent).toBe(0);
  });

  it('normalises the words to GSM-7 when queued (AC-X-63)', async () => {
    const phone = newPhone();
    await consentFor(plum, phone);
    const id = await queue(plum, phone, 'You’re booked — see you soon…');
    await deliver(plum, id);
    expect(sender.sent[0]?.body).toBe("You're booked - see you soon...");
  });

  it('retries a passing failure and gives up at once on a recipient refused for good', async () => {
    const phone = newPhone();
    await consentFor(plum, phone);
    const passing = await queue(plum, phone);
    sender.failures.push(new SmsRejectedError(503, null, false));
    expect(await deliver(plum, passing)).toBe('retry');
    expect(await stored(plum, passing)).toMatchObject({ status: 'pending', attempts: 1 });

    const refused = await queue(plum, phone);
    sender.failures.push(new SmsRejectedError(400, 21211, true));
    expect(await deliver(plum, refused)).toBe('dead');
    expect(await stored(plum, refused)).toMatchObject({
      status: 'dead',
      lastError: 'SmsRejected-21211',
    });
  });

  it('fails as an unconfigured channel with SMS off, so it waits and retries', async () => {
    const phone = newPhone();
    await consentFor(plum, phone);
    const id = await queue(plum, phone);
    expect(await deliver(plum, id, null)).toBe('retry');
    expect(await stored(plum, id)).toMatchObject({ lastError: 'ChannelUnavailableError' });
  });

  it('records Twilio’s “unsubscribed recipient” as an opt-out and drops the text', async () => {
    const phone = newPhone();
    await consentFor(plum, phone);
    const id = await queue(plum, phone);
    sender.failures.push(new SmsRejectedError(400, 21610, true));
    expect(await deliver(plum, id)).toBe('dropped');
    expect(await stored(plum, id)).toMatchObject({ status: 'dead', lastError: 'SmsOptedOut' });
    expect(await isSmsOptedOut(db, phone)).toBe(true);
  });
});

describe('consent (AC-X-58)', () => {
  it('drops a text to a number without the business’s consent, never sending or retrying it', async () => {
    const phone = newPhone();
    const id = await queue(plum, phone);
    expect(await deliver(plum, id)).toBe('dropped');
    expect(sender.sent).toEqual([]);
    expect(await stored(plum, id)).toMatchObject({ status: 'dead', lastError: 'SmsNoConsent' });
  });

  it('is per business: one business’s consent doesn’t let another text the number', async () => {
    const phone = newPhone();
    await consentFor(plum, phone);
    expect(await withTenant(db, plum, (tx) => smsPermission(tx, phone))).toBe('allowed');
    expect(await withTenant(db, fade, (tx) => smsPermission(tx, phone))).toBe('no_consent');
    expect(await deliver(fade, await queue(fade, phone))).toBe('dropped');
  });

  it('stops texts from the next delivery once revoked, and audits both without the number', async () => {
    const phone = newPhone();
    await consentFor(plum, phone);
    const id = await queue(plum, phone);
    const revoked = await withTenant(db, plum, (tx) =>
      revokeSmsConsentFor(tx, phone, { actor: { kind: 'system' }, now: clock.now() }),
    );
    expect(revoked).toBe(true);
    expect(await deliver(plum, id)).toBe('dropped');
    const entries = await withTenant(db, plum, (tx) => listAuditEntries(tx, { limit: 5 }));
    expect(entries.map((entry) => entry.action).slice(0, 2)).toEqual([
      'sms.consent_revoked',
      'sms.consent_given',
    ]);
    expect(JSON.stringify(entries)).not.toContain(phone);
  });

  it('keeps the words as shown, with the business’s name then (ADR-0065 §7)', async () => {
    const phone = newPhone();
    await consentFor(fade, phone);
    const consent = await withTenant(db, fade, (tx) => findActiveSmsConsent(tx, phone));
    expect(consent?.shownText).toBe(
      'Text me appointment confirmations and reminders from Fade Bros at this number. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Not required to book.',
    );
  });

  it('says a number Pepper can’t text is not textable', async () => {
    expect(await withTenant(db, plum, (tx) => smsPermission(tx, '+442071234567'))).toBe(
      'not_textable',
    );
  });
});

describe('STOP, START and HELP (AC-X-59)', () => {
  it('drops the very next delivery after a STOP, for every business, and replies once', async () => {
    const phone = newPhone();
    await consentFor(plum, phone);
    await consentFor(fade, phone);
    const forPlum = await queue(plum, phone);
    const forFade = await queue(fade, phone);

    const stop = await inbound(phone, 'Stop texting me!', `SM${'1'.repeat(32)}`);
    expect(stop.keyword).toBe('stop');
    expect(stop.reply).toContain('Reply START to resubscribe');
    // It names both businesses, the latest consent first (S61.2, AC-X-68).
    expect(stop.reply).toMatch(/^Fade Bros and Plum Salon via Pepper: .*from any business\./);
    // No time passes: the STOP is honoured by the time the webhook answered.
    expect(await deliver(plum, forPlum)).toBe('dropped');
    expect(await deliver(fade, forFade)).toBe('dropped');
    expect(sender.sent).toEqual([]);
    expect(await stored(plum, forPlum)).toMatchObject({ lastError: 'SmsOptedOut' });

    // A replay changes nothing and gets no second reply.
    expect((await inbound(phone, 'STOP', `SM${'1'.repeat(32)}`)).reply).toBeNull();
  });

  it('resubscribes on START, answers HELP, and ignores other texts', async () => {
    const phone = newPhone();
    await consentFor(plum, phone);
    await inbound(phone, 'STOP');
    const start = await inbound(phone, 'start');
    expect(start).toMatchObject({ keyword: 'start' });
    expect(start.reply).toContain('resubscribed');
    expect(await deliver(plum, await queue(plum, phone))).toBe('sent');

    const help = await inbound(phone, 'HELP');
    expect(help.reply).toContain(HELP_URL);
    expect(help.reply).toMatch(/^Plum Salon via Pepper: appointment texts\./);
    expect(await isSmsOptedOut(db, phone)).toBe(false);
    expect(await inbound(phone, 'Can I come at 3 instead?')).toEqual({
      keyword: null,
      reply: null,
    });
    // A keyword from a number Pepper never texts is neither stored nor answered.
    expect(await inbound('+442071234567', 'STOP')).toEqual({ keyword: 'stop', reply: null });
  });
});

describe('a client’s texts on their profile (S61.2, AC-X-66, AC-X-67)', () => {
  let businesses = 0;

  async function team() {
    businesses += 1;
    const owner = await insertUser(db, 'Ana');
    const tenant = await createBusiness(db, owner, {
      name: 'Juniper Hair',
      slug: `juniper-sms-${String(businesses)}`,
      timeZone: 'America/New_York',
    });
    const tenantId = TenantIdSchema.parse(tenant.id);
    const staff = await insertUser(db, 'Jess');
    await withTenant(db, tenantId, (tx) => addMembership(tx, { userId: staff, role: 'staff' }));
    const as = (userId: string, role: 'owner' | 'staff'): Actor => ({
      context: { tenantId, userId: userId as never, role },
      requestId: 'req-texts',
    });
    return { tenantId, owner: as(owner, 'owner'), staff: as(staff, 'staff') };
  }

  async function clientWith(tenantId: TenantId, phone: string | null, consent: boolean) {
    return withTenant(db, tenantId, async (tx) => {
      const client = await insertClient(tx, { name: 'Sam', email: null, phone, source: 'team' });
      if (consent && phone !== null) {
        await recordSmsConsent(
          tx,
          {
            phone,
            source: 'booking_page',
            clientId: client.id,
            wordingVersion: 'sms-consent-v1',
            givenAt: clock.now(),
          },
          { actor: { kind: 'system' } },
        );
      }
      return client.id as never;
    });
  }

  it('says texts are on, since when and how, with the words exactly as shown', async () => {
    const t = await team();
    const phone = newPhone();
    const sam = await clientWith(t.tenantId, phone, true);
    const texts = await getClientTexts(db, t.owner, sam);
    expect(texts).toEqual({
      status: 'on',
      textable: true,
      consent: {
        phone,
        source: 'booking_page',
        wordingVersion: 'sms-consent-v1',
        words:
          'Text me appointment confirmations and reminders from Juniper Hair at this number. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Not required to book.',
        givenAt: '2026-11-12T17:00:00.000Z',
        stoppedAt: null,
      },
      canStop: true,
    });
  });

  it('says never asked, and whether their number can get texts', async () => {
    const t = await team();
    expect(
      await getClientTexts(db, t.owner, await clientWith(t.tenantId, newPhone(), false)),
    ).toEqual({
      status: 'never',
      textable: true,
      consent: null,
      canStop: false,
    });
    expect(
      await getClientTexts(db, t.owner, await clientWith(t.tenantId, '+447700900123', false)),
    ).toMatchObject({ status: 'never', textable: false });
    expect(
      await getClientTexts(db, t.owner, await clientWith(t.tenantId, null, false)),
    ).toMatchObject({ status: 'never', textable: false });
  });

  it('says opted out after a STOP, and the owner may still stop them for good', async () => {
    const t = await team();
    const phone = newPhone();
    const sam = await clientWith(t.tenantId, phone, true);
    await inbound(phone, 'STOP');
    expect(await getClientTexts(db, t.owner, sam)).toMatchObject({
      status: 'opted_out',
      canStop: true,
    });
  });

  it('stops texts as the member, audited, from the next delivery; asking again changes nothing', async () => {
    const t = await team();
    const phone = newPhone();
    const sam = await clientWith(t.tenantId, phone, true);
    const message = await queue(t.tenantId, phone);
    clock.set('2026-11-12T18:00:00Z');
    const stopped = await stopClientTexts(db, t.owner, sam, { clock });
    expect(stopped).toMatchObject({
      status: 'stopped',
      canStop: false,
      consent: { stoppedAt: '2026-11-12T18:00:00.000Z' },
    });
    expect(await deliver(t.tenantId, message)).toBe('dropped');
    const audit = await withTenant(db, t.tenantId, (tx) => listAuditEntries(tx, { limit: 5 }));
    expect(audit[0]).toMatchObject({
      action: 'sms.consent_revoked',
      actor: { kind: 'user', userId: t.owner.context.userId },
    });
    expect(await stopClientTexts(db, t.owner, sam, { clock })).toEqual(stopped);
    expect(
      (await withTenant(db, t.tenantId, (tx) => listAuditEntries(tx, { limit: 5 }))).filter(
        (entry) => entry.action === 'sms.consent_revoked',
      ),
    ).toHaveLength(1);
  });

  it('counts a yes on any of the client’s numbers, and stops them all', async () => {
    const t = await team();
    const first = newPhone();
    const second = newPhone();
    const sam = await clientWith(t.tenantId, first, true);
    clock.set('2026-11-12T17:30:00Z');
    await withTenant(db, t.tenantId, (tx) =>
      recordSmsConsent(
        tx,
        {
          phone: second,
          source: 'booking_page',
          clientId: sam,
          wordingVersion: 'sms-consent-v1',
          givenAt: clock.now(),
        },
        { actor: { kind: 'system' } },
      ),
    );
    // A member stopped the newer number by hand earlier: the older yes still counts.
    await withTenant(db, t.tenantId, (tx) =>
      revokeSmsConsentFor(tx, second, { actor: { kind: 'system' }, now: clock.now() }),
    );
    expect(await getClientTexts(db, t.owner, sam)).toMatchObject({
      status: 'on',
      consent: { phone: first },
    });
    await withTenant(db, t.tenantId, (tx) =>
      recordSmsConsent(
        tx,
        {
          phone: second,
          source: 'booking_page',
          clientId: sam,
          wordingVersion: 'sms-consent-v1',
          givenAt: clock.now(),
        },
        { actor: { kind: 'system' } },
      ),
    );
    // One number replied STOP: still on through the other, which is shown; both: opted out.
    await inbound(second, 'STOP');
    expect(await getClientTexts(db, t.owner, sam)).toMatchObject({
      status: 'on',
      consent: { phone: first },
    });
    await inbound(first, 'STOP');
    expect(await getClientTexts(db, t.owner, sam)).toMatchObject({
      status: 'opted_out',
      consent: { phone: second },
    });
    expect(await stopClientTexts(db, t.owner, sam, { clock })).toMatchObject({
      status: 'stopped',
    });
    for (const phone of [first, second]) {
      expect(
        await withTenant(db, t.tenantId, (tx) => findActiveSmsConsent(tx, phone)),
      ).toBeUndefined();
    }
  });

  it('shows staff only their own clients, and never lets them stop texts', async () => {
    const t = await team();
    const sam = await clientWith(t.tenantId, newPhone(), true);
    await expect(getClientTexts(db, t.staff, sam)).rejects.toBeInstanceOf(ClientNotFoundError);
    await expect(stopClientTexts(db, t.staff, sam)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('is the business’s own: another business can’t read or stop the client', async () => {
    const t = await team();
    const other = await team();
    const sam = await clientWith(t.tenantId, newPhone(), true);
    await expect(getClientTexts(db, other.owner, sam)).rejects.toBeInstanceOf(ClientNotFoundError);
    await expect(stopClientTexts(db, other.owner, sam)).rejects.toBeInstanceOf(ClientNotFoundError);
    expect(await getClientTexts(db, t.owner, sam)).toMatchObject({ status: 'on' });
  });
});

describe('quiet hours (AC-X-60)', () => {
  it('queues a text at night for 8:00 in the business’s zone', async () => {
    const phone = newPhone();
    await consentFor(plum, phone);
    clock.set('2026-11-13T03:30:00Z'); // 21:30 in Chicago
    const id = await queue(plum, phone);
    expect((await stored(plum, id))?.availableAt.toISOString()).toBe('2026-11-13T14:00:00.000Z');
    expect(await deliver(plum, id)).toBe('skipped'); // not due
    clock.set('2026-11-13T14:00:00Z');
    expect(await deliver(plum, id)).toBe('sent');
  });

  it('holds a retry that crossed 20:00 without using an attempt', async () => {
    const phone = newPhone();
    await consentFor(plum, phone);
    clock.set('2026-11-13T01:59:00Z'); // 19:59 in Chicago
    const id = await queue(plum, phone);
    sender.failures.push(new SmsRejectedError(503, null, false));
    expect(await deliver(plum, id)).toBe('retry');
    clock.set('2026-11-13T02:05:00Z'); // 20:05, the retry is due
    expect(await deliver(plum, id)).toBe('postponed');
    expect(await stored(plum, id)).toMatchObject({ status: 'pending', attempts: 1 });
    expect((await stored(plum, id))?.availableAt.toISOString()).toBe('2026-11-13T14:00:00.000Z');
    expect(sender.sent).toEqual([]);
  });

  it('lets an urgent text through at night, but never without consent', async () => {
    const phone = newPhone();
    clock.set('2026-11-13T12:30:00Z'); // 6:30 in Chicago
    const unconsented = await queue(plum, phone, 'Running 10 min late, sorry!', { urgent: true });
    expect(await deliver(plum, unconsented)).toBe('dropped');
    await consentFor(plum, phone);
    const id = await queue(plum, phone, 'Running 10 min late, sorry!', { urgent: true });
    expect(await deliver(plum, id)).toBe('sent');
  });
});

describe('delivery status (AC-X-62)', () => {
  it('moves forwards only, for the business and message the URL names', async () => {
    const phone = newPhone();
    await consentFor(plum, phone);
    const id = await queue(plum, phone);
    await deliver(plum, id);
    const sid = (await withTenant(db, plum, (tx) => findSmsDelivery(tx, id)))?.providerMessageId;
    const status = (tenantId: TenantId, value: string, errorCode: number | null = null) =>
      recordSmsStatus(db, {
        tenantId,
        messageId: id,
        providerMessageId: sid ?? '',
        status: value,
        errorCode,
      });
    expect(await status(plum, 'delivered')).toBe('moved');
    expect(await status(plum, 'sent')).toBe('kept');
    expect(await status(plum, 'receiving')).toBe('ignored');
    expect(await status(fade, 'failed', 30003)).toBe('missing');
    expect(await withTenant(db, plum, (tx) => findSmsDelivery(tx, id))).toMatchObject({
      status: 'delivered',
    });
  });
});

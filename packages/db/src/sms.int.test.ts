// The SMS channel's records (S61, ADR-0065): consents are the business's (one active a number,
// revoked ones kept, gone with a forgotten client), deliveries move only forwards, and keyword
// events are platform rows written in the SMS context, never deleted, asked only through
// `sms_opted_out`. Part of the isolation evidence with isolation.int.test.ts.
import {
  OutboxMessageIdSchema,
  TenantIdSchema,
  type ClientId,
  type TenantId,
} from '@pepper/contracts';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import { deleteClientRow, insertClient, mergeClientRows } from './repositories/clients.js';
import { insertOutboxMessage } from './repositories/outbox.js';
import {
  advanceSmsDelivery,
  findActiveSmsConsent,
  findSmsDelivery,
  insertSmsConsent,
  insertSmsDelivery,
  insertSmsKeywordEvent,
  isSmsOptedOut,
  listSmsConsentsForClient,
  listSmsConsentsForExport,
  revokeSmsConsent,
  smsConsentBusinesses,
} from './repositories/sms.js';
import { createTenant } from './repositories/tenants.js';
import { scheduleCurrentTenantDeletion } from './repositories/deletion.js';
import { smsConsents, smsKeywordEvents } from './schema.js';
import { addMembership } from './repositories/memberships.js';
import { withMember, withSmsInbound, withTenant } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

/** The words as shown, as core records them (`smsConsentText`). */
const SHOWN = 'Text me appointment confirmations and reminders from A at this number.';
let database: TestDatabase;
let db: Database;
let tenantA: TenantId;
let tenantB: TenantId;
const T0 = new Date('2026-11-12T15:00:00Z');
const PHONE = '+15552340001';

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  tenantA = TenantIdSchema.parse(
    (await createTenant(db, { name: 'A', slug: 'sms-a', timeZone: 'America/New_York' })).id,
  );
  tenantB = TenantIdSchema.parse(
    (await createTenant(db, { name: 'B', slug: 'sms-b', timeZone: 'America/Chicago' })).id,
  );
});

afterAll(async () => {
  await database.stop();
});

async function client(tenant: TenantId, phone = PHONE): Promise<ClientId> {
  const row = await withTenant(db, tenant, (tx) =>
    insertClient(tx, { name: 'Sam', email: null, phone, source: 'booking_page' }),
  );
  return row.id as ClientId;
}

let events = 0;
function keyword(phone: string, word: 'stop' | 'start' | 'help', at: Date) {
  events += 1;
  return {
    provider: 'twilio' as const,
    eventId: `SM${String(events).padStart(32, '0')}`,
    phone,
    keyword: word,
    origin: 'keyword' as const,
    receivedAt: at,
  };
}

describe('SMS consents (AC-X-58)', () => {
  it('keeps one active consent a number, revoking the earlier one as the record', async () => {
    const clientId = await client(tenantA);
    const first = await withTenant(db, tenantA, (tx) =>
      insertSmsConsent(tx, {
        phone: PHONE,
        source: 'booking_page',
        clientId,
        wordingVersion: 'sms-consent-v1',
        shownText: SHOWN,
        givenAt: T0,
      }),
    );
    expect(first.replaced).toBeNull();
    const later = new Date(T0.getTime() + 60_000);
    const second = await withTenant(db, tenantA, (tx) =>
      insertSmsConsent(tx, {
        phone: PHONE,
        source: 'booking_page',
        clientId,
        wordingVersion: 'sms-consent-v1',
        shownText: SHOWN,
        givenAt: later,
      }),
    );
    expect(second.replaced).toBe(first.id);
    const active = await withTenant(db, tenantA, (tx) => findActiveSmsConsent(tx, PHONE));
    expect(active?.id).toBe(second.id);
    const all = await withTenant(db, tenantA, (tx) => listSmsConsentsForExport(tx));
    expect(all.map((row) => [row.id, row.revokedAt?.toISOString() ?? null])).toEqual([
      [first.id, later.toISOString()],
      [second.id, null],
    ]);
  });

  it('is the business’s own: another business sees none and needs its own', async () => {
    expect(await withTenant(db, tenantB, (tx) => findActiveSmsConsent(tx, PHONE))).toBeUndefined();
    expect(await withTenant(db, tenantB, (tx) => listSmsConsentsForExport(tx))).toEqual([]);
  });

  it('revokes the active one, and says when there was none', async () => {
    const now = new Date(T0.getTime() + 120_000);
    expect(
      await withTenant(db, tenantA, (tx) => revokeSmsConsent(tx, PHONE, 'booking_page', now)),
    ).not.toBeNull();
    expect(await withTenant(db, tenantA, (tx) => findActiveSmsConsent(tx, PHONE))).toBeUndefined();
    expect(
      await withTenant(db, tenantA, (tx) => revokeSmsConsent(tx, PHONE, 'booking_page', now)),
    ).toBeNull();
  });

  it('refuses a consent without its subject, or with a number Pepper can’t text', async () => {
    const userId = await insertUser(db);
    const noClient = await withTenant(db, tenantA, (tx) =>
      tx.insert(smsConsents).values({
        phone: '+15552340002',
        source: 'booking_page',
        userId,
        wordingVersion: 'sms-consent-v1',
        shownText: SHOWN,
        givenAt: T0,
      }),
    ).catch((error: unknown) => error);
    expect(sqlState(noClient)).toBe('23514');
    const abroad = await withTenant(db, tenantA, (tx) =>
      tx.insert(smsConsents).values({
        phone: '+442071234567',
        source: 'member_settings',
        userId,
        wordingVersion: 'sms-consent-v1',
        shownText: SHOWN,
        givenAt: T0,
      }),
    ).catch((error: unknown) => error);
    expect(sqlState(abroad)).toBe('23514');
    // A member's own consent is fine.
    await withTenant(db, tenantA, (tx) =>
      insertSmsConsent(tx, {
        phone: '+15552340003',
        source: 'member_settings',
        userId,
        wordingVersion: 'sms-consent-v1',
        shownText: SHOWN,
        givenAt: T0,
      }),
    );
  });

  it('follows a client merged into another (ADR-0051), still active', async () => {
    const phone = '+15552340005';
    const merged = await client(tenantA, phone);
    const kept = await client(tenantA, '+15552340006');
    const { id } = await withTenant(db, tenantA, (tx) =>
      insertSmsConsent(tx, {
        phone,
        source: 'booking_page',
        clientId: merged,
        wordingVersion: 'sms-consent-v1',
        shownText: SHOWN,
        givenAt: T0,
      }),
    );
    const owner = await insertUser(db, 'Mia Merger');
    await withTenant(db, tenantA, (tx) => addMembership(tx, { userId: owner, role: 'owner' }));
    await withMember(db, { tenantId: tenantA, userId: owner }, (tx) =>
      mergeClientRows(tx, kept, merged, new Date()),
    );
    const active = await withTenant(db, tenantA, (tx) => findActiveSmsConsent(tx, phone));
    expect(active).toMatchObject({ id, clientId: kept, revokedAt: null });
  });

  it('goes with a client who is forgotten (ADR-0051)', async () => {
    const phone = '+15552340004';
    const clientId = await client(tenantA, phone);
    await withTenant(db, tenantA, (tx) =>
      insertSmsConsent(tx, {
        phone,
        source: 'booking_page',
        clientId,
        wordingVersion: 'sms-consent-v1',
        shownText: SHOWN,
        givenAt: T0,
      }),
    );
    const owner = await insertUser(db, 'Olive Owner');
    await withTenant(db, tenantA, (tx) => addMembership(tx, { userId: owner, role: 'owner' }));
    const result = await withMember(db, { tenantId: tenantA, userId: owner }, (tx) =>
      deleteClientRow(tx, clientId, new Date()),
    );
    expect(result).toMatchObject({ deleted: true });
    expect(await withTenant(db, tenantA, (tx) => findActiveSmsConsent(tx, phone))).toBeUndefined();
  });
});

describe('SMS consents by client and the names a reply gives (S61.2)', () => {
  const consent = (clientId: ClientId, phone: string, givenAt: Date) => ({
    phone,
    source: 'booking_page' as const,
    clientId,
    wordingVersion: 'sms-consent-v1' as const,
    shownText: SHOWN,
    givenAt,
  });

  it('lists a client’s consents the latest first, the business’s own only (AC-X-66)', async () => {
    const phone = '+15552340101';
    const sam = await client(tenantA, phone);
    await withTenant(db, tenantA, async (tx) => {
      await insertSmsConsent(tx, consent(sam, phone, T0));
      await revokeSmsConsent(tx, phone, 'booking_page', new Date(T0.getTime() + 60_000));
      await insertSmsConsent(tx, consent(sam, phone, new Date(T0.getTime() + 120_000)));
    });
    const rows = await withTenant(db, tenantA, (tx) => listSmsConsentsForClient(tx, sam));
    expect(rows.map((row) => [row.givenAt.toISOString(), row.revokedAt === null])).toEqual([
      [new Date(T0.getTime() + 120_000).toISOString(), true],
      [T0.toISOString(), false],
    ]);
    expect(await withTenant(db, tenantB, (tx) => listSmsConsentsForClient(tx, sam))).toEqual([]);
  });

  it('names the businesses with an active consent for the number, the latest first, two at most (AC-X-68)', async () => {
    const phone = '+15552340102';
    const business = async (name: string, slug: string) =>
      TenantIdSchema.parse((await createTenant(db, { name, slug, timeZone: 'America/Denver' })).id);
    const tenantC = await business('C & Co', 'sms-c');
    const tenantD = await business('D', 'sms-d');
    const tenantE = await business('E', 'sms-e');
    expect(await smsConsentBusinesses(db, phone)).toEqual([]);
    const given = [
      [tenantA, 0],
      [tenantC, 1],
      [tenantE, 2],
    ] as const;
    for (const [tenant, minutes] of given) {
      const id = await client(tenant, phone);
      await withTenant(db, tenant, (tx) =>
        insertSmsConsent(tx, consent(id, phone, new Date(T0.getTime() + minutes * 60_000))),
      );
    }
    // Asked with no business, in a business's transaction or the SMS context: names only.
    expect(await smsConsentBusinesses(db, phone)).toEqual(['E', 'C & Co']);
    expect(await withTenant(db, tenantD, (tx) => smsConsentBusinesses(tx, phone))).toEqual([
      'E',
      'C & Co',
    ]);
    expect(await withSmsInbound(db, (tx) => smsConsentBusinesses(tx, phone))).toEqual([
      'E',
      'C & Co',
    ]);
    // A revoked consent and a business being deleted are left out.
    await withTenant(db, tenantC, (tx) => revokeSmsConsent(tx, phone, 'booking_page', new Date()));
    await withTenant(db, tenantE, (tx) =>
      scheduleCurrentTenantDeletion(tx, new Date(Date.now() + 30 * 86_400_000)),
    );
    expect(await smsConsentBusinesses(db, phone)).toEqual(['A']);
    // Another number has none.
    expect(await withTenant(db, tenantD, (tx) => smsConsentBusinesses(tx, '+15552340199'))).toEqual(
      [],
    );
    expect(await smsConsentBusinesses(db, '+447700900123')).toEqual([]);
  });

  it('lets the app role run the function but not read the tables through it', async () => {
    await expect(
      db.execute(sql`SELECT phone FROM sms_consents WHERE phone = '+15552340102'`),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      db.execute(sql`SELECT * FROM sms_consent_businesses('+15552340102')`),
    ).resolves.toMatchObject({ fields: [expect.objectContaining({ name: 'name' })] });
  });
});

describe('SMS deliveries (AC-X-62)', () => {
  async function sentText(tenant: TenantId): Promise<string> {
    return withTenant(db, tenant, async (tx) => {
      const row = await insertOutboxMessage(tx, {
        id: OutboxMessageIdSchema.parse(newId()),
        type: 'sms',
        dedupeKey: `sms-test:${newId()}`,
        payload: randomBytes(16),
        availableAt: T0,
      });
      const id = String(row?.id);
      await insertSmsDelivery(tx, {
        id,
        provider: 'twilio',
        providerMessageId: `SM${'a'.repeat(31)}${String(events++ % 10)}`,
        segments: 2,
        status: 'queued',
      });
      return id;
    });
  }

  it('moves only forwards, and only for the provider’s own id', async () => {
    const id = await sentText(tenantA);
    const delivery = await withTenant(db, tenantA, (tx) => findSmsDelivery(tx, id));
    const sid = delivery?.providerMessageId ?? '';
    const move = (
      status: 'sent' | 'delivered' | 'sending' | 'failed',
      errorCode: number | null = null,
    ) =>
      withTenant(db, tenantA, (tx) =>
        advanceSmsDelivery(tx, { id, providerMessageId: sid, status, errorCode }),
      );
    expect(await move('delivered')).toBe('moved');
    expect(await move('sending')).toBe('kept');
    expect(await move('failed', 30003)).toBe('kept');
    expect(await withTenant(db, tenantA, (tx) => findSmsDelivery(tx, id))).toMatchObject({
      status: 'delivered',
      errorCode: null,
      segments: 2,
    });
    expect(
      await withTenant(db, tenantA, (tx) =>
        advanceSmsDelivery(tx, {
          id,
          providerMessageId: `SM${'b'.repeat(32)}`,
          status: 'failed',
          errorCode: 1,
        }),
      ),
    ).toBe('missing');
  });

  it('is the business’s own: another business can’t move it', async () => {
    const id = await sentText(tenantA);
    const sid =
      (await withTenant(db, tenantA, (tx) => findSmsDelivery(tx, id)))?.providerMessageId ?? '';
    expect(
      await withTenant(db, tenantB, (tx) =>
        advanceSmsDelivery(tx, {
          id,
          providerMessageId: sid,
          status: 'delivered',
          errorCode: null,
        }),
      ),
    ).toBe('missing');
  });
});

describe('SMS keyword events and opt-out (AC-X-59)', () => {
  it('opts a number out on STOP and back in on START; HELP changes nothing; replays are ignored', async () => {
    const phone = '+15552349999';
    expect(await isSmsOptedOut(db, phone)).toBe(false);
    const stop = keyword(phone, 'stop', T0);
    expect(await withSmsInbound(db, (tx) => insertSmsKeywordEvent(tx, stop))).toBe(true);
    expect(await withSmsInbound(db, (tx) => insertSmsKeywordEvent(tx, stop))).toBe(false);
    expect(await isSmsOptedOut(db, phone)).toBe(true);
    // Asked from a business's transaction too: the definer answers a boolean.
    expect(await withTenant(db, tenantA, (tx) => isSmsOptedOut(tx, phone))).toBe(true);

    await withSmsInbound(db, (tx) =>
      insertSmsKeywordEvent(tx, keyword(phone, 'help', new Date(T0.getTime() + 1000))),
    );
    expect(await isSmsOptedOut(db, phone)).toBe(true);
    const start = keyword(phone, 'start', new Date(T0.getTime() + 2000));
    await withSmsInbound(db, (tx) => insertSmsKeywordEvent(tx, start));
    expect(await isSmsOptedOut(db, phone)).toBe(false);
    // A replay of the earlier STOP doesn't opt them out again.
    expect(await withSmsInbound(db, (tx) => insertSmsKeywordEvent(tx, stop))).toBe(false);
    expect(await isSmsOptedOut(db, phone)).toBe(false);
    // A provider's report opts out too.
    await withSmsInbound(db, (tx) =>
      insertSmsKeywordEvent(tx, {
        ...keyword(phone, 'stop', new Date(T0.getTime() + 3000)),
        eventId: `${newId()}:21610`,
        origin: 'provider',
      }),
    );
    expect(await isSmsOptedOut(db, phone)).toBe(true);
    expect(await isSmsOptedOut(db, 'not a phone')).toBe(false);
  });

  it('is unreachable in a business transaction or without the context, and never changed or deleted', async () => {
    expect(await withTenant(db, tenantA, (tx) => tx.select().from(smsKeywordEvents))).toEqual([]);
    expect(await db.select().from(smsKeywordEvents)).toEqual([]);
    const write = await withTenant(db, tenantA, (tx) =>
      tx.insert(smsKeywordEvents).values(keyword('+15552348888', 'stop', T0)),
    ).catch((error: unknown) => error);
    expect(sqlState(write)).toBe('42501');
    const removed = await withSmsInbound(db, (tx) =>
      tx.execute(sql`DELETE FROM sms_keyword_events`),
    ).catch((error: unknown) => error);
    expect(sqlState(removed)).toBe('42501');
    const changed = await withSmsInbound(db, (tx) =>
      tx.execute(sql`UPDATE sms_keyword_events SET keyword = 'start'`),
    ).catch((error: unknown) => error);
    expect(sqlState(changed)).toBe('42501');
    const provider = await withSmsInbound(db, (tx) =>
      tx
        .insert(smsKeywordEvents)
        .values({ ...keyword('+15552348888', 'help', T0), origin: 'provider' }),
    ).catch((error: unknown) => error);
    expect(sqlState(provider)).toBe('23514');
  });
});

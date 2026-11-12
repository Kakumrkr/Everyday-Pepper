import 'reflect-metadata';
import type { Server } from 'node:http';
import { OutboxDedupeKeySchema, TenantIdSchema, type TenantId } from '@pepper/contracts';
import {
  deliverOutboxMessage,
  outboxKeyFrom,
  queueSms,
  recordSmsConsent,
  systemClock,
  type Mailer,
  type SmsAccepted,
  type SmsMessage,
  type SmsSender,
} from '@pepper/core';
import {
  createTenant,
  findOutboxMessage,
  insertClient,
  isSmsOptedOut,
  prepareDatabase,
  withTenant,
  type Database,
  type DatabaseHandle,
} from '@pepper/db';
import { DATABASE } from '@pepper/runtime';
import { postgresUrlAs, startPostgres, startRedis, type TestService } from '@pepper/testing';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import { loadApiConfig } from './config.js';
import { twilioSignatureOf } from './sms/twilio-signature.js';

// STOP through the api against real Postgres and Redis (S61, AC-X-59, AC-X-61): the whole app as
// configured from its environment, Twilio's form-encoded webhook signed for the public URL, and
// the next delivery to the number dropped with no time passing, so "STOP honoured in under a
// minute" holds by construction.

const ORIGIN = 'http://localhost:3000';
const OUTBOX_SECRET = 'an-integration-test-outbox-secret-32+';
const ACCOUNT = `AC${'1'.repeat(32)}`;
const TOKEN = 'abcdef0123456789abcdef0123456789';
const PHONE = '+15552346666';

let postgres: TestService;
let redis: TestService;
let app: INestApplication;
let server: Server;
let db: Database;
let tenant: TenantId;

class RecordingSender implements SmsSender {
  readonly sent: SmsMessage[] = [];
  send(message: SmsMessage): Promise<SmsAccepted> {
    this.sent.push(message);
    return Promise.resolve({
      provider: 'twilio',
      providerMessageId: `SM${String(this.sent.length).padStart(32, '0')}`,
      segments: 1,
      status: 'queued',
    });
  }
}

beforeAll(async () => {
  [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
  const databaseUrl = postgresUrlAs(postgres.url, 'pepper_service', 'test-password');
  await prepareDatabase(postgres.url, databaseUrl);
  const config = loadApiConfig({
    DATABASE_URL: databaseUrl,
    REDIS_URL: redis.url,
    AUTH_SECRET: 'an-integration-test-secret-32-chars',
    OUTBOX_SECRET,
    AUTH_BASE_URL: ORIGIN,
    SMS_PROVIDER: 'twilio',
    TWILIO_ACCOUNT_SID: ACCOUNT,
    TWILIO_AUTH_TOKEN: TOKEN,
    TWILIO_SENDER: `MG${'2'.repeat(32)}`,
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(config)],
  }).compile();
  // As `createServiceApp` makes it: the raw body kept for signed webhooks.
  app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  await app.init();
  server = app.getHttpServer() as Server;
  db = app.get<DatabaseHandle>(DATABASE).db;
  tenant = TenantIdSchema.parse(
    (await createTenant(db, { name: 'Fade Bros', slug: 'fade-bros', timeZone: 'UTC' })).id,
  );
});

afterAll(async () => {
  await app.close();
  await Promise.all([postgres.stop(), redis.stop()]);
});

describe('a STOP through the api (AC-X-59)', () => {
  it('drops the next delivery to the number once the webhook has answered', async () => {
    const key = outboxKeyFrom(OUTBOX_SECRET);
    const queued = await withTenant(db, tenant, async (tx) => {
      const client = await insertClient(tx, {
        name: 'Sam',
        email: null,
        phone: PHONE,
        source: 'booking_page',
      });
      await recordSmsConsent(
        tx,
        {
          phone: PHONE,
          source: 'booking_page',
          clientId: client.id,
          wordingVersion: 'sms-consent-v1',
          givenAt: new Date(),
        },
        { actor: { kind: 'system' } },
      );
      return queueSms(
        tx,
        { to: PHONE, body: 'Fade Bros: see you at 4pm.', urgent: true, wordsBy: 'template' },
        { key, dedupeKey: OutboxDedupeKeySchema.parse('test.sms:api'), now: new Date() },
      );
    });
    if (queued === undefined) throw new Error('not queued');

    const body = new URLSearchParams({
      ToCountry: 'US',
      MessageSid: `SM${'9'.repeat(32)}`,
      AccountSid: ACCOUNT,
      From: PHONE,
      To: '+15557654321',
      Body: 'STOP',
      NumMedia: '0',
    }).toString();
    const signature = twilioSignatureOf(TOKEN, `${ORIGIN}/v1/webhooks/sms`, [
      ...new URLSearchParams(body),
    ]);
    const response = await request(server)
      .post('/v1/webhooks/sms')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('X-Twilio-Signature', signature)
      .send(body)
      .expect(200);
    expect(response.headers['content-type']).toMatch(/^text\/xml/);
    expect(response.text).toContain('Reply START to resubscribe');
    // The reply names the business the number said yes to (S61.2, AC-X-68).
    expect(response.text).toContain('<Message>Fade Bros via Pepper: ');
    expect(await isSmsOptedOut(db, PHONE)).toBe(true);

    const sender = new RecordingSender();
    const mailer: Mailer = { send: () => Promise.resolve() };
    expect(
      await deliverOutboxMessage(
        db,
        { messageId: queued, tenantId: tenant },
        { key, mailer, sms: sender, clock: systemClock },
      ),
    ).toBe('dropped');
    expect(sender.sent).toEqual([]);
    expect(await withTenant(db, tenant, (tx) => findOutboxMessage(tx, queued))).toMatchObject({
      status: 'dead',
      lastError: 'SmsOptedOut',
    });

    // The same message again (Twilio retrying) changes nothing and gets no second reply.
    const again = await request(server)
      .post('/v1/webhooks/sms')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('X-Twilio-Signature', signature)
      .send(body)
      .expect(200);
    expect(again.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  it('refuses an unsigned STOP, which opts nobody out', async () => {
    const body = new URLSearchParams({
      MessageSid: `SM${'8'.repeat(32)}`,
      AccountSid: ACCOUNT,
      From: '+15552345555',
      To: '+15557654321',
      Body: 'STOP',
    }).toString();
    await request(server)
      .post('/v1/webhooks/sms')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(body)
      .expect(401);
    expect(await isSmsOptedOut(db, '+15552345555')).toBe(false);
  });
});

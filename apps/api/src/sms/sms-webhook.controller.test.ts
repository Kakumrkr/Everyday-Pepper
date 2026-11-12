import 'reflect-metadata';
import type { Server } from 'node:http';
import { ApiErrorSchema } from '@pepper/contracts';
import type * as Appointments from '@pepper/appointments';
import type * as Core from '@pepper/core';
import { DATABASE } from '@pepper/runtime';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SameOriginGuard } from '../auth/guards.js';
import { RateLimiter } from '../http/rate-limit.js';
import { SmsWebhookModule } from './sms-webhook.controller.js';
import { twilioSignatureOf } from './twilio-signature.js';

// Twilio's SMS webhooks without a database (S61, AC-X-59, AC-X-61, AC-X-62): no session and no
// Origin; the signature over the public URL and the form decides; the account must be ours; a
// keyword's reply is TwiML; a status names its business and message in the signed query; off
// without Twilio. core's sms.int.test.ts proves what the calls do.

const core = vi.hoisted(() => ({ handleInboundSms: vi.fn(), recordSmsStatus: vi.fn() }));
vi.mock('@pepper/core', async (original) => ({
  ...(await original<typeof Core>()),
  handleInboundSms: core.handleInboundSms,
  recordSmsStatus: core.recordSmsStatus,
}));
const appointments = vi.hoisted(() => ({ confirmBookingByText: vi.fn() }));
vi.mock('@pepper/appointments', async (original) => ({
  ...(await original<typeof Appointments>()),
  confirmBookingByText: appointments.confirmBookingByText,
}));

const ORIGIN = 'http://localhost:3000';
const BASE = 'https://app.example.test';
const ACCOUNT = `AC${'b'.repeat(32)}`;
const TOKEN = '0123456789abcdef0123456789abcdef';
const NOW = new Date('2026-11-12T17:00:00Z');
const TENANT = '0199f4b2-7c1e-7a00-8000-0000000000a1';
const MESSAGE = '0199f4b2-7c1e-7a00-8000-0000000000b2';

@Global()
@Module({ providers: [{ provide: DATABASE, useValue: { db: {} } }], exports: [DATABASE] })
class FakeConnectionsModule {}

const limits = { hit: vi.fn(() => Promise.resolve()) };

async function start(twilio: { accountSid: string; authToken: string } | null) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      FakeConnectionsModule,
      SmsWebhookModule.forRoot({ twilio, baseUrl: BASE, clock: { now: () => NOW } }),
    ],
    providers: [
      {
        provide: APP_GUARD,
        useFactory: (reflector: Reflector) => new SameOriginGuard(reflector, ORIGIN),
        inject: [Reflector],
      },
    ],
  })
    .overrideProvider(RateLimiter)
    .useValue(limits)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  await app.init();
  return app;
}

let app: INestApplication;
let off: INestApplication;
let server: Server;

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

function signature(path: string, body: string, token = TOKEN): string {
  return twilioSignatureOf(token, `${BASE}${path}`, [...new URLSearchParams(body)]);
}

const inbound = (body = 'STOP', extra: Record<string, string> = {}) => ({
  MessageSid: `SM${'a'.repeat(32)}`,
  AccountSid: ACCOUNT,
  From: '+15552340001',
  To: '+15557654321',
  Body: body,
  NumMedia: '0',
  ...extra,
});

function post(path: string, body: string, sig?: string) {
  const call = request(server)
    .post(path)
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .send(body);
  return sig === undefined ? call : call.set('X-Twilio-Signature', sig);
}

beforeAll(async () => {
  app = await start({ accountSid: ACCOUNT, authToken: TOKEN });
  off = await start(null);
  server = app.getHttpServer() as Server;
});

afterAll(async () => {
  await app.close();
  await off.close();
});

beforeEach(() => {
  core.handleInboundSms.mockReset();
  core.recordSmsStatus.mockReset();
  core.handleInboundSms.mockResolvedValue({ keyword: 'stop', reply: 'Pepper: You & "they" <ok>' });
  core.recordSmsStatus.mockResolvedValue('moved');
  appointments.confirmBookingByText.mockReset();
  appointments.confirmBookingByText.mockResolvedValue({
    outcome: 'confirmed',
    reply: "Juniper via Pepper: Thanks, you're confirmed",
  });
});

describe('POST /v1/webhooks/sms (AC-X-59, AC-X-61)', () => {
  const path = '/v1/webhooks/sms';

  it('handles a signed text in the request and replies with escaped TwiML', async () => {
    const body = form(inbound('Stop texting me'));
    const response = await post(path, body, signature(path, body)).expect(200);
    expect(response.headers['content-type']).toMatch(/^text\/xml/);
    expect(response.text).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Pepper: You &amp; &quot;they&quot; &lt;ok&gt;</Message></Response>',
    );
    expect(core.handleInboundSms).toHaveBeenCalledWith(
      {},
      {
        provider: 'twilio',
        eventId: `SM${'a'.repeat(32)}`,
        from: '+15552340001',
        body: 'Stop texting me',
        receivedAt: NOW,
      },
      { helpUrl: `${BASE}/help` },
    );
    expect(limits.hit).toHaveBeenCalled();
  });

  it('answers with no reply when core has none (a replay, not a keyword)', async () => {
    core.handleInboundSms.mockResolvedValue({ keyword: null, reply: null });
    const body = form(inbound('Thanks!'));
    const response = await post(path, body, signature(path, body)).expect(200);
    expect(response.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  it('confirms by "C" in the request and replies with the time (S62, AC-X-74)', async () => {
    core.handleInboundSms.mockResolvedValue({ keyword: null, reply: null });
    const body = form(inbound('c.'));
    const response = await post(path, body, signature(path, body)).expect(200);
    expect(response.text).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Juniper via Pepper: Thanks, you&apos;re confirmed</Message></Response>',
    );
    expect(appointments.confirmBookingByText).toHaveBeenCalledWith(
      {},
      { from: '+15552340001', receivedAt: NOW },
    );
  });

  it('never confirms on a keyword, and answers no reply when the confirm has none', async () => {
    const body = form(inbound('CANCEL'));
    await post(path, body, signature(path, body)).expect(200);
    expect(appointments.confirmBookingByText).not.toHaveBeenCalled();

    core.handleInboundSms.mockResolvedValue({ keyword: null, reply: null });
    appointments.confirmBookingByText.mockResolvedValue({ outcome: 'nothing', reply: null });
    const c = form(inbound('Confirm'));
    const response = await post(path, c, signature(path, c)).expect(200);
    expect(response.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  it('refuses a missing, wrong or tampered signature, before anything is read', async () => {
    const body = form(inbound());
    for (const sig of [undefined, 'bm9wZQ==', signature(path, body, 'f'.repeat(32))]) {
      const response = await post(path, body, sig).expect(401);
      expect(ApiErrorSchema.parse(response.body).code).toBe('webhook_signature_invalid');
    }
    const tampered = form(inbound('START'));
    await post(path, tampered, signature(path, body)).expect(401);
    // Signed for another URL (the status route) doesn't count here.
    await post(path, body, signature('/v1/webhooks/sms/status', body)).expect(401);
    expect(core.handleInboundSms).not.toHaveBeenCalled();
  });

  it('refuses a signed text from another Twilio account, or without its fields', async () => {
    const other = form(inbound('STOP', { AccountSid: `AC${'c'.repeat(32)}` }));
    await post(path, other, signature(path, other)).expect(400);
    const bare = form({ Body: 'STOP' });
    await post(path, bare, signature(path, bare)).expect(400);
    expect(core.handleInboundSms).not.toHaveBeenCalled();
  });

  it('is 404 while SMS isn’t on with Twilio', async () => {
    const body = form(inbound());
    await request(off.getHttpServer() as Server)
      .post(path)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('X-Twilio-Signature', signature(path, body))
      .send(body)
      .expect(404);
  });
});

describe('POST /v1/webhooks/sms/status (AC-X-62)', () => {
  const path = `/v1/webhooks/sms/status?t=${TENANT}&m=${MESSAGE}`;
  const report = (extra: Record<string, string> = {}) =>
    form({
      MessageSid: `SM${'d'.repeat(32)}`,
      AccountSid: ACCOUNT,
      MessageStatus: 'undelivered',
      ErrorCode: '30003',
      ...extra,
    });

  it('records the report for the business and message the signed query names', async () => {
    const body = report();
    const response = await post(path, body, signature(path, body)).expect(200);
    expect(response.body).toEqual({ received: true });
    expect(core.recordSmsStatus).toHaveBeenCalledWith(
      {},
      {
        tenantId: TENANT,
        messageId: MESSAGE,
        providerMessageId: `SM${'d'.repeat(32)}`,
        status: 'undelivered',
        errorCode: 30003,
      },
    );
  });

  it('records a report with ErrorCode 0 as no error', async () => {
    const body = report({ MessageStatus: 'delivered', ErrorCode: '0' });
    await post(path, body, signature(path, body)).expect(200);
    expect(core.recordSmsStatus).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ errorCode: null }),
    );
  });

  it('refuses a query changed after signing, or one that names no business', async () => {
    const body = report();
    const otherTenant = `/v1/webhooks/sms/status?t=0199f4b2-7c1e-7a00-8000-0000000000ff&m=${MESSAGE}`;
    await post(otherTenant, body, signature(path, body)).expect(401);
    const noTenant = `/v1/webhooks/sms/status?m=${MESSAGE}`;
    await post(noTenant, body, signature(noTenant, body)).expect(400);
    const other = report({ AccountSid: `AC${'c'.repeat(32)}` });
    await post(path, other, signature(path, other)).expect(400);
    expect(core.recordSmsStatus).not.toHaveBeenCalled();
  });
});

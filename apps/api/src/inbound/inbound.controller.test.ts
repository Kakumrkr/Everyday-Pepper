import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { ApiErrorSchema } from '@pepper/contracts';
import type * as Core from '@pepper/core';
import { DATABASE } from '@pepper/runtime';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SameOriginGuard } from '../auth/guards.js';
import { RateLimiter } from '../http/rate-limit.js';
import { InboundModule } from './inbound.controller.js';

// The inbound webhook without a database (S59.3, AC-X-33): no session and no Origin; the Svix
// signature over the raw bytes decides; only `email.received` is stored, bounces and complaints
// recorded (S59.3.2); off without a secret.
// core's inbound-email.int.test.ts proves the storing and what follows.

const core = vi.hoisted(() => ({ recordInboundEmail: vi.fn(), recordEmailProblem: vi.fn() }));
vi.mock('@pepper/core', async (original) => ({
  ...(await original<typeof Core>()),
  recordInboundEmail: core.recordInboundEmail,
  recordEmailProblem: core.recordEmailProblem,
}));

const ORIGIN = 'http://localhost:3000';
const KEY = Buffer.from('a-test-webhook-signing-key-32-bytes!');
const SECRET = `whsec_${KEY.toString('base64')}`;
const NOW = new Date('2026-11-08T10:00:00Z');
const clock = { now: () => NOW };

@Global()
@Module({ providers: [{ provide: DATABASE, useValue: { db: {} } }], exports: [DATABASE] })
class FakeConnectionsModule {}

const limits = { hit: vi.fn(() => Promise.resolve()) };

async function start(webhookSecret: string | null): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [FakeConnectionsModule, InboundModule.forRoot({ webhookSecret, clock })],
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

function signed(body: string, id = 'msg_2abc', at = NOW, key = KEY) {
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` };
}

const received = JSON.stringify({
  type: 'email.received',
  created_at: '2026-11-08T10:00:00.000Z',
  data: {
    email_id: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c',
    message_id: '<CAG1abc@mail.gmail.com>',
    from: 'Ana <ana@juniper.test>',
    to: ['reply+pep-7k2m9q-1-abcdefghijklmnopqrst@reply.pepper.test'],
    subject: 'Re: Pepper replied',
    attachments: [],
  },
});

beforeAll(async () => {
  app = await start(SECRET);
  off = await start(null);
  server = app.getHttpServer() as Server;
});

afterAll(async () => {
  await app.close();
  await off.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  core.recordInboundEmail.mockResolvedValue(true);
  core.recordEmailProblem.mockResolvedValue(1);
});

describe('POST /v1/webhooks/resend (AC-X-33)', () => {
  it('stores a signed email.received event, with no session and no Origin', async () => {
    const answer = await request(server)
      .post('/v1/webhooks/resend')
      .set(signed(received))
      .type('application/json')
      .send(received)
      .expect(200);
    expect(answer.body).toEqual({ received: true });
    expect(core.recordInboundEmail).toHaveBeenCalledWith(
      {},
      {
        provider: 'resend',
        eventId: 'msg_2abc',
        providerEmailId: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c',
        messageId: '<CAG1abc@mail.gmail.com>',
        receivedAt: NOW,
      },
    );
    expect(limits.hit).toHaveBeenCalledTimes(1);
  });

  it('answers the same for an event already stored', async () => {
    core.recordInboundEmail.mockResolvedValue(false);
    const answer = await request(server)
      .post('/v1/webhooks/resend')
      .set(signed(received))
      .type('application/json')
      .send(received)
      .expect(200);
    expect(answer.body).toEqual({ received: true });
  });

  it('acknowledges other event types without storing them', async () => {
    const delivered = JSON.stringify({ type: 'email.delivered', data: { email_id: 'x' } });
    await request(server)
      .post('/v1/webhooks/resend')
      .set(signed(delivered))
      .type('application/json')
      .send(delivered)
      .expect(200);
    expect(core.recordInboundEmail).not.toHaveBeenCalled();
    expect(core.recordEmailProblem).not.toHaveBeenCalled();
  });

  it.each([
    ['email.bounced', { type: 'Permanent', subType: 'General' }, 'Permanent'],
    ['email.complained', undefined, null],
  ] as const)(
    'records a signed %s event for its recipients (S59.3.2, AC-X-42)',
    async (type, bounce, bounceType) => {
      const body = JSON.stringify({
        type,
        data: { email_id: 'em_1', to: ['Ana <ana@juniper.test>'], ...(bounce && { bounce }) },
      });
      await request(server)
        .post('/v1/webhooks/resend')
        .set(signed(body, 'msg_bounce'))
        .type('application/json')
        .send(body)
        .expect(200);
      expect(core.recordEmailProblem).toHaveBeenCalledWith(
        {},
        {
          provider: 'resend',
          eventId: 'msg_bounce',
          type,
          recipients: ['Ana <ana@juniper.test>'],
          bounceType,
          occurredAt: NOW,
        },
      );
      expect(core.recordInboundEmail).not.toHaveBeenCalled();
    },
  );

  it('acknowledges a bounce that names no recipient, recording nothing; refuses an unsigned one', async () => {
    const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 'x' } });
    await request(server)
      .post('/v1/webhooks/resend')
      .set(signed(body))
      .type('application/json')
      .send(body)
      .expect(200);
    const named = JSON.stringify({ type: 'email.complained', data: { to: ['a@b.test'] } });
    await request(server)
      .post('/v1/webhooks/resend')
      .set(signed(named, 'msg_x', NOW, Buffer.from('another-key-of-thirty-two-bytes!!!')))
      .type('application/json')
      .send(named)
      .expect(401);
    expect(core.recordEmailProblem).not.toHaveBeenCalled();
  });

  it.each([
    ['no signature', {}],
    ['a body other than the one signed', signed(`${received} `)],
    [
      'another key',
      signed(received, 'msg_2abc', NOW, Buffer.from('another-webhook-signing-key-32-byt')),
    ],
    [
      'a timestamp 10 minutes old (a replay)',
      signed(received, 'msg_2abc', new Date(NOW.getTime() - 600_000)),
    ],
  ])('refuses %s with 401, storing nothing', async (_name, headers) => {
    const answer = await request(server)
      .post('/v1/webhooks/resend')
      .set(headers)
      .type('application/json')
      .send(received)
      .expect(401);
    expect(ApiErrorSchema.parse(answer.body).code).toBe('webhook_signature_invalid');
    expect(core.recordInboundEmail).not.toHaveBeenCalled();
  });

  it('refuses a signed event of the wrong shape with 400', async () => {
    const shapeless = JSON.stringify({ type: 'email.received', data: {} });
    const answer = await request(server)
      .post('/v1/webhooks/resend')
      .set(signed(shapeless))
      .type('application/json')
      .send(shapeless)
      .expect(400);
    expect(ApiErrorSchema.parse(answer.body).code).toBe('validation_failed');
  });

  it('refuses a body over the JSON limit with 413', async () => {
    const huge = JSON.stringify({
      type: 'email.received',
      data: { email_id: 'x', pad: 'x'.repeat(200_000) },
    });
    await request(server)
      .post('/v1/webhooks/resend')
      .set(signed(huge))
      .type('application/json')
      .send(huge)
      .expect(413);
    expect(core.recordInboundEmail).not.toHaveBeenCalled();
  });

  it('is not found while no secret is set', async () => {
    const answer = await request(off.getHttpServer() as Server)
      .post('/v1/webhooks/resend')
      .set(signed(received))
      .type('application/json')
      .send(received)
      .expect(404);
    expect(ApiErrorSchema.parse(answer.body).code).toBe('webhook_not_found');
  });
});

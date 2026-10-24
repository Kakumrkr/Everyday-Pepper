import 'reflect-metadata';
import type { Server } from 'node:http';
import { ApiErrorSchema, ClientIdSchema, TenantIdSchema } from '@pepper/contracts';
import {
  outboxKeyFrom,
  UnsubscribeLinkInvalidError,
  unsubscribeKeyFrom,
  unsubscribeToken,
} from '@pepper/core';
import type * as Core from '@pepper/core';
import { DATABASE } from '@pepper/runtime';
import { Global, HttpException, Module, type INestApplication } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SameOriginGuard } from '../auth/guards.js';
import { RateLimiter } from '../http/rate-limit.js';
import { UnsubscribeModule } from './unsubscribe.controller.js';

// One-click unsubscribe without a database (S36): no session, GET changes nothing, POST works
// without the app's Origin (a mail provider's RFC 8058 request has none), the link is checked
// by core, and the rate limit applies. unsubscribe.int.test.ts in core proves the writes.

const core = vi.hoisted(() => ({ describeUnsubscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock('@pepper/core', async (original) => ({
  ...(await original<typeof Core>()),
  describeUnsubscribe: core.describeUnsubscribe,
  unsubscribe: core.unsubscribe,
}));

const ORIGIN = 'http://localhost:3000';
const OUTBOX_KEY = outboxKeyFrom('an-api-test-outbox-secret-of-32-chars!');
const TOKEN = unsubscribeToken(unsubscribeKeyFrom(OUTBOX_KEY), {
  tenantId: TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192'),
  clientId: ClientIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193'),
});

@Global()
@Module({ providers: [{ provide: DATABASE, useValue: { db: {} } }], exports: [DATABASE] })
class FakeConnectionsModule {}

let app: INestApplication;
let server: Server;
const limits = { hit: vi.fn(() => Promise.resolve()) };

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [FakeConnectionsModule, UnsubscribeModule.forRoot({ outboxKey: OUTBOX_KEY })],
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
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  server = app.getHttpServer() as Server;
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  core.describeUnsubscribe.mockResolvedValue({ businessName: 'Juniper', unsubscribed: false });
  core.unsubscribe.mockResolvedValue({ businessName: 'Juniper', unsubscribed: true });
});

describe('/v1/public/unsubscribe/:token', () => {
  it('describes without unsubscribing', async () => {
    const page = await request(server).get(`/v1/public/unsubscribe/${TOKEN}`).expect(200);
    expect(page.body).toEqual({ businessName: 'Juniper', unsubscribed: false });
    expect(core.unsubscribe).not.toHaveBeenCalled();
    expect(limits.hit).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on a one-click POST from a mail provider (no Origin, form body)', async () => {
    const done = await request(server)
      .post(`/v1/public/unsubscribe/${TOKEN}`)
      .type('form')
      .send('List-Unsubscribe=One-Click')
      .expect(200);
    expect(done.body).toEqual({ businessName: 'Juniper', unsubscribed: true });
    expect(core.unsubscribe).toHaveBeenCalledWith({}, unsubscribeKeyFrom(OUTBOX_KEY), TOKEN, {});
  });

  it('answers 404 unsubscribe_link_invalid for a link core refuses', async () => {
    core.unsubscribe.mockRejectedValueOnce(new UnsubscribeLinkInvalidError());
    const refused = await request(server).post(`/v1/public/unsubscribe/${TOKEN}`).expect(404);
    expect(ApiErrorSchema.parse(refused.body).code).toBe('unsubscribe_link_invalid');
  });

  it('is rate limited per address', async () => {
    limits.hit.mockRejectedValueOnce(new HttpException('slow', 429));
    await request(server).get(`/v1/public/unsubscribe/${TOKEN}`).expect(429);
    expect(core.describeUnsubscribe).not.toHaveBeenCalled();
  });

  it('gives the mail provider’s one-click POSTs a wider limit than the page (S36b review)', async () => {
    await request(server).get(`/v1/public/unsubscribe/${TOKEN}`).expect(200);
    await request(server).post(`/v1/public/unsubscribe/${TOKEN}`).expect(200);
    const [[read], [post]] = limits.hit.mock.calls as unknown as [
      [{ max: number }],
      [{ max: number }],
    ];
    expect(read.max).toBe(30);
    expect(post.max).toBeGreaterThanOrEqual(300);
  });
});

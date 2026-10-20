import 'reflect-metadata';
import type { IncomingHttpHeaders, Server } from 'node:http';
import {
  ApiErrorSchema,
  TenantIdSchema,
  UserIdSchema,
  type MembershipRole,
} from '@pepper/contracts';
import { DATABASE } from '@pepper/runtime';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenancyService } from '../account/tenancy.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { PushModule } from './push.module.js';
import { PushService } from './push.service.js';

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const PUBLIC_KEY = 'B'.repeat(87);
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc';
const KEYS = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) };

class FakeAuth extends AuthService {
  session: AuthSession = {
    id: 'session-1',
    user: { id: USER, name: 'Ana', email: 'ana@example.test', twoFactorEnabled: true },
    activeTenantId: TENANT,
  };
  readonly setActiveTenant = vi.fn(() => Promise.resolve());
  handle = vi.fn(() => Promise.resolve());
  getSession(headers: IncomingHttpHeaders): Promise<AuthSession | null> {
    return Promise.resolve(headers.cookie === 'signed-in' ? this.session : null);
  }
}

let role: MembershipRole = 'staff';
const tenancy = { roleIn: vi.fn(() => Promise.resolve(role)) };
const push = {
  save: vi.fn(() => Promise.resolve()),
  remove: vi.fn(() => Promise.resolve()),
  status: vi.fn(() => Promise.resolve(true)),
};

@Global()
@Module({ providers: [{ provide: DATABASE, useValue: { db: {} } }], exports: [DATABASE] })
class FakeConnectionsModule {}

async function appWith(
  publicKey: string | null,
): Promise<{ app: INestApplication; server: Server }> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      FakeConnectionsModule,
      AuthModule.forRoot({ baseUrl: ORIGIN, secret: 'x'.repeat(32) }),
      PushModule.forRoot({ publicKey, outboxKey: Buffer.alloc(32) }),
    ],
  })
    .overrideProvider(AuthService)
    .useValue(new FakeAuth())
    .overrideProvider(TenancyService)
    .useValue(tenancy)
    .overrideProvider(PushService)
    .useValue(push)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return { app, server: app.getHttpServer() as Server };
}

let on: { app: INestApplication; server: Server };
let off: { app: INestApplication; server: Server };

beforeAll(async () => {
  on = await appWith(PUBLIC_KEY);
  off = await appWith(null);
});

afterAll(async () => {
  await on.app.close();
  await off.app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  role = 'staff';
});

const context = () => ({ tenantId: TENANT, userId: USER, role });
const send = (
  server: Server,
  method: 'put' | 'delete' | 'post',
  path: string,
  body: object,
  origin = ORIGIN,
) => request(server)[method](path).set('cookie', 'signed-in').set('origin', origin).send(body);

function code(body: unknown): string {
  return ApiErrorSchema.parse(body).code;
}

describe('/v1/push (ADR-0026)', () => {
  it('gives the public key, or null when pushes are off; needs a session', async () => {
    const get = (server: Server) => request(server).get('/v1/push/key').set('cookie', 'signed-in');
    expect((await get(on.server).expect(200)).body).toEqual({ publicKey: PUBLIC_KEY });
    expect((await get(off.server).expect(200)).body).toEqual({ publicKey: null });
    await request(on.server).get('/v1/push/key').expect(401);
  });

  it.each<MembershipRole>(['owner', 'manager', 'staff'])(
    'a(n) %s turns this device on and off',
    async (r) => {
      role = r;
      await send(on.server, 'put', '/v1/push/subscription', {
        endpoint: ENDPOINT,
        keys: KEYS,
        expirationTime: null,
      }).expect(204);
      expect(push.save).toHaveBeenCalledWith(context(), {
        endpoint: ENDPOINT,
        keys: KEYS,
        expirationTime: null,
      });
      expect(
        (
          await send(on.server, 'post', '/v1/push/subscription/status', {
            endpoint: ENDPOINT,
          }).expect(200)
        ).body,
      ).toEqual({ subscribed: true });
      await send(on.server, 'delete', '/v1/push/subscription', { endpoint: ENDPOINT }).expect(204);
      expect(push.remove).toHaveBeenCalledWith(context(), { endpoint: ENDPOINT });
    },
  );

  it('503 push_unavailable when pushes are off; 400 for an http endpoint or bad keys', async () => {
    expect(
      code(
        (
          await send(off.server, 'put', '/v1/push/subscription', {
            endpoint: ENDPOINT,
            keys: KEYS,
          }).expect(503)
        ).body,
      ),
    ).toBe('push_unavailable');
    await send(on.server, 'put', '/v1/push/subscription', {
      endpoint: 'http://push.example.test/x',
      keys: KEYS,
    }).expect(400);
    await send(on.server, 'put', '/v1/push/subscription', {
      endpoint: ENDPOINT,
      keys: { p256dh: 'x', auth: 'y' },
    }).expect(400);
    await send(on.server, 'delete', '/v1/push/subscription', {}).expect(400);
    expect(push.save).not.toHaveBeenCalled();
    expect(push.remove).not.toHaveBeenCalled();
  });

  it('403 from another origin', async () => {
    await send(
      on.server,
      'put',
      '/v1/push/subscription',
      { endpoint: ENDPOINT, keys: KEYS },
      'https://evil.test',
    ).expect(403);
    expect(push.save).not.toHaveBeenCalled();
  });
});

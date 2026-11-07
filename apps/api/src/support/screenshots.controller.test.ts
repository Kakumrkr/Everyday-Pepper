import 'reflect-metadata';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { ApiErrorSchema, TenantIdSchema, UserIdSchema } from '@pepper/contracts';
import {
  SupportLimitReachedError,
  SupportScreenshotNotFoundError,
  SupportScreenshotRejectedError,
  SupportScreenshotsNotAttachableError,
} from '@pepper/core';
import type * as Core from '@pepper/core';
import { DATABASE, MAILER } from '@pepper/runtime';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenancyService } from '../account/tenancy.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { RateLimiter } from '../http/rate-limit.js';
import { SCREENSHOT_STORE } from './screenshot-store.js';
import { SupportModule } from './support.controller.js';

// Screenshots' api without a database or storage (S59.2.3, AC-X-27…30): the upload's limits
// before core (no store, size, sent type), the error answers, the private image headers, the
// console's route, and what reaches core. core's support-screenshots.int.test.ts proves the rules.

const core = vi.hoisted(() => ({
  uploadSupportScreenshot: vi.fn(),
  discardSupportScreenshot: vi.fn(),
  readSupportScreenshotImage: vi.fn(),
  readOperatorScreenshotImage: vi.fn(),
  replyToSupportThread: vi.fn(),
  isOperator: vi.fn(),
}));
vi.mock('@pepper/core', async (original) => ({ ...(await original<typeof Core>()), ...core }));

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const SHOT = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f7081a0';
const STORE = { process: vi.fn(), put: vi.fn(), get: vi.fn(), delete: vi.fn() };
const IMAGE = { body: Uint8Array.of(82, 73, 70, 70), contentType: 'image/webp' };

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

const tenancy = { roleIn: vi.fn(() => Promise.resolve('staff' as const)) };
const limits = { hit: vi.fn(() => Promise.resolve()) };
const OPTIONS = {
  outboxKey: Buffer.alloc(32, 1),
  supportEmail: 'support@pepper.test',
  baseUrl: ORIGIN,
  release: '1.4.0',
};

@Global()
@Module({
  providers: [
    { provide: DATABASE, useValue: { db: {} } },
    { provide: MAILER, useValue: null },
  ],
  exports: [DATABASE, MAILER],
})
class FakeConnectionsModule {}

async function appWith(store: unknown): Promise<INestApplication> {
  @Global()
  @Module({
    providers: [{ provide: SCREENSHOT_STORE, useValue: store }],
    exports: [SCREENSHOT_STORE],
  })
  class FakeStoreModule {}
  const moduleRef = await Test.createTestingModule({
    imports: [
      FakeConnectionsModule,
      FakeStoreModule,
      AuthModule.forRoot({ baseUrl: ORIGIN, secret: 'x'.repeat(32) }),
      SupportModule.forRoot(OPTIONS),
    ],
  })
    .overrideProvider(AuthService)
    .useValue(new FakeAuth())
    .overrideProvider(TenancyService)
    .useValue(tenancy)
    .overrideProvider(RateLimiter)
    .useValue(limits)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

let app: INestApplication;
let server: Server;
let bare: INestApplication;

beforeAll(async () => {
  app = await appWith(STORE);
  server = app.getHttpServer() as Server;
  bare = await appWith(null);
});

afterAll(async () => {
  await app.close();
  await bare.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  core.uploadSupportScreenshot.mockResolvedValue({ id: SHOT, width: 1170, height: 2532 });
  core.readSupportScreenshotImage.mockResolvedValue(IMAGE);
  core.readOperatorScreenshotImage.mockResolvedValue(IMAGE);
  core.discardSupportScreenshot.mockResolvedValue(undefined);
  core.isOperator.mockResolvedValue(true);
});

const upload = (target: Server = server) =>
  request(target).post('/v1/support/screenshots').set('Cookie', 'signed-in').set('Origin', ORIGIN);

describe('POST /v1/support/screenshots (AC-X-28)', () => {
  it('201 the screenshot; the bytes and the session’s business and user reach core', async () => {
    const response = await upload()
      .set('Content-Type', 'image/png')
      .send(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      .expect(201);
    expect(response.body).toEqual({ id: SHOT, width: 1170, height: 2532 });
    const [, actor, bytes, options] = core.uploadSupportScreenshot.mock.calls[0] as [
      unknown,
      { context: { tenantId: string; userId: string } },
      Buffer,
      { store: unknown },
    ];
    expect(actor.context).toMatchObject({ tenantId: TENANT, userId: USER });
    expect([...bytes]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(options.store).toBe(STORE);
    expect(limits.hit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'support-screenshot' }),
      USER,
    );
  });

  it('401 signed out; 503 without storage, before reading the body', async () => {
    await request(server).post('/v1/support/screenshots').set('Origin', ORIGIN).expect(401);
    const response = await upload(bare.getHttpServer() as Server)
      .set('Content-Type', 'image/png')
      .send(Buffer.from([1]))
      .expect(503);
    expect(ApiErrorSchema.parse(response.body).code).toBe('screenshots_unavailable');
    expect(core.uploadSupportScreenshot).not.toHaveBeenCalled();
  });

  it('413 over 10 MB and 415 sent as another type, before core', async () => {
    const big = await upload()
      .set('Content-Type', 'image/png')
      .send(Buffer.alloc(10 * 1024 * 1024 + 1))
      .expect(413);
    expect(ApiErrorSchema.parse(big.body).code).toBe('screenshot_too_large');
    const text = await upload().set('Content-Type', 'text/html').send('<html>').expect(415);
    expect(text.body).toMatchObject({ code: 'screenshot_rejected', reason: 'unsupported_type' });
    expect(core.uploadSupportScreenshot).not.toHaveBeenCalled();
  });

  it('answers core’s refusals in words', async () => {
    const answers: [Error, number, string][] = [
      [
        new SupportScreenshotRejectedError('heic', 'HEIC screenshots are not supported yet.'),
        415,
        'screenshot_rejected',
      ],
      [
        new SupportScreenshotRejectedError('bad_shape', 'Too long and thin.'),
        422,
        'screenshot_rejected',
      ],
      [new SupportScreenshotRejectedError('too_large', 'Over 10 MB.'), 413, 'screenshot_too_large'],
      [new SupportLimitReachedError('screenshots'), 429, 'screenshot_limit_reached'],
    ];
    for (const [error, status, code] of answers) {
      core.uploadSupportScreenshot.mockRejectedValueOnce(error);
      const response = await upload()
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from([1, 2]))
        .expect(status);
      expect(ApiErrorSchema.parse(response.body).code).toBe(code);
    }
    core.uploadSupportScreenshot.mockRejectedValueOnce(
      new SupportScreenshotRejectedError('heic', 'HEIC screenshots are not supported yet.'),
    );
    const heic = await upload()
      .set('Content-Type', 'image/heic')
      .send(Buffer.from([1]));
    expect(heic.body).toMatchObject({ message: 'HEIC screenshots are not supported yet.' });
  });
});

describe('GET and DELETE /v1/support/screenshots/:id (AC-X-29)', () => {
  it('serves the image privately: never cached, never sniffed', async () => {
    const response = await request(server)
      .get(`/v1/support/screenshots/${SHOT}?size=thumb`)
      .set('Cookie', 'signed-in')
      .expect(200);
    expect(response.headers).toMatchObject({
      'content-type': 'image/webp',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
      'cross-origin-resource-policy': 'same-origin',
    });
    const [, actor, id, size, options] = core.readSupportScreenshotImage.mock.calls[0] as [
      unknown,
      { context: { userId: string; tenantId: string } },
      string,
      string,
      unknown,
    ];
    expect([actor.context.userId, actor.context.tenantId, id, size]).toEqual([
      USER,
      TENANT,
      SHOT,
      'thumb',
    ]);
    expect(options).toEqual({ store: STORE });
  });

  it('full by default; 400 for an unknown size; 404 for what core doesn’t serve', async () => {
    await request(server)
      .get(`/v1/support/screenshots/${SHOT}`)
      .set('Cookie', 'signed-in')
      .expect(200);
    expect(core.readSupportScreenshotImage.mock.calls[0]?.[3]).toBe('full');
    await request(server)
      .get(`/v1/support/screenshots/${SHOT}?size=huge`)
      .set('Cookie', 'signed-in')
      .expect(400);
    core.readSupportScreenshotImage.mockRejectedValueOnce(new SupportScreenshotNotFoundError());
    const missing = await request(server)
      .get(`/v1/support/screenshots/${SHOT}`)
      .set('Cookie', 'signed-in')
      .expect(404);
    expect(ApiErrorSchema.parse(missing.body).code).toBe('screenshot_not_found');
  });

  it('204 removes an unsent one; 404 otherwise', async () => {
    await request(server)
      .delete(`/v1/support/screenshots/${SHOT}`)
      .set('Cookie', 'signed-in')
      .set('Origin', ORIGIN)
      .expect(204);
    core.discardSupportScreenshot.mockRejectedValueOnce(new SupportScreenshotNotFoundError());
    await request(server)
      .delete(`/v1/support/screenshots/${SHOT}`)
      .set('Cookie', 'signed-in')
      .set('Origin', ORIGIN)
      .expect(404);
  });

  it('422 screenshots_not_attachable when a reply names one it can’t send', async () => {
    core.replyToSupportThread.mockRejectedValueOnce(new SupportScreenshotsNotAttachableError());
    const response = await request(server)
      .post('/v1/support/threads/0199f0a4-7c1e-7d2a-9b3c-4d5e6f708190/messages')
      .set('Cookie', 'signed-in')
      .set('Origin', ORIGIN)
      .send({ message: 'Look', screenshotIds: [SHOT] })
      .expect(422);
    expect(ApiErrorSchema.parse(response.body).code).toBe('screenshots_not_attachable');
    expect(core.replyToSupportThread.mock.calls[0]?.[3]).toEqual({
      message: 'Look',
      screenshotIds: [SHOT],
    });
  });
});

describe('GET /v1/ops/screenshots/:id (AC-X-30)', () => {
  it('serves an operator through core’s logged read, privately', async () => {
    const response = await request(server)
      .get(`/v1/ops/screenshots/${SHOT}?size=full`)
      .set('Cookie', 'signed-in')
      .expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(core.readOperatorScreenshotImage).toHaveBeenCalledWith(
      {},
      { userId: USER },
      SHOT,
      'full',
      {
        store: STORE,
      },
    );
  });

  it('403 for an account that isn’t an operator', async () => {
    core.isOperator.mockResolvedValue(false);
    await request(server).get(`/v1/ops/screenshots/${SHOT}`).set('Cookie', 'signed-in').expect(403);
    expect(core.readOperatorScreenshotImage).not.toHaveBeenCalled();
  });
});

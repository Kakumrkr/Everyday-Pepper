import 'reflect-metadata';
import type { IncomingHttpHeaders, Server } from 'node:http';
import {
  ApiErrorSchema,
  TenantIdSchema,
  UserIdSchema,
  type MembershipRole,
} from '@pepper/contracts';
import type { BusinessExport } from '@pepper/imports';
import { DATABASE } from '@pepper/runtime';
import { Global, HttpException, HttpStatus, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenancyService } from '../account/tenancy.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { apiError } from '../auth/guards.js';
import { RateLimiter, type RateLimit } from '../http/rate-limit.js';
import { ExportModule } from './export.module.js';
import { ExportService } from './export.service.js';

// `/v1/tenant/export` with the export service replaced (S51, ADR-0053, AC-W1-37): who may call
// it, what the download carries, and the rate limit. The whole path runs in export.int.test.ts.

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const BUILT: BusinessExport = {
  fileName: 'pepper-export-fade-2099-03-10.zip',
  bytes: new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
  counts: { clients: 0, visits: 0, services: 0, staff: 0, waitlist: 0, facts: 0 },
};

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

let role: MembershipRole = 'owner';
const tenancy = { roleIn: vi.fn(() => Promise.resolve(role)) };
const exports = { export: vi.fn(() => Promise.resolve(BUILT)) };
let overLimit = false;
const limiter = {
  hit: vi.fn<(limit: RateLimit, key: string) => Promise<void>>(() =>
    overLimit
      ? Promise.reject(
          new HttpException(apiError('too_many_requests'), HttpStatus.TOO_MANY_REQUESTS),
        )
      : Promise.resolve(),
  ),
};

@Global()
@Module({ providers: [{ provide: DATABASE, useValue: { db: {} } }], exports: [DATABASE] })
class FakeConnectionsModule {}

let app: INestApplication;
let server: Server;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      FakeConnectionsModule,
      AuthModule.forRoot({ baseUrl: ORIGIN, secret: 'x'.repeat(32) }),
      ExportModule,
    ],
  })
    .overrideProvider(AuthService)
    .useValue(new FakeAuth())
    .overrideProvider(TenancyService)
    .useValue(tenancy)
    .overrideProvider(ExportService)
    .useValue(exports)
    .overrideProvider(RateLimiter)
    .useValue(limiter)
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
  role = 'owner';
  overLimit = false;
});

const download = () => request(server).get('/v1/tenant/export').set('cookie', 'signed-in');

describe('/v1/tenant/export (AC-W1-37)', () => {
  it('gives the owner the ZIP as an attachment that is never cached', async () => {
    const response = await download().expect(200);
    expect(response.headers).toMatchObject({
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="pepper-export-fade-2099-03-10.zip"',
      'content-length': '4',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    expect(exports.export).toHaveBeenCalledWith({ tenantId: TENANT, userId: USER, role: 'owner' });
    expect(limiter.hit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'business-export' }),
      `${TENANT}:${USER}`,
    );
  });

  it.each<MembershipRole>(['manager', 'staff'])(
    '403 for a %s, before the limit or the read',
    async (r) => {
      role = r;
      const response = await download().expect(403);
      expect(ApiErrorSchema.parse(response.body).code).toBe('forbidden');
      expect(limiter.hit).not.toHaveBeenCalled();
      expect(exports.export).not.toHaveBeenCalled();
    },
  );

  it('401 signed out; 429 past the limit, without reading', async () => {
    await request(server).get('/v1/tenant/export').expect(401);
    overLimit = true;
    const response = await download().expect(429);
    expect(ApiErrorSchema.parse(response.body).code).toBe('too_many_requests');
    expect(exports.export).not.toHaveBeenCalled();
  });
});

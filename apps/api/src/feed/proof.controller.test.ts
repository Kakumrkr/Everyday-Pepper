import 'reflect-metadata';
import type { IncomingHttpHeaders, Server } from 'node:http';
import {
  ApiErrorSchema,
  TenantIdSchema,
  UserIdSchema,
  type MembershipRole,
  type ProofResponse,
} from '@pepper/contracts';
import { ForbiddenError } from '@pepper/core';
import { DATABASE } from '@pepper/runtime';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenancyService } from '../account/tenancy.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { FeedModule } from './feed.module.js';
import { ProofService } from './proof.controller.js';

// `/v1/proof` (S55, ADR-0058; AC-W4-13): the answer parsed on the way out, staff refused.

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const PROOF: ProofResponse = {
  week: {
    from: '2026-10-29T15:00:00.000Z' as never,
    to: '2026-11-05T15:00:00.000Z' as never,
    visitsBooked: 9,
    gapsFilled: 2,
    regularsBack: 3,
    regularsBackCents: 16_500,
    valueCents: 54_000,
    minutesSaved: 125,
  },
  evening: {
    day: '2026-11-06',
    visitCount: 7,
    firstStartsAt: '2026-11-06T14:00:00.000Z' as never,
    atRiskCount: 1,
    atRisk: [
      {
        bookingId: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708190' as never,
        clientName: 'Sam Diaz',
        startsAt: '2026-11-06T16:00:00.000Z' as never,
        noShowCount: 2,
      },
    ],
  },
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
const proof = { get: vi.fn(() => Promise.resolve(PROOF)) };

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
      FeedModule,
    ],
  })
    .overrideProvider(AuthService)
    .useValue(new FakeAuth())
    .overrideProvider(TenancyService)
    .useValue(tenancy)
    .overrideProvider(ProofService)
    .useValue(proof)
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
});

const get = () => request(server).get('/v1/proof').set('cookie', 'signed-in');

describe('/v1/proof', () => {
  it.each<MembershipRole>(['owner', 'manager'])(
    'a(n) %s reads the week and the wrap',
    async (r) => {
      role = r;
      expect((await get().expect(200)).body).toEqual(PROOF);
      expect(proof.get).toHaveBeenCalledWith({ tenantId: TENANT, userId: USER, role: r });
    },
  );

  it('answers 403 for staff, from the domain', async () => {
    role = 'staff';
    proof.get.mockRejectedValueOnce(new ForbiddenError('bookings.manage'));
    expect(ApiErrorSchema.parse((await get().expect(403)).body).code).toBe('forbidden');
  });

  it('needs a session', async () => {
    await request(server).get('/v1/proof').expect(401);
    expect(proof.get).not.toHaveBeenCalled();
  });

  it('lets nothing outside the contract leave', async () => {
    proof.get.mockResolvedValueOnce({
      ...PROOF,
      week: { ...PROOF.week, clientEmails: ['ana@example.test'] },
    } as never);
    const body = (await get().expect(200)).body as ProofResponse;
    expect(body.week).not.toHaveProperty('clientEmails');
  });
});

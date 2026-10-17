import 'reflect-metadata';
import type { IncomingHttpHeaders, Server } from 'node:http';
import {
  ApiErrorSchema,
  TenantIdSchema,
  UserIdSchema,
  UtcDateTimeSchema,
  type AuditLogResponse,
  type Member,
  type MembershipRole,
  type TenantId,
} from '@floty/contracts';
import { ForbiddenError, LastOwnerError, MemberNotFoundError } from '@floty/core';
import { DATABASE } from '@floty/runtime';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenancyService } from '../account/tenancy.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { TeamModule } from './team.module.js';
import { TeamService } from './team.service.js';

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const JESS = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708194');
const MEMBER: Member = {
  userId: JESS,
  name: 'Jess',
  email: 'jess@example.test',
  role: 'manager',
  joinedAt: UtcDateTimeSchema.parse('2026-10-17T12:00:00.000Z'),
};
const AUDIT: AuditLogResponse = { entries: [], nextBefore: null };

class FakeAuth extends AuthService {
  session: AuthSession = {
    id: 'session-1',
    user: { id: USER, name: 'Ana', email: 'ana@example.test', twoFactorEnabled: true },
    activeTenantId: TENANT,
  };
  readonly setActiveTenant = vi.fn<(s: AuthSession, t: TenantId | null) => Promise<void>>(() =>
    Promise.resolve(),
  );
  handle = vi.fn(() => Promise.resolve());
  getSession(headers: IncomingHttpHeaders): Promise<AuthSession | null> {
    return Promise.resolve(headers.cookie === 'signed-in' ? this.session : null);
  }
}

let role: MembershipRole = 'owner';
const tenancy = { roleIn: vi.fn(() => Promise.resolve(role)) };
const team = {
  members: vi.fn(() => Promise.resolve([MEMBER])),
  changeRole: vi.fn((): Promise<Member> => Promise.resolve(MEMBER)),
  remove: vi.fn((): Promise<void> => Promise.resolve()),
  auditLog: vi.fn(() => Promise.resolve(AUDIT)),
};

@Global()
@Module({ providers: [{ provide: DATABASE, useValue: { db: {} } }], exports: [DATABASE] })
class FakeConnectionsModule {}

let app: INestApplication;
let server: Server;
const auth = new FakeAuth();

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      FakeConnectionsModule,
      AuthModule.forRoot({ baseUrl: ORIGIN, secret: 'x'.repeat(32) }),
      TeamModule,
    ],
  })
    .overrideProvider(AuthService)
    .useValue(auth)
    .overrideProvider(TenancyService)
    .useValue(tenancy)
    .overrideProvider(TeamService)
    .useValue(team)
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
  auth.session = { ...auth.session, user: { ...auth.session.user, twoFactorEnabled: true } };
});

const context = () => ({ tenantId: TENANT, userId: USER, role });
const get = (path: string) => request(server).get(path).set('cookie', 'signed-in');
const patch = (path: string, body: object) =>
  request(server).patch(path).set('cookie', 'signed-in').set('origin', ORIGIN).send(body);
const del = (path: string) =>
  request(server).delete(path).set('cookie', 'signed-in').set('origin', ORIGIN);

function code(body: unknown): string {
  return ApiErrorSchema.parse(body).code;
}

describe('GET /v1/members', () => {
  it.each<MembershipRole>(['owner', 'manager'])('lists the team for a(n) %s', async (r) => {
    role = r;
    const response = await get('/v1/members').expect(200);
    expect(response.body).toEqual({ members: [MEMBER] });
    expect(team.members).toHaveBeenCalledWith(context());
  });

  it('403 forbidden for staff, before the service is asked', async () => {
    role = 'staff';
    expect(code((await get('/v1/members').expect(403)).body)).toBe('forbidden');
    expect(team.members).not.toHaveBeenCalled();
  });

  it('403 mfa_required for a manager without a second factor', async () => {
    role = 'manager';
    auth.session = { ...auth.session, user: { ...auth.session.user, twoFactorEnabled: false } };
    expect(code((await get('/v1/members').expect(403)).body)).toBe('mfa_required');
  });

  it('401 signed out', async () => {
    await request(server).get('/v1/members').expect(401);
  });
});

describe('PATCH /v1/members/:userId', () => {
  it('changes the role', async () => {
    const response = await patch(`/v1/members/${JESS}`, { role: 'manager' }).expect(200);
    expect(response.body).toEqual(MEMBER);
    expect(team.changeRole).toHaveBeenCalledWith(context(), JESS, 'manager');
  });

  it.each([
    ['a malformed user id', '/v1/members/not-a-uuid', { role: 'staff' }, 'userId'],
    ['an unknown role', `/v1/members/${JESS}`, { role: 'admin' }, 'role'],
    ['a smuggled tenant', `/v1/members/${JESS}`, { role: 'staff', tenantId: TENANT }, '(body)'],
  ])('400 for %s', async (_label, path, body, field) => {
    const response = await patch(path, body).expect(400);
    expect(response.body).toMatchObject({ code: 'validation_failed', fields: [field] });
    expect(team.changeRole).not.toHaveBeenCalled();
  });

  it('403 forbidden for staff (route guard)', async () => {
    role = 'staff';
    expect(code((await patch(`/v1/members/${JESS}`, { role: 'staff' }).expect(403)).body)).toBe(
      'forbidden',
    );
    expect(team.changeRole).not.toHaveBeenCalled();
  });

  it.each([
    [new ForbiddenError('members.manage'), 403, 'forbidden'],
    [new MemberNotFoundError(), 404, 'member_not_found'],
    [new LastOwnerError(), 409, 'last_owner'],
  ])('answers %s with %d %s', async (error, status, expected) => {
    team.changeRole.mockRejectedValueOnce(error);
    const response = await patch(`/v1/members/${JESS}`, { role: 'staff' }).expect(status);
    expect(code(response.body)).toBe(expected);
  });

  it('403 forbidden_origin without the app origin (CSRF)', async () => {
    await request(server)
      .patch(`/v1/members/${JESS}`)
      .set('cookie', 'signed-in')
      .send({ role: 'staff' })
      .expect(403);
    expect(team.changeRole).not.toHaveBeenCalled();
  });
});

describe('DELETE /v1/members/:userId', () => {
  it('removes someone else and keeps the session', async () => {
    await del(`/v1/members/${JESS}`).expect(204);
    expect(team.remove).toHaveBeenCalledWith(context(), JESS);
    expect(auth.setActiveTenant).not.toHaveBeenCalled();
  });

  it('lets staff ask (to leave); the service decides', async () => {
    role = 'staff';
    await del(`/v1/members/${USER}`).expect(204);
    expect(team.remove).toHaveBeenCalledWith(context(), USER);
    // Left the business: the session no longer works in it.
    expect(auth.setActiveTenant).toHaveBeenCalledWith(auth.session, null);
  });

  it('keeps the session when leaving fails', async () => {
    team.remove.mockRejectedValueOnce(new LastOwnerError());
    expect(code((await del(`/v1/members/${USER}`).expect(409)).body)).toBe('last_owner');
    expect(auth.setActiveTenant).not.toHaveBeenCalled();
  });

  it('400 for a malformed user id', async () => {
    await del('/v1/members/1').expect(400);
  });
});

describe('GET /v1/audit-log', () => {
  it('passes the parsed query', async () => {
    const before = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708199';
    const response = await get(`/v1/audit-log?limit=10&before=${before}`).expect(200);
    expect(response.body).toEqual(AUDIT);
    expect(team.auditLog).toHaveBeenCalledWith(context(), { limit: 10, before });
  });

  it.each(['limit=0', 'limit=abc', 'before=x', 'tenantId=x', 'limit=1&limit=2'])(
    '400 for ?%s',
    async (query) => {
      await get(`/v1/audit-log?${query}`).expect(400);
      expect(team.auditLog).not.toHaveBeenCalled();
    },
  );

  it('403 for staff', async () => {
    role = 'staff';
    await get('/v1/audit-log').expect(403);
  });
});

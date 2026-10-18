import 'reflect-metadata';
import type { IncomingHttpHeaders, Server } from 'node:http';
import {
  ApiErrorSchema,
  TenantIdSchema,
  UserIdSchema,
  UtcDateTimeSchema,
  type AcceptInviteResponse,
  type CreateInviteResponse,
  type Invite,
  type InvitePreviewResponse,
  type MembershipRole,
  type TenantId,
} from '@pepper/contracts';
import {
  AlreadyAMemberError,
  ForbiddenError,
  InviteInvalidError,
  InviteLimitReachedError,
  InviteNotFoundError,
  InviteWrongAccountError,
} from '@pepper/core';
import { DATABASE } from '@pepper/runtime';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenancyService } from '../account/tenancy.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { InvitesService } from './invites.service.js';
import { TeamModule } from './team.module.js';
import { TeamService } from './team.service.js';

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const OTHER_TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708199');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const INVITE_ID = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708196';
const TOKEN = 'q1W2e3R4t5Y6u7I8o9P0a_S-d1F2g3H4j5K6l7Z8x9C';
const INVITE: Invite = {
  id: INVITE_ID,
  email: 'jess@example.test',
  role: 'staff',
  invitedBy: USER,
  createdAt: UtcDateTimeSchema.parse('2026-10-17T12:00:00.000Z'),
  expiresAt: UtcDateTimeSchema.parse('2026-10-24T12:00:00.000Z'),
};
const PREVIEW: InvitePreviewResponse = {
  businessName: 'Juniper',
  role: 'manager',
  expiresAt: INVITE.expiresAt,
};

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

let role: MembershipRole | null = 'owner';
const tenancy = { roleIn: vi.fn(() => Promise.resolve(role)) };
const invites = {
  list: vi.fn(() => Promise.resolve([INVITE])),
  create: vi.fn((): Promise<CreateInviteResponse> =>
    Promise.resolve({ invite: INVITE, token: TOKEN }),
  ),
  revoke: vi.fn((): Promise<void> => Promise.resolve()),
  preview: vi.fn((): Promise<InvitePreviewResponse> => Promise.resolve(PREVIEW)),
  accept: vi.fn((): Promise<AcceptInviteResponse> =>
    Promise.resolve({ tenantId: OTHER_TENANT, role: 'manager' }),
  ),
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
    .useValue({})
    .overrideProvider(InvitesService)
    .useValue(invites)
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
  auth.session = {
    ...auth.session,
    activeTenantId: TENANT,
    user: { ...auth.session.user, twoFactorEnabled: true },
  };
});

const context = () => ({ tenantId: TENANT, userId: USER, role });
const invitee = { userId: USER, email: 'ana@example.test' };
const get = (path: string) => request(server).get(path).set('cookie', 'signed-in');
const post = (path: string, body: object) =>
  request(server).post(path).set('cookie', 'signed-in').set('origin', ORIGIN).send(body);
const del = (path: string) =>
  request(server).delete(path).set('cookie', 'signed-in').set('origin', ORIGIN);

function code(body: unknown): string {
  return ApiErrorSchema.parse(body).code;
}

describe('GET /v1/invites', () => {
  it.each<MembershipRole>(['owner', 'manager'])('lists open invites for a(n) %s', async (r) => {
    role = r;
    expect((await get('/v1/invites').expect(200)).body).toEqual({ invites: [INVITE] });
    expect(invites.list).toHaveBeenCalledWith(context());
  });

  it('403 forbidden for staff, before the service is asked', async () => {
    role = 'staff';
    expect(code((await get('/v1/invites').expect(403)).body)).toBe('forbidden');
    expect(invites.list).not.toHaveBeenCalled();
  });

  it('401 signed out', async () => {
    await request(server).get('/v1/invites').expect(401);
  });
});

describe('POST /v1/invites', () => {
  it('creates an invite and returns its token once', async () => {
    const response = await post('/v1/invites', { email: 'Jess@Example.test', role: 'staff' });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ invite: INVITE, token: TOKEN });
    expect(invites.create).toHaveBeenCalledWith(context(), {
      email: 'jess@example.test',
      role: 'staff',
    });
  });

  it.each([
    ['an invalid email', { email: 'jess', role: 'staff' }, 'email'],
    ['an unknown role', { email: 'jess@example.test', role: 'admin' }, 'role'],
    [
      'a smuggled tenant',
      { email: 'jess@example.test', role: 'staff', tenantId: TENANT },
      '(body)',
    ],
  ])('400 for %s', async (_label, body, field) => {
    const response = await post('/v1/invites', body).expect(400);
    expect(response.body).toMatchObject({ code: 'validation_failed', fields: [field] });
    expect(invites.create).not.toHaveBeenCalled();
  });

  it('403 forbidden for staff (route guard)', async () => {
    role = 'staff';
    const response = await post('/v1/invites', { email: 'a@example.test', role: 'staff' });
    expect([response.status, code(response.body)]).toEqual([403, 'forbidden']);
    expect(invites.create).not.toHaveBeenCalled();
  });

  it('403 mfa_required for a manager without a second factor', async () => {
    role = 'manager';
    auth.session = { ...auth.session, user: { ...auth.session.user, twoFactorEnabled: false } };
    const response = await post('/v1/invites', { email: 'a@example.test', role: 'staff' });
    expect([response.status, code(response.body)]).toEqual([403, 'mfa_required']);
  });

  it.each([
    [new ForbiddenError('members.invite'), 403, 'forbidden'],
    [new AlreadyAMemberError(), 409, 'already_a_member'],
    [new InviteLimitReachedError(20), 409, 'invite_limit_reached'],
  ])('answers %s with %d %s', async (error, status, expected) => {
    invites.create.mockRejectedValueOnce(error);
    const response = await post('/v1/invites', { email: 'a@example.test', role: 'owner' });
    expect([response.status, code(response.body)]).toEqual([status, expected]);
  });

  it('403 forbidden_origin without the app origin (CSRF)', async () => {
    await request(server)
      .post('/v1/invites')
      .set('cookie', 'signed-in')
      .send({ email: 'a@example.test', role: 'staff' })
      .expect(403);
    expect(invites.create).not.toHaveBeenCalled();
  });
});

describe('DELETE /v1/invites/:inviteId', () => {
  it('revokes the invite', async () => {
    await del(`/v1/invites/${INVITE_ID}`).expect(204);
    expect(invites.revoke).toHaveBeenCalledWith(context(), INVITE_ID);
  });

  it('400 for a malformed id; 404 invite_not_found; 403 for staff', async () => {
    await del('/v1/invites/nope').expect(400);
    invites.revoke.mockRejectedValueOnce(new InviteNotFoundError());
    expect(code((await del(`/v1/invites/${INVITE_ID}`).expect(404)).body)).toBe('invite_not_found');
    role = 'staff';
    expect(code((await del(`/v1/invites/${INVITE_ID}`).expect(403)).body)).toBe('forbidden');
    expect(invites.revoke).toHaveBeenCalledTimes(1);
  });
});

describe('POST /v1/invites/lookup and /accept (signed in, not yet a member)', () => {
  beforeEach(() => {
    // The invitee has no business yet: only a session.
    auth.session = { ...auth.session, activeTenantId: null };
    role = null;
  });

  it('looks the invite up for the signed-in user', async () => {
    const response = await post('/v1/invites/lookup', { token: TOKEN }).expect(200);
    expect(response.body).toEqual(PREVIEW);
    expect(invites.preview).toHaveBeenCalledWith(invitee, TOKEN);
  });

  it("accepts and switches the session to the invite's business", async () => {
    const response = await post('/v1/invites/accept', { token: TOKEN }).expect(200);
    expect(response.body).toEqual({ tenantId: OTHER_TENANT, role: 'manager' });
    expect(invites.accept).toHaveBeenCalledWith(invitee, TOKEN);
    expect(auth.setActiveTenant).toHaveBeenCalledWith(auth.session, OTHER_TENANT);
  });

  it.each([
    [new InviteInvalidError(), 404, 'invite_invalid'],
    [new InviteWrongAccountError(), 403, 'invite_wrong_account'],
    [new AlreadyAMemberError(), 409, 'already_a_member'],
  ])('answers %s with %d %s and keeps the session as it was', async (error, status, expected) => {
    invites.accept.mockRejectedValueOnce(error);
    invites.preview.mockRejectedValueOnce(error);
    for (const path of ['/v1/invites/accept', '/v1/invites/lookup']) {
      const response = await post(path, { token: TOKEN });
      expect([response.status, code(response.body)]).toEqual([status, expected]);
    }
    expect(auth.setActiveTenant).not.toHaveBeenCalled();
  });

  it.each([
    ['no token', {}],
    ['a malformed token', { token: 'abc' }],
    ['a smuggled tenant', { token: TOKEN, tenantId: TENANT }],
  ])('400 for %s', async (_label, body) => {
    await post('/v1/invites/accept', body).expect(400);
    await post('/v1/invites/lookup', body).expect(400);
    expect(invites.accept).not.toHaveBeenCalled();
    expect(invites.preview).not.toHaveBeenCalled();
  });

  it('401 signed out; 403 forbidden_origin without the app origin', async () => {
    await request(server)
      .post('/v1/invites/accept')
      .set('origin', ORIGIN)
      .send({ token: TOKEN })
      .expect(401);
    await request(server)
      .post('/v1/invites/accept')
      .set('cookie', 'signed-in')
      .send({ token: TOKEN })
      .expect(403);
    expect(invites.accept).not.toHaveBeenCalled();
  });
});

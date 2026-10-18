import 'reflect-metadata';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import {
  ApiErrorSchema,
  MeResponseSchema,
  PermissionSchema,
  TemplateIdSchema,
  TemplatesResponseSchema,
  TenantIdSchema,
  UserIdSchema,
  type Business,
  type MembershipRole,
  type TenantId,
} from '@floty/contracts';
import { BusinessLimitReachedError, TenantSlugTakenError } from '@floty/db';
import { DATABASE } from '@floty/runtime';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { TenancyService } from './tenancy.service.js';

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const OTHER_TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708194');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const BUSINESS: Business = {
  id: TENANT,
  name: 'Juniper Hair Studio',
  slug: 'juniper',
  timeZone: 'America/New_York',
  locale: 'en-US',
  templateId: 'beauty-salon',
};

/** Signed in as USER when the request carries `cookie: signed-in`. */
class FakeAuth extends AuthService {
  session: AuthSession = {
    id: 'session-1',
    user: { id: USER, name: 'Ana', email: 'ana@example.test', twoFactorEnabled: true },
    activeTenantId: TENANT,
  };
  readonly setActiveTenant = vi.fn<
    (session: AuthSession, tenant: TenantId | null) => Promise<void>
  >(() => Promise.resolve());
  readonly handle = vi.fn((_request: IncomingMessage, response: ServerResponse) => {
    response.end('handled by Better Auth');
    return Promise.resolve();
  });

  getSession(headers: IncomingHttpHeaders): Promise<AuthSession | null> {
    return Promise.resolve(headers.cookie === 'signed-in' ? this.session : null);
  }
}

const roles = new Map<TenantId, MembershipRole>();
const tenancy = {
  roleIn: vi.fn((tenantId: TenantId) => Promise.resolve(roles.get(tenantId) ?? null)),
  businessesOf: vi.fn(() =>
    Promise.resolve([{ tenantId: TENANT, name: BUSINESS.name, slug: 'juniper', role: 'owner' }]),
  ),
  createBusiness: vi.fn(() => Promise.resolve(BUSINESS)),
  business: vi.fn((): Promise<Business | null> => Promise.resolve(BUSINESS)),
};

// Stands in for ConnectionsModule: the fakes never touch the database.
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
    ],
  })
    .overrideProvider(AuthService)
    .useValue(auth)
    .overrideProvider(TenancyService)
    .useValue(tenancy)
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
  roles.clear();
  roles.set(TENANT, 'owner');
  auth.session = {
    ...auth.session,
    user: { ...auth.session.user, twoFactorEnabled: true },
    activeTenantId: TENANT,
  };
});

function expectError(body: unknown, code: string) {
  expect(ApiErrorSchema.parse(body).code).toBe(code);
}

describe('GET /v1/me', () => {
  it('401 without a session', async () => {
    const response = await request(server).get('/v1/me').expect(401);
    expectError(response.body, 'unauthenticated');
  });

  it('returns the user, active business and businesses', async () => {
    const response = await request(server).get('/v1/me').set('cookie', 'signed-in').expect(200);
    expect(MeResponseSchema.parse(response.body)).toEqual({
      user: auth.session.user,
      activeTenantId: TENANT,
      businesses: [{ tenantId: TENANT, name: BUSINESS.name, slug: 'juniper', role: 'owner' }],
    });
  });
});

describe('GET /v1/templates', () => {
  it('401 without a session', async () => {
    const response = await request(server).get('/v1/templates').expect(401);
    expectError(response.body, 'unauthenticated');
  });

  it('lists the eight templates for a signed-in user without a business', async () => {
    auth.session = { ...auth.session, activeTenantId: null };
    const response = await request(server)
      .get('/v1/templates')
      .set('cookie', 'signed-in')
      .expect(200);
    const { templates } = TemplatesResponseSchema.parse(response.body);
    expect(templates.map((t) => t.id)).toEqual(TemplateIdSchema.options);
    expect(templates[1]).toEqual({
      id: 'barber',
      name: 'Barbershop',
      group: 'beauty',
      terminology: {
        client: { singular: 'client', plural: 'clients' },
        staff: { singular: 'barber', plural: 'barbers' },
        service: { singular: 'service', plural: 'services' },
        booking: { singular: 'appointment', plural: 'appointments' },
      },
    });
  });
});

describe('GET /v1/tenant (tenant guard)', () => {
  const get = () => request(server).get('/v1/tenant').set('cookie', 'signed-in');

  it('returns the active business and role', async () => {
    const response = await get().expect(200);
    expect(response.body).toEqual({
      business: BUSINESS,
      role: 'owner',
      permissions: PermissionSchema.options,
    });
    expect(tenancy.roleIn).toHaveBeenCalledWith(TENANT, USER);
  });

  it('401 without a session', async () => {
    expectError((await request(server).get('/v1/tenant').expect(401)).body, 'unauthenticated');
  });

  it('403 no_active_tenant before a business is chosen', async () => {
    auth.session = { ...auth.session, activeTenantId: null };
    expectError((await get().expect(403)).body, 'no_active_tenant');
  });

  it('403 not_a_member once the membership is gone', async () => {
    roles.clear();
    expectError((await get().expect(403)).body, 'not_a_member');
  });

  it('403 mfa_required for an owner without a second factor', async () => {
    auth.session = { ...auth.session, user: { ...auth.session.user, twoFactorEnabled: false } };
    expectError((await get().expect(403)).body, 'mfa_required');
  });

  it('403 mfa_required for a manager without a second factor', async () => {
    roles.set(TENANT, 'manager');
    auth.session = { ...auth.session, user: { ...auth.session.user, twoFactorEnabled: false } };
    expectError((await get().expect(403)).body, 'mfa_required');
  });

  it('lets staff in without a second factor', async () => {
    roles.set(TENANT, 'staff');
    auth.session = { ...auth.session, user: { ...auth.session.user, twoFactorEnabled: false } };
    const body = (await get().expect(200)).body as { role: string; permissions: string[] };
    expect(body.role).toBe('staff');
    // The UI offers only what the role may do: no team or audit log for staff.
    expect(body.permissions).toContain('bookings.read');
    expect(body.permissions).not.toContain('members.read');
  });

  it('403 when the business vanished after the membership check', async () => {
    tenancy.business.mockResolvedValueOnce(null);
    expectError((await get().expect(403)).body, 'not_a_member');
  });
});

describe('PUT /v1/me/active-tenant', () => {
  const put = (body: unknown) =>
    request(server)
      .put('/v1/me/active-tenant')
      .set('cookie', 'signed-in')
      .set('origin', ORIGIN)
      .send(body as object);

  it('switches to a business the user belongs to', async () => {
    await put({ tenantId: TENANT }).expect(204);
    expect(auth.setActiveTenant).toHaveBeenCalledWith(auth.session, TENANT);
  });

  it("403 for a business the user doesn't belong to", async () => {
    expectError((await put({ tenantId: OTHER_TENANT }).expect(403)).body, 'not_a_member');
    expect(auth.setActiveTenant).not.toHaveBeenCalled();
  });

  it('400 for an invalid body, naming the field only', async () => {
    const response = await put({ tenantId: "x' OR 1=1" }).expect(400);
    expect(response.body).toMatchObject({ code: 'validation_failed', fields: ['tenantId'] });
    expect(JSON.stringify(response.body)).not.toContain('OR 1=1');
  });
});

describe('POST /v1/tenants', () => {
  const input = { name: 'Juniper Hair Studio', slug: 'juniper', timeZone: 'America/New_York' };
  const post = (body: unknown) =>
    request(server)
      .post('/v1/tenants')
      .set('cookie', 'signed-in')
      .set('origin', ORIGIN)
      .send(body as object);

  it('creates a business owned by the user and makes it active', async () => {
    const response = await post(input).expect(201);
    expect(response.body).toEqual(BUSINESS);
    expect(tenancy.createBusiness).toHaveBeenCalledWith(USER, {
      ...input,
      locale: 'en-US',
      templateId: null,
    });
    expect(auth.setActiveTenant).toHaveBeenCalledWith(auth.session, TENANT);
  });

  it('passes the chosen template on', async () => {
    await post({ ...input, templateId: 'beauty-salon' }).expect(201);
    expect(tenancy.createBusiness).toHaveBeenCalledWith(USER, {
      ...input,
      locale: 'en-US',
      templateId: 'beauty-salon',
    });
  });

  it('400 for an unknown template', async () => {
    const response = await post({ ...input, templateId: 'florist' }).expect(400);
    expect(response.body).toMatchObject({ fields: ['templateId'] });
    expect(tenancy.createBusiness).not.toHaveBeenCalled();
  });

  it('409 slug_taken for a taken slug', async () => {
    tenancy.createBusiness.mockRejectedValueOnce(new TenantSlugTakenError());
    expectError((await post(input).expect(409)).body, 'slug_taken');
  });

  it('409 business_limit_reached once the user owns the most businesses allowed', async () => {
    tenancy.createBusiness.mockRejectedValueOnce(new BusinessLimitReachedError(5));
    expectError((await post(input).expect(409)).body, 'business_limit_reached');
    expect(auth.setActiveTenant).not.toHaveBeenCalled();
  });

  it('500 for an unexpected failure, without details', async () => {
    tenancy.createBusiness.mockRejectedValueOnce(new Error('connection reset for ana@x.test'));
    const response = await post(input).expect(500);
    expect(JSON.stringify(response.body)).not.toContain('ana@x.test');
  });

  it('400 for invalid input', async () => {
    const response = await post({ ...input, slug: 'Bad Slug', timeZone: 'Mars/Base' }).expect(400);
    expect(response.body).toMatchObject({ fields: ['slug', 'timeZone'] });
  });

  it('401 without a session', async () => {
    await request(server).post('/v1/tenants').set('origin', ORIGIN).send(input).expect(401);
  });
});

describe('origin check (CSRF)', () => {
  it.each([
    ['without an Origin header', undefined],
    ['from another site', 'https://evil.example'],
    ['from a look-alike origin', 'http://localhost:3000.evil.example'],
  ])('rejects a write %s', async (_label, origin) => {
    const req = request(server).post('/v1/tenants').set('cookie', 'signed-in');
    if (origin !== undefined) void req.set('origin', origin);
    expectError((await req.send({}).expect(403)).body, 'forbidden_origin');
    expect(tenancy.createBusiness).not.toHaveBeenCalled();
  });

  it('allows reads from anywhere (they change nothing)', async () => {
    await request(server)
      .get('/v1/me')
      .set('cookie', 'signed-in')
      .set('origin', 'https://evil.example')
      .expect(200);
  });

  it("leaves Better Auth's endpoints to Better Auth", async () => {
    await request(server).post('/api/auth/sign-in/email').send({}).expect(200);
    expect(auth.handle).toHaveBeenCalledOnce();
  });
});

import 'reflect-metadata';
import type { IncomingHttpHeaders, Server } from 'node:http';
import {
  ApiErrorSchema,
  ClientIdSchema,
  TenantIdSchema,
  UserIdSchema,
  UtcDateTimeSchema,
  type Client,
  type ClientTexts,
  type MembershipRole,
} from '@pepper/contracts';
import {
  ClientHasUpcomingVisitsError,
  ClientMergeOverlapError,
  ClientNotFoundError,
} from '@pepper/core';
import { ClientEmailTakenError } from '@pepper/db';
import { DATABASE } from '@pepper/runtime';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenancyService } from '../account/tenancy.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { ClientsModule } from './clients.module.js';
import { ClientsService } from './clients.service.js';

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const CLIENT_ID = ClientIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708190');
const AT = UtcDateTimeSchema.parse('2026-10-17T12:00:00.000Z');
const CLIENT: Client = {
  id: CLIENT_ID,
  name: 'Maria Lopez',
  email: 'maria@example.test',
  phone: null,
  source: 'team',
  tags: [],
  birthday: null,
  createdAt: AT,
  updatedAt: AT,
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
const clients = {
  list: vi.fn(() => Promise.resolve({ clients: [CLIENT], nextCursor: CLIENT_ID })),
  names: vi.fn(() => Promise.resolve([{ id: CLIENT_ID, name: 'Deleted client', deleted: true }])),
  get: vi.fn((): Promise<Client> => Promise.resolve(CLIENT)),
  lookUp: vi.fn(() => Promise.resolve([CLIENT])),
  create: vi.fn((): Promise<Client> => Promise.resolve(CLIENT)),
  update: vi.fn((): Promise<Client> => Promise.resolve(CLIENT)),
  records: vi.fn(() =>
    Promise.resolve({ upcomingVisits: 0, pastVisits: 3, waitlistEntries: 0, notes: 1 }),
  ),
  merge: vi.fn((): Promise<Client> => Promise.resolve(CLIENT)),
  delete: vi.fn(() => Promise.resolve()),
  texts: vi.fn((): Promise<ClientTexts> => Promise.resolve(TEXTS)),
  stopTexts: vi.fn((): Promise<ClientTexts> => Promise.resolve(TEXTS)),
};
const OTHER_ID = ClientIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708191');
const TEXTS: ClientTexts = {
  status: 'stopped',
  textable: true,
  consent: {
    phone: '+15552345678',
    source: 'booking_page',
    wordingVersion: 'sms-consent-v1',
    words: 'Text me appointment confirmations and reminders from Juniper at this number.',
    givenAt: AT,
    stoppedAt: AT,
  },
  canStop: false,
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
      ClientsModule,
    ],
  })
    .overrideProvider(AuthService)
    .useValue(new FakeAuth())
    .overrideProvider(TenancyService)
    .useValue(tenancy)
    .overrideProvider(ClientsService)
    .useValue(clients)
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

const context = () => ({ tenantId: TENANT, userId: USER, role });
const get = (path: string) => request(server).get(path).set('cookie', 'signed-in');
const post = (body: object) =>
  request(server).post('/v1/clients').set('cookie', 'signed-in').set('origin', ORIGIN).send(body);

function code(body: unknown): string {
  return ApiErrorSchema.parse(body).code;
}

describe('/v1/clients', () => {
  it.each<MembershipRole>(['owner', 'manager', 'staff'])('a(n) %s lists and reads', async (r) => {
    role = r;
    expect((await get('/v1/clients?search=mar&limit=10').expect(200)).body).toEqual({
      clients: [CLIENT],
      nextCursor: CLIENT_ID,
    });
    expect(clients.list).toHaveBeenCalledWith(context(), { search: 'mar', limit: 10 });
    expect((await get(`/v1/clients/${CLIENT_ID}`).expect(200)).body).toEqual(CLIENT);
  });

  it('pages after a client id; 400 for a cursor that isn’t one (S50.2)', async () => {
    await get(`/v1/clients?after=${OTHER_ID}`).expect(200);
    expect(clients.list).toHaveBeenCalledWith(context(), { limit: 50, after: OTHER_ID });
    expect(code((await get('/v1/clients?after=Maria').expect(400)).body)).toBe('validation_failed');
  });

  it.each<MembershipRole>(['owner', 'staff'])(
    'a(n) %s reads the names on visits, a deleted client marked (S50.2)',
    async (r) => {
      role = r;
      const response = await get(`/v1/clients/names?ids=${CLIENT_ID},${OTHER_ID}`).expect(200);
      expect(response.body).toEqual({
        names: [{ id: CLIENT_ID, name: 'Deleted client', deleted: true }],
      });
      expect(clients.names).toHaveBeenCalledWith(context(), [CLIENT_ID, OTHER_ID]);
      await get('/v1/clients/names?ids=').expect(400);
      expect(clients.get).not.toHaveBeenCalled();
    },
  );

  it('404 client_not_found (also for a client who is not a staff member’s own)', async () => {
    role = 'staff';
    clients.get.mockRejectedValueOnce(new ClientNotFoundError());
    expect(code((await get(`/v1/clients/${CLIENT_ID}`).expect(404)).body)).toBe('client_not_found');
  });

  it.each<MembershipRole>(['owner', 'manager'])('a(n) %s adds a client (201)', async (r) => {
    role = r;
    await post({ name: 'Maria Lopez', email: 'Maria@Example.test' }).expect(201);
    expect(clients.create).toHaveBeenCalledWith(context(), {
      name: 'Maria Lopez',
      email: 'maria@example.test',
      phone: null,
    });
  });

  it('403 for staff, before the service is asked', async () => {
    role = 'staff';
    expect(code((await post({ name: 'Walk-in' }).expect(403)).body)).toBe('forbidden');
    expect(clients.create).not.toHaveBeenCalled();
  });

  it('409 client_email_taken; 400 for a malformed phone number', async () => {
    clients.create.mockRejectedValueOnce(new ClientEmailTakenError());
    expect(
      code((await post({ name: 'Maria', email: 'maria@example.test' }).expect(409)).body),
    ).toBe('client_email_taken');
    await post({ name: 'Maria', phone: '555-1234' }).expect(400);
  });

  describe('PUT /v1/clients/:id', () => {
    const put = (body: object, id: string = CLIENT_ID) =>
      request(server)
        .put(`/v1/clients/${id}`)
        .set('cookie', 'signed-in')
        .set('origin', ORIGIN)
        .send(body);

    it.each<MembershipRole>(['owner', 'manager'])('a(n) %s edits a client (200)', async (r) => {
      role = r;
      expect((await put({ name: 'Maria L.', phone: '+15551234567' }).expect(200)).body).toEqual(
        CLIENT,
      );
      expect(clients.update).toHaveBeenCalledWith(context(), CLIENT_ID, {
        name: 'Maria L.',
        email: null,
        phone: '+15551234567',
      });
    });

    it('403 for staff, before the service is asked', async () => {
      role = 'staff';
      expect(code((await put({ name: 'Maria' }).expect(403)).body)).toBe('forbidden');
      expect(clients.update).not.toHaveBeenCalled();
    });

    it('404 client_not_found, 409 client_email_taken, 400 for a bad id or body', async () => {
      clients.update.mockRejectedValueOnce(new ClientNotFoundError());
      expect(code((await put({ name: 'Maria' }).expect(404)).body)).toBe('client_not_found');
      clients.update.mockRejectedValueOnce(new ClientEmailTakenError());
      expect(code((await put({ name: 'Maria', email: 'jo@example.test' }).expect(409)).body)).toBe(
        'client_email_taken',
      );
      await put({ name: 'Maria' }, 'not-an-id').expect(400);
      await put({ name: '' }).expect(400);
      await put({ name: 'Maria', source: 'import' }).expect(400);
      expect(clients.update).toHaveBeenCalledTimes(2);
    });

    it('403 from another origin', async () => {
      await request(server)
        .put(`/v1/clients/${CLIENT_ID}`)
        .set('cookie', 'signed-in')
        .set('origin', 'https://evil.test')
        .send({ name: 'Maria' })
        .expect(403);
      expect(clients.update).not.toHaveBeenCalled();
    });
  });

  it.each<MembershipRole>(['owner', 'manager', 'staff'])(
    'a(n) %s finds clients by exact email or phone (200)',
    async (r) => {
      role = r;
      const lookUp = (body: object) =>
        request(server)
          .post('/v1/clients/lookup')
          .set('cookie', 'signed-in')
          .set('origin', ORIGIN)
          .send(body);
      expect((await lookUp({ contact: ' Maria@Example.test ' }).expect(200)).body).toEqual({
        clients: [CLIENT],
      });
      expect(clients.lookUp).toHaveBeenCalledWith(context(), { contact: 'maria@example.test' });
      expect(code((await lookUp({ contact: 'maria' }).expect(400)).body)).toBe('validation_failed');
      await lookUp({ contact: '+15551234567', search: 'x' }).expect(400);
      expect(clients.lookUp).toHaveBeenCalledTimes(1);
    },
  );

  describe('merging and deleting (S50, ADR-0051)', () => {
    const merge = (body: object, id: string = CLIENT_ID) =>
      request(server)
        .post(`/v1/clients/${id}/merge`)
        .set('cookie', 'signed-in')
        .set('origin', ORIGIN)
        .send(body);
    const remove = (id: string = CLIENT_ID) =>
      request(server).delete(`/v1/clients/${id}`).set('cookie', 'signed-in').set('origin', ORIGIN);

    it.each<MembershipRole>(['owner', 'manager'])(
      'a(n) %s reads the counts, merges (200) and deletes (204)',
      async (r) => {
        role = r;
        expect((await get(`/v1/clients/${CLIENT_ID}/records`).expect(200)).body).toEqual({
          upcomingVisits: 0,
          pastVisits: 3,
          waitlistEntries: 0,
          notes: 1,
        });
        expect((await merge({ otherClientId: OTHER_ID.toUpperCase() }).expect(200)).body).toEqual(
          CLIENT,
        );
        expect(clients.merge).toHaveBeenCalledWith(context(), CLIENT_ID, {
          otherClientId: OTHER_ID,
        });
        await remove().expect(204);
        expect(clients.delete).toHaveBeenCalledWith(context(), CLIENT_ID);
      },
    );

    it('403 for staff, before the service is asked', async () => {
      role = 'staff';
      expect(code((await get(`/v1/clients/${CLIENT_ID}/records`).expect(403)).body)).toBe(
        'forbidden',
      );
      expect(code((await merge({ otherClientId: OTHER_ID }).expect(403)).body)).toBe('forbidden');
      expect(code((await remove().expect(403)).body)).toBe('forbidden');
      expect(clients.records).not.toHaveBeenCalled();
      expect(clients.merge).not.toHaveBeenCalled();
      expect(clients.delete).not.toHaveBeenCalled();
    });

    it('409 client_merge_overlap and client_has_upcoming_visits; 404; 400 for a bad body', async () => {
      clients.merge.mockRejectedValueOnce(new ClientMergeOverlapError());
      expect(code((await merge({ otherClientId: OTHER_ID }).expect(409)).body)).toBe(
        'client_merge_overlap',
      );
      clients.delete.mockRejectedValueOnce(new ClientHasUpcomingVisitsError(2));
      expect(code((await remove().expect(409)).body)).toBe('client_has_upcoming_visits');
      clients.delete.mockRejectedValueOnce(new ClientNotFoundError());
      expect(code((await remove().expect(404)).body)).toBe('client_not_found');
      await merge({}).expect(400);
      await merge({ otherClientId: OTHER_ID, keep: 'both' }).expect(400);
      await remove('not-an-id').expect(400);
      expect(clients.merge).toHaveBeenCalledTimes(1);
    });

    it('403 from another origin', async () => {
      await request(server)
        .delete(`/v1/clients/${CLIENT_ID}`)
        .set('cookie', 'signed-in')
        .set('origin', 'https://evil.test')
        .expect(403);
      expect(clients.delete).not.toHaveBeenCalled();
    });
  });

  it('401 signed out', async () => {
    await request(server).get('/v1/clients').expect(401);
    await request(server).post('/v1/clients/lookup').set('origin', ORIGIN).expect(401);
  });
});

describe('/v1/clients/:clientId/texts (S61.2, AC-X-66, AC-X-67)', () => {
  const stop = (id: string) =>
    request(server)
      .post(`/v1/clients/${id}/texts/stop`)
      .set('cookie', 'signed-in')
      .set('origin', ORIGIN)
      .send({});

  it.each<MembershipRole>(['owner', 'manager', 'staff'])('a(n) %s reads them', async (r) => {
    role = r;
    expect((await get(`/v1/clients/${CLIENT_ID}/texts`).expect(200)).body).toEqual(TEXTS);
    expect(clients.texts).toHaveBeenCalledWith(context(), CLIENT_ID);
  });

  it.each<MembershipRole>(['owner', 'manager'])('a(n) %s stops them', async (r) => {
    role = r;
    expect((await stop(CLIENT_ID).expect(200)).body).toEqual(TEXTS);
    expect(clients.stopTexts).toHaveBeenCalledWith(context(), CLIENT_ID);
  });

  it('refuses staff stopping texts (403) before anything is asked', async () => {
    role = 'staff';
    await stop(CLIENT_ID).expect(403);
    expect(clients.stopTexts).not.toHaveBeenCalled();
  });

  it('answers 404 for a client not found and 400 for an id that isn’t one', async () => {
    clients.texts.mockRejectedValueOnce(new ClientNotFoundError());
    expect(code((await get(`/v1/clients/${CLIENT_ID}/texts`).expect(404)).body)).toBe(
      'client_not_found',
    );
    expect(code((await stop('maria').expect(400)).body)).toBe('validation_failed');
    await request(server).get(`/v1/clients/${CLIENT_ID}/texts`).expect(401);
  });
});

import 'reflect-metadata';
import type { IncomingHttpHeaders, Server } from 'node:http';
import {
  ApiErrorSchema,
  ClientIdSchema,
  MemoryEpisodeIdSchema,
  MemoryEpisodesResponseSchema,
  MemoryFactIdSchema,
  MemoryFactsShownResponseSchema,
  TenantIdSchema,
  UserIdSchema,
  UtcDateTimeSchema,
  type MemoryFact,
  type MemoryFactView,
  type MembershipRole,
} from '@pepper/contracts';
import {
  ForbiddenError,
  MemoryEpisodeNotFoundError,
  MemoryFactNotFoundError,
  MemorySubjectNotFoundError,
} from '@pepper/core';
import { DATABASE } from '@pepper/runtime';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenancyService } from '../account/tenancy.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { MemoryModule } from './memory.module.js';
import { MemoryService } from './memory.service.js';

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const CLIENT_ID = ClientIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708190');
const FACT_ID = MemoryFactIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708194');
const EPISODE_ID = MemoryEpisodeIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708195');
const AT = UtcDateTimeSchema.parse('2026-10-17T12:00:00.000Z');
const FACT: MemoryFact = {
  id: FACT_ID,
  subject: { type: 'client', id: CLIENT_ID },
  key: 'allergy',
  value: 'PPD',
  sensitive: true,
  status: 'active',
  source: 'screen',
  sourceTurnId: null,
  createdByUserId: USER,
  createdAt: AT,
  updatedAt: AT,
};
const VIEW: MemoryFactView = {
  id: FACT_ID,
  subject: { type: 'client', id: CLIENT_ID },
  subjectName: 'Maria Lopez',
  visit: null,
  key: 'allergy',
  value: 'PPD',
  sensitive: true,
  source: 'chat',
  byYou: true,
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
const memory = {
  facts: vi.fn(() => Promise.resolve([VIEW])),
  shown: vi.fn(() =>
    Promise.resolve([
      {
        state: 'known' as const,
        factId: FACT_ID,
        subjectType: 'client' as const,
        key: 'allergy',
        value: 'PPD',
        previous: null,
        sensitive: true,
      },
    ]),
  ),
  save: vi.fn(() => Promise.resolve(FACT)),
  change: vi.fn(() => Promise.resolve(FACT)),
  forget: vi.fn(() => Promise.resolve()),
  episodes: vi.fn(() =>
    Promise.resolve([
      {
        id: EPISODE_ID,
        conversationId: null,
        summary: 'Moved Maria to Friday.',
        clientIds: [],
        createdAt: AT,
      },
    ]),
  ),
  deleteEpisode: vi.fn(() => Promise.resolve()),
  settings: vi.fn(() => Promise.resolve({ paused: false })),
  changeSettings: vi.fn(() => Promise.resolve({ paused: true })),
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
      MemoryModule,
    ],
  })
    .overrideProvider(AuthService)
    .useValue(new FakeAuth())
    .overrideProvider(TenancyService)
    .useValue(tenancy)
    .overrideProvider(MemoryService)
    .useValue(memory)
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
const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body?: object) =>
  request(server)[method](path).set('cookie', 'signed-in').set('origin', ORIGIN).send(body);

function code(body: unknown): string {
  return ApiErrorSchema.parse(body).code;
}

describe('/v1/memory', () => {
  it.each<MembershipRole>(['owner', 'manager', 'staff'])(
    'a(n) %s lists facts, never cached',
    async (r) => {
      role = r;
      const response = await get(`/v1/memory/facts?clientId=${CLIENT_ID}&sensitive=true`).expect(
        200,
      );
      expect(response.body).toEqual({ facts: [VIEW] });
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(memory.facts).toHaveBeenCalledWith(context(), {
        clientId: CLIENT_ID,
        sensitive: true,
      });
    },
  );

  it('400 for an unknown filter, or a client and a visit at once', async () => {
    await get('/v1/memory/facts?subjectType=planet').expect(400);
    await get(`/v1/memory/facts?clientId=${CLIENT_ID}&bookingId=${CLIENT_ID}`).expect(400);
    await get('/v1/memory/facts?tenantId=x').expect(400);
    expect(memory.facts).not.toHaveBeenCalled();
  });

  it('refuses an answer the contracts do not allow (nothing unchecked reaches the screen)', async () => {
    memory.facts.mockResolvedValueOnce([{ ...VIEW, value: 'x'.repeat(501) }]);
    await get('/v1/memory/facts').expect(500);
  });

  it('reads the live state of the facts an answer used', async () => {
    const response = await send('post', '/v1/memory/facts/shown', { factIds: [FACT_ID] }).expect(
      200,
    );
    expect(MemoryFactsShownResponseSchema.parse(response.body).facts).toHaveLength(1);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(memory.shown).toHaveBeenCalledWith(context(), [FACT_ID]);
    await send('post', '/v1/memory/facts/shown', { factIds: [] }).expect(400);
  });

  it('adds a fact from a screen (201); a contact detail or unknown field is refused', async () => {
    const body = { subject: { type: 'client', id: CLIENT_ID }, key: 'Allergy', value: 'PPD' };
    expect((await send('post', '/v1/memory/facts', body).expect(201)).body).toEqual(FACT);
    expect(memory.save).toHaveBeenCalledWith(context(), { ...body, key: 'allergy' });
    await send('post', '/v1/memory/facts', { ...body, value: 'maria@example.test' }).expect(400);
    await send('post', '/v1/memory/facts', { ...body, source: 'chat' }).expect(400);
    memory.save.mockRejectedValueOnce(new MemorySubjectNotFoundError());
    expect(code((await send('post', '/v1/memory/facts', body).expect(404)).body)).toBe(
      'memory_subject_not_found',
    );
  });

  it('edits a fact; 403 for one the member reads but may not change; 404 when gone', async () => {
    await send('patch', `/v1/memory/facts/${FACT_ID}`, { value: 'PPD and ammonia' }).expect(200);
    expect(memory.change).toHaveBeenCalledWith(context(), FACT_ID, { value: 'PPD and ammonia' });
    await send('patch', `/v1/memory/facts/${FACT_ID}`, {}).expect(400);
    memory.change.mockRejectedValueOnce(new ForbiddenError('business.update'));
    expect(
      code((await send('patch', `/v1/memory/facts/${FACT_ID}`, { sensitive: false })).body),
    ).toBe('forbidden');
    memory.change.mockRejectedValueOnce(new MemoryFactNotFoundError());
    expect(
      code((await send('patch', `/v1/memory/facts/${FACT_ID}`, { value: 'x' }).expect(404)).body),
    ).toBe('memory_fact_not_found');
  });

  it('forgets a fact (204); 404 when gone; 403 from another origin', async () => {
    await send('delete', `/v1/memory/facts/${FACT_ID}`).expect(204);
    expect(memory.forget).toHaveBeenCalledWith(context(), FACT_ID);
    memory.forget.mockRejectedValueOnce(new MemoryFactNotFoundError());
    await send('delete', `/v1/memory/facts/${FACT_ID}`).expect(404);
    await request(server)
      .delete(`/v1/memory/facts/${FACT_ID}`)
      .set('cookie', 'signed-in')
      .set('origin', 'https://evil.test')
      .expect(403);
    expect(memory.forget).toHaveBeenCalledTimes(2);
  });

  it('lists and deletes the member’s own episodes', async () => {
    role = 'staff';
    const listed = MemoryEpisodesResponseSchema.parse((await get('/v1/memory/episodes')).body);
    expect(listed.episodes).toHaveLength(1);
    await send('delete', `/v1/memory/episodes/${EPISODE_ID}`).expect(204);
    expect(memory.deleteEpisode).toHaveBeenCalledWith(context(), EPISODE_ID);
    memory.deleteEpisode.mockRejectedValueOnce(new MemoryEpisodeNotFoundError());
    expect(code((await send('delete', `/v1/memory/episodes/${EPISODE_ID}`).expect(404)).body)).toBe(
      'memory_episode_not_found',
    );
  });

  it('everyone reads the pause switch; only owners and managers change it', async () => {
    role = 'staff';
    expect((await get('/v1/memory/settings').expect(200)).body).toEqual({ paused: false });
    expect(
      code((await send('put', '/v1/memory/settings', { paused: true }).expect(403)).body),
    ).toBe('forbidden');
    expect(memory.changeSettings).not.toHaveBeenCalled();
    role = 'owner';
    expect((await send('put', '/v1/memory/settings', { paused: true }).expect(200)).body).toEqual({
      paused: true,
    });
    expect(memory.changeSettings).toHaveBeenCalledWith(context(), { paused: true });
    await send('put', '/v1/memory/settings', { paused: 'yes' }).expect(400);
  });

  it('401 signed out', async () => {
    await request(server).get('/v1/memory/facts').expect(401);
  });
});

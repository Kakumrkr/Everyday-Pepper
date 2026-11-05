import 'reflect-metadata';
import type { IncomingHttpHeaders, Server } from 'node:http';
import {
  ApiErrorSchema,
  FeedItemIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  UserIdSchema,
  type FeedResponse,
  type MembershipRole,
} from '@pepper/contracts';
import { FeedItemNotFoundError } from '@pepper/core';
import { DATABASE } from '@pepper/runtime';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenancyService } from '../account/tenancy.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { FeedModule } from './feed.module.js';
import { FeedService } from './feed.service.js';

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const ITEM_ID = FeedItemIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708190');
const STAFF = StaffMemberIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708194');
const FEED: FeedResponse = {
  suggestions: [
    {
      id: ITEM_ID,
      status: 'suggestion',
      day: '2026-11-03',
      kind: 'schedule_gaps',
      payload: {
        gapCount: 1,
        openMinutes: 120,
        longestStartsAt: '2026-11-03T15:00:00.000Z' as never,
        longestEndsAt: '2026-11-03T17:00:00.000Z' as never,
      },
      subjects: { staffMemberId: STAFF, clientId: null, bookingId: null, serviceId: null },
      names: { staff: 'Jess', client: null, service: null },
      proposalId: null,
      expiresAt: '2026-11-03T22:00:00.000Z' as never,
      createdAt: '2026-11-02T15:00:00.000Z' as never,
      valueCents: 18000,
    },
  ],
  hasBookingHistory: true,
  briefing: null,
  settings: { suggestionsPaused: false, disabledKinds: [], morningHour: null },
  templateMorningHour: 7,
  canChangeSettings: true,
  askToTurnOff: null,
  mailingAddress: null,
  reviewUrl: null,
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
const feed = {
  get: vi.fn(() => Promise.resolve(FEED)),
  close: vi.fn(() => Promise.resolve()),
  closeMany: vi.fn(() => Promise.resolve()),
  changeSettings: vi.fn(() => Promise.resolve({ suggestionsPaused: true, disabledKinds: [] })),
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
      FeedModule,
    ],
  })
    .overrideProvider(AuthService)
    .useValue(new FakeAuth())
    .overrideProvider(TenancyService)
    .useValue(tenancy)
    .overrideProvider(FeedService)
    .useValue(feed)
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
const send = (method: 'post' | 'patch', path: string, body: object, origin = ORIGIN) =>
  request(server)[method](path).set('cookie', 'signed-in').set('origin', origin).send(body);

function code(body: unknown): string {
  return ApiErrorSchema.parse(body).code;
}

describe('/v1/feed', () => {
  it.each<MembershipRole>(['owner', 'manager', 'staff'])('a(n) %s reads the feed', async (r) => {
    role = r;
    expect((await get('/v1/feed').expect(200)).body).toEqual(FEED);
    expect(feed.get).toHaveBeenCalledWith(context());
  });

  it('needs a session', async () => {
    await request(server).get('/v1/feed').expect(401);
    expect(feed.get).not.toHaveBeenCalled();
  });

  it('never lets a payload outside its kind leave (parsed on the way out)', async () => {
    const [item] = FEED.suggestions;
    feed.get.mockResolvedValueOnce({
      ...FEED,
      suggestions: [{ ...item, payload: { ...item?.payload, clientName: 'Maria' } } as never],
    });
    await get('/v1/feed').expect(500);
  });

  it.each<MembershipRole>(['owner', 'manager', 'staff'])(
    'a(n) %s dismisses or marks done an item (204)',
    async (r) => {
      role = r;
      await send('post', `/v1/feed/${ITEM_ID}/close`, { outcome: 'dismissed' }).expect(204);
      expect(feed.close).toHaveBeenCalledWith(context(), ITEM_ID, { outcome: 'dismissed' });
      await send('post', `/v1/feed/${ITEM_ID}/close`, { outcome: 'done' }).expect(204);
    },
  );

  it('404 feed_item_not_found; 400 for a bad id or outcome; 403 from another origin', async () => {
    feed.close.mockRejectedValueOnce(new FeedItemNotFoundError());
    expect(
      code(
        (await send('post', `/v1/feed/${ITEM_ID}/close`, { outcome: 'dismissed' }).expect(404))
          .body,
      ),
    ).toBe('feed_item_not_found');
    await send('post', '/v1/feed/not-an-id/close', { outcome: 'dismissed' }).expect(400);
    await send('post', `/v1/feed/${ITEM_ID}/close`, { outcome: 'snooze' }).expect(400);
    await send(
      'post',
      `/v1/feed/${ITEM_ID}/close`,
      { outcome: 'dismissed' },
      'https://evil.test',
    ).expect(403);
    expect(feed.close).toHaveBeenCalledTimes(1);
  });

  it('closes a grouped card at once (S52); 400 for none, a repeat or a bad id; 404 when none is open', async () => {
    const body = { ids: [ITEM_ID], outcome: 'dismissed' };
    await send('post', '/v1/feed/close', body).expect(204);
    expect(feed.closeMany).toHaveBeenCalledWith(context(), body);
    await send('post', '/v1/feed/close', { ids: [], outcome: 'dismissed' }).expect(400);
    await send('post', '/v1/feed/close', { ids: [ITEM_ID, ITEM_ID], outcome: 'done' }).expect(400);
    await send('post', '/v1/feed/close', { ids: ['nope'], outcome: 'dismissed' }).expect(400);
    feed.closeMany.mockRejectedValueOnce(new FeedItemNotFoundError());
    expect(code((await send('post', '/v1/feed/close', body).expect(404)).body)).toBe(
      'feed_item_not_found',
    );
  });

  it.each<MembershipRole>(['owner', 'manager'])('a(n) %s changes the switches', async (r) => {
    role = r;
    expect(
      (await send('patch', '/v1/feed/settings', { suggestionsPaused: true }).expect(200)).body,
    ).toEqual({ suggestionsPaused: true, disabledKinds: [], morningHour: null });
    expect(feed.changeSettings).toHaveBeenCalledWith(context(), { suggestionsPaused: true });
  });

  it('403 forbidden for staff; 400 for an empty or unknown change', async () => {
    role = 'staff';
    expect(
      code(
        (await send('patch', '/v1/feed/settings', { suggestionsPaused: true }).expect(403)).body,
      ),
    ).toBe('forbidden');
    role = 'owner';
    await send('patch', '/v1/feed/settings', {}).expect(400);
    await send('patch', '/v1/feed/settings', { disabledKinds: ['daily_briefing'] }).expect(400);
    expect(feed.changeSettings).not.toHaveBeenCalled();
  });
});

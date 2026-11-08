import 'reflect-metadata';
import type { IncomingHttpHeaders, Server } from 'node:http';
import {
  ApiErrorSchema,
  TenantIdSchema,
  UserIdSchema,
  type MembershipRole,
  type SupportThread,
} from '@pepper/contracts';
import {
  SupportLimitReachedError,
  SupportNotRatableError,
  SupportThreadNotFoundError,
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
import { TooManyRequestsException } from '../http/domain-errors.js';
import { RateLimiter } from '../http/rate-limit.js';
import { SupportModule } from './support.controller.js';

// Support's api without a database (S59, PCR-010, AC-X-14…17): the routes, who may call them,
// what reaches core (the session's business and user, the browser's user agent), the error
// answers and the public form's limits. core's support.int.test.ts proves the rules.

const core = vi.hoisted(() => ({
  openSupportThread: vi.fn(),
  listSupportThreads: vi.fn(),
  countSupportUnread: vi.fn(),
  readSupportThread: vi.fn(),
  replyToSupportThread: vi.fn(),
  solveSupportThread: vi.fn(),
  rateSupportThread: vi.fn(),
  submitPublicSupportRequest: vi.fn(),
}));
vi.mock('@pepper/core', async (original) => ({ ...(await original<typeof Core>()), ...core }));

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const THREAD_ID = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708190';
const AT = '2026-11-07T15:00:00.000Z';
const THREAD = {
  id: THREAD_ID,
  reference: 'PEP-7K3Q9D',
  kind: 'question',
  status: 'waiting_on_pepper',
  preview: 'How do I import?',
  openedBy: { kind: 'you' },
  unread: false,
  screenshotCount: 0,
  createdAt: AT,
  lastMessageAt: AT,
  messages: [
    {
      id: THREAD_ID,
      author: { kind: 'you' },
      body: 'How do I import?',
      screenshots: [],
      channel: 'email',
      createdAt: AT,
    },
  ],
  replyTo: 'ana@example.test',
  seenByPepperAt: null,
  solvedBy: null,
  rating: { canRate: false, value: null },
} as unknown as SupportThread;

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

let app: INestApplication;
let server: Server;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      FakeConnectionsModule,
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
  limits.hit.mockImplementation(() => Promise.resolve());
  core.openSupportThread.mockResolvedValue({
    id: THREAD_ID,
    reference: 'PEP-7K3Q9D',
    replyTo: 'ana@example.test',
  });
  core.listSupportThreads.mockResolvedValue({ threads: [THREAD], unread: 1 });
  core.countSupportUnread.mockResolvedValue(2);
  core.readSupportThread.mockResolvedValue(THREAD);
  core.replyToSupportThread.mockResolvedValue(THREAD);
  core.solveSupportThread.mockResolvedValue({ ...THREAD, status: 'solved' });
  core.submitPublicSupportRequest.mockResolvedValue({
    id: null,
    reference: 'PEP-ABCDEF',
    replyTo: 'mo@out.test',
    sent: true,
  });
});

const context = () => ({ tenantId: TENANT, userId: USER, role });
const get = (path: string) => request(server).get(path).set('cookie', 'signed-in');
const send = (method: 'post' | 'patch' | 'put', path: string, body: object, origin = ORIGIN) =>
  request(server)[method](path).set('cookie', 'signed-in').set('origin', origin).send(body);
const code = (body: unknown) => ApiErrorSchema.parse(body).code;

describe('/v1/support', () => {
  it.each<MembershipRole>(['owner', 'manager', 'staff'])(
    'a(n) %s opens a request with the browser’s context and user agent (201)',
    async (r) => {
      role = r;
      const created = await send('post', '/v1/support/threads', {
        kind: 'problem',
        message: 'It broke',
        context: { page: '/calendar', viewport: { width: 375, height: 812 } },
      })
        .set('user-agent', 'TestBrowser/1.0')
        .expect(201);
      expect(created.body).toEqual({
        id: THREAD_ID,
        reference: 'PEP-7K3Q9D',
        replyTo: 'ana@example.test',
      });
      expect(core.openSupportThread).toHaveBeenCalledWith(
        {},
        { context: context(), requestId: undefined },
        {
          kind: 'problem',
          message: 'It broke',
          context: { page: '/calendar', viewport: { width: 375, height: 812 } },
          screenshotIds: [],
        },
        { userAgent: 'TestBrowser/1.0' },
        OPTIONS,
      );
    },
  );

  it('needs a session and the app’s origin; 400 for a bad body, a host in the page or extra fields', async () => {
    await request(server)
      .post('/v1/support/threads')
      .set('origin', ORIGIN)
      .send({ kind: 'idea', message: 'x' })
      .expect(401);
    await send(
      'post',
      '/v1/support/threads',
      { kind: 'idea', message: 'x' },
      'https://evil.test',
    ).expect(403);
    await send('post', '/v1/support/threads', { kind: 'rant', message: 'x' }).expect(400);
    await send('post', '/v1/support/threads', { kind: 'idea', message: '' }).expect(400);
    await send('post', '/v1/support/threads', {
      kind: 'idea',
      message: 'x',
      context: { page: '//evil.test/x' },
    }).expect(400);
    await send('post', '/v1/support/threads', {
      kind: 'idea',
      message: 'x',
      context: { clientName: 'Sara' },
    }).expect(400);
    await send('post', '/v1/support/threads', { kind: 'idea', message: 'x'.repeat(4001) }).expect(
      400,
    );
    expect(core.openSupportThread).not.toHaveBeenCalled();
  });

  it('answers 429 support_limit_reached over the day’s requests', async () => {
    core.openSupportThread.mockRejectedValue(new SupportLimitReachedError('threads'));
    const refused = await send('post', '/v1/support/threads', {
      kind: 'idea',
      message: 'x',
    }).expect(429);
    expect(code(refused.body)).toBe('support_limit_reached');
  });

  it('lists, counts unread, reads, replies and solves', async () => {
    // The list holds the summaries only: no messages, no reply address.
    const summary: Partial<SupportThread> = { ...THREAD };
    delete summary.messages;
    delete summary.replyTo;
    delete summary.seenByPepperAt;
    delete summary.solvedBy;
    delete summary.rating;
    expect((await get('/v1/support/threads').expect(200)).body).toEqual({
      threads: [summary],
      unread: 1,
    });
    expect((await get('/v1/support/unread').expect(200)).body).toEqual({ unread: 2 });
    expect((await get(`/v1/support/threads/${THREAD_ID}`).expect(200)).body).toEqual(THREAD);
    expect(core.readSupportThread).toHaveBeenCalledWith(
      {},
      { context: context(), requestId: undefined },
      THREAD_ID,
      OPTIONS,
    );
    await send('post', `/v1/support/threads/${THREAD_ID}/messages`, {
      message: 'Still broken',
    }).expect(201);
    expect(core.replyToSupportThread).toHaveBeenCalledWith(
      {},
      { context: context(), requestId: undefined },
      THREAD_ID,
      { message: 'Still broken', screenshotIds: [] },
      OPTIONS,
    );
    const solved = await send('patch', `/v1/support/threads/${THREAD_ID}`, {
      status: 'solved',
    }).expect(200);
    expect((solved.body as { status: string }).status).toBe('solved');
    await send('patch', `/v1/support/threads/${THREAD_ID}`, { status: 'waiting_on_pepper' }).expect(
      400,
    );
  });

  it('takes the opener’s "Did this help?" (S59.2.2, AC-X-26)', async () => {
    const rated = {
      ...THREAD,
      status: 'solved',
      solvedBy: 'member',
      rating: { canRate: true, value: 'helpful' },
    };
    core.rateSupportThread.mockResolvedValue(rated);
    const answer = await send('put', `/v1/support/threads/${THREAD_ID}/rating`, {
      rating: 'helpful',
    }).expect(200);
    expect(answer.body).toEqual(rated);
    expect(core.rateSupportThread).toHaveBeenCalledWith(
      {},
      { context: context(), requestId: undefined },
      THREAD_ID,
      { rating: 'helpful' },
      OPTIONS,
    );
    for (const body of [{ rating: 'meh' }, { rating: 'helpful', userId: USER }, {}]) {
      await send('put', `/v1/support/threads/${THREAD_ID}/rating`, body).expect(400);
    }
    core.rateSupportThread.mockRejectedValue(new SupportNotRatableError());
    const refused = await send('put', `/v1/support/threads/${THREAD_ID}/rating`, {
      rating: 'not_helpful',
    }).expect(409);
    expect(code(refused.body)).toBe('support_not_ratable');
  });

  it('answers 404 support_thread_not_found for a thread the member can’t read', async () => {
    core.readSupportThread.mockRejectedValue(new SupportThreadNotFoundError());
    const missing = await get(`/v1/support/threads/${THREAD_ID}`).expect(404);
    expect(code(missing.body)).toBe('support_thread_not_found');
  });
});

describe('/v1/public/support (AC-X-17)', () => {
  it('takes a request without a session, limited per address and per email digest', async () => {
    const created = await request(server)
      .post('/v1/public/support')
      .set('origin', ORIGIN)
      .set('x-forwarded-for', '203.0.113.9')
      .send({ email: 'Mo@Out.test', message: 'I can’t sign in', page: '/sign-in' })
      .expect(201);
    expect(created.body).toEqual({ id: null, reference: 'PEP-ABCDEF', replyTo: 'mo@out.test' });
    expect(limits.hit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'support-public-ip', max: 3, windowSeconds: 3600 }),
      '203.0.113.9',
    );
    const [, emailKey] = limits.hit.mock.calls[1] as unknown as [unknown, string];
    expect(emailKey).toMatch(/^[0-9a-f]{64}$/);
    expect(emailKey).not.toContain('mo');
  });

  it('answers 429 over the limit and 400 for a bad email, before core', async () => {
    limits.hit.mockRejectedValueOnce(new TooManyRequestsException({ code: 'too_many_requests' }));
    await request(server)
      .post('/v1/public/support')
      .set('origin', ORIGIN)
      .send({ email: 'mo@out.test', message: 'again' })
      .expect(429);
    await request(server)
      .post('/v1/public/support')
      .set('origin', ORIGIN)
      .send({ email: 'not an email', message: 'x' })
      .expect(400);
    expect(core.submitPublicSupportRequest).not.toHaveBeenCalled();
  });
});

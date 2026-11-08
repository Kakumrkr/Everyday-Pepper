import 'reflect-metadata';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { ApiErrorSchema, TenantIdSchema, UserIdSchema } from '@pepper/contracts';
import {
  OperatorAccessRefusedError,
  SavedRepliesFullError,
  HeldEmailNotFoundError,
  SavedReplyNotFoundError,
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
import { RateLimiter } from '../http/rate-limit.js';
import { SupportModule } from './support.controller.js';

// The console's api without a database (S59.2, ADR-0062, AC-X-19…21): who may call it, what
// reaches core (the session's user as the operator, never a business from the request), the
// inputs and the error answers. core's operator-support.int.test.ts proves the rules.

const core = vi.hoisted(() => ({
  isOperator: vi.fn(),
  readOperatorInbox: vi.fn(),
  readOperatorThread: vi.fn(),
  replyAsOperator: vi.fn(),
  noteOnThread: vi.fn(),
  setThreadStatusAsOperator: vi.fn(),
  readPublicRequest: vi.fn(),
  noteOnPublicRequest: vi.fn(),
  setPublicStatusAsOperator: vi.fn(),
  listSavedReplies: vi.fn(),
  addSavedReply: vi.fn(),
  editSavedReply: vi.fn(),
  removeSavedReply: vi.fn(),
  listHeldEmails: vi.fn(),
  decideHeldEmail: vi.fn(),
  resumeThreadMail: vi.fn(),
  resumePublicMail: vi.fn(),
  readInboundCounts: vi.fn(),
}));
vi.mock('@pepper/core', async (original) => ({ ...(await original<typeof Core>()), ...core }));

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const ID = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708190';
const AT = '2026-11-09T09:00:00.000Z';
const THREAD = {
  id: ID,
  reference: 'PEP-7K3Q9D',
  kind: 'problem',
  status: 'waiting_on_pepper',
  business: 'Juniper',
  openedBy: { name: 'Jess', role: 'staff' },
  context: null,
  messages: [
    {
      id: ID,
      author: { kind: 'member', name: 'Jess' },
      body: 'Help',
      screenshots: [],
      channel: 'app',
      createdAt: AT,
    },
  ],
  notes: [],
  createdAt: AT,
  lastMessageAt: AT,
  solvedBy: null,
  rating: null,
  mailStopped: null,
};
const PUBLIC = {
  id: ID,
  reference: 'PEP-ABCDEF',
  status: 'open',
  email: 'locked@out.test',
  name: null,
  body: 'Locked out',
  page: null,
  topic: null,
  notes: [],
  createdAt: AT,
  channel: 'form',
  mailStopped: null,
};
const HELD = {
  items: [
    {
      id: ID,
      reason: 'unverified_sender',
      kind: 'new_request',
      from: 'someone@else.test',
      subject: 'Locked out',
      text: 'Help',
      business: null,
      reference: null,
      heldSince: AT,
    },
  ],
};
const PERIOD = {
  outcomes: [{ status: 'held', reason: 'unverified_sender', count: 1 }],
  problems: { hardBounces: 0, softBounces: 0, complaints: 1 },
};

const REPLY = { id: ID, title: 'Calendar', body: 'Hi {first name}', updatedAt: AT };

class FakeAuth extends AuthService {
  session: AuthSession = {
    id: 'session-1',
    user: { id: USER, name: 'Olive', email: 'olive@pepper.test', twoFactorEnabled: true },
    activeTenantId: TENANT,
  };
  readonly setActiveTenant = vi.fn(() => Promise.resolve());
  handle = vi.fn(() => Promise.resolve());
  getSession(headers: IncomingHttpHeaders): Promise<AuthSession | null> {
    return Promise.resolve(headers.cookie === 'signed-in' ? this.session : null);
  }
}

const auth = new FakeAuth();
const OPTIONS = {
  outboxKey: Buffer.alloc(32, 1),
  supportEmail: 'support@pepper.test',
  baseUrl: ORIGIN,
  release: '1.5.0',
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
    .useValue(auth)
    .overrideProvider(TenancyService)
    .useValue({ roleIn: vi.fn(() => Promise.resolve('owner')) })
    .overrideProvider(RateLimiter)
    .useValue({ hit: vi.fn(() => Promise.resolve()) })
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
  auth.session.user.twoFactorEnabled = true;
  core.isOperator.mockResolvedValue(true);
  core.readOperatorInbox.mockResolvedValue({ view: 'waiting', items: [], waiting: 0, held: 2 });
  core.listHeldEmails.mockResolvedValue(HELD);
  core.decideHeldEmail.mockResolvedValue({ items: [] });
  core.resumeThreadMail.mockResolvedValue(THREAD);
  core.resumePublicMail.mockResolvedValue(PUBLIC);
  core.readInboundCounts.mockResolvedValue({ last7Days: PERIOD, last30Days: PERIOD });
  core.readOperatorThread.mockResolvedValue(THREAD);
  core.replyAsOperator.mockResolvedValue({ ...THREAD, status: 'pepper_replied' });
  core.noteOnThread.mockResolvedValue(THREAD);
  core.setThreadStatusAsOperator.mockResolvedValue({ ...THREAD, status: 'solved' });
  core.readPublicRequest.mockResolvedValue(PUBLIC);
  core.noteOnPublicRequest.mockResolvedValue(PUBLIC);
  core.setPublicStatusAsOperator.mockResolvedValue({ ...PUBLIC, status: 'answered' });
  core.listSavedReplies.mockResolvedValue({ replies: [REPLY] });
  core.addSavedReply.mockResolvedValue(REPLY);
  core.editSavedReply.mockResolvedValue(REPLY);
  core.removeSavedReply.mockResolvedValue(undefined);
});

const operator = { userId: USER };
const get = (path: string) => request(server).get(path).set('Cookie', 'signed-in');
const send = (method: 'post' | 'patch' | 'put', path: string, body: object) =>
  request(server)[method](path).set('Cookie', 'signed-in').set('Origin', ORIGIN).send(body);

describe('who may open the console (AC-X-19)', () => {
  it('401 without a session', async () => {
    const response = await request(server).get('/v1/ops/inbox');
    expect(response.status).toBe(401);
    expect(core.readOperatorInbox).not.toHaveBeenCalled();
  });

  it('403 forbidden for an account without the grant, an owner included', async () => {
    core.isOperator.mockResolvedValue(false);
    const response = await get('/v1/ops/me');
    expect(response.status).toBe(403);
    expect(ApiErrorSchema.parse(response.body).code).toBe('forbidden');
    expect(core.isOperator).toHaveBeenCalledWith({}, USER);
  });

  it('403 mfa_required for an operator without two-step verification', async () => {
    auth.session.user.twoFactorEnabled = false;
    const response = await get('/v1/ops/inbox');
    expect(response.status).toBe(403);
    expect(ApiErrorSchema.parse(response.body).code).toBe('mfa_required');
    expect(core.readOperatorInbox).not.toHaveBeenCalled();
  });

  it('opens for an operator: me names them', async () => {
    const response = await get('/v1/ops/me');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ operator: true, name: 'Olive' });
  });

  it('a write needs the app’s own origin', async () => {
    const response = await request(server)
      .post(`/v1/ops/threads/${ID}/notes`)
      .set('Cookie', 'signed-in')
      .send({ note: 'x' });
    expect(response.status).toBe(403);
    expect(core.noteOnThread).not.toHaveBeenCalled();
  });
});

describe('the routes (AC-X-20/21)', () => {
  it('the inbox takes a view, waiting by default', async () => {
    expect((await get('/v1/ops/inbox')).status).toBe(200);
    expect(core.readOperatorInbox).toHaveBeenLastCalledWith({}, operator, { view: 'waiting' });
    expect((await get('/v1/ops/inbox?view=solved')).status).toBe(200);
    expect(core.readOperatorInbox).toHaveBeenLastCalledWith({}, operator, { view: 'solved' });
    expect((await get('/v1/ops/inbox?view=everything')).status).toBe(400);
  });

  it('a thread opens, takes a reply, a note and any status', async () => {
    expect((await get(`/v1/ops/threads/${ID}`)).body).toEqual(THREAD);
    const replied = await send('post', `/v1/ops/threads/${ID}/messages`, { message: 'On it' });
    expect(replied.status).toBe(201);
    expect(core.replyAsOperator).toHaveBeenCalledWith(
      {},
      operator,
      ID,
      { message: 'On it', screenshotIds: [] },
      OPTIONS,
    );
    expect((await send('post', `/v1/ops/threads/${ID}/notes`, { note: 'SMS off' })).status).toBe(
      201,
    );
    expect(core.noteOnThread).toHaveBeenCalledWith({}, operator, ID, { note: 'SMS off' }, OPTIONS);
    const moved = await send('patch', `/v1/ops/threads/${ID}`, { status: 'solved' });
    expect((moved.body as { status: string }).status).toBe('solved');
    expect(core.setThreadStatusAsOperator).toHaveBeenCalledWith(
      {},
      operator,
      ID,
      { status: 'solved' },
      OPTIONS,
    );
  });

  it('a public request opens, takes a note and any status', async () => {
    expect((await get(`/v1/ops/requests/${ID}`)).body).toEqual(PUBLIC);
    expect(
      (await send('post', `/v1/ops/requests/${ID}/notes`, { note: 'Sent steps' })).status,
    ).toBe(201);
    const moved = await send('patch', `/v1/ops/requests/${ID}`, { status: 'answered' });
    expect((moved.body as { status: string }).status).toBe('answered');
    expect(core.setPublicStatusAsOperator).toHaveBeenCalledWith(
      {},
      operator,
      ID,
      { status: 'answered' },
      OPTIONS,
    );
  });

  it.each([
    ['post', `/v1/ops/threads/${ID}/messages`, { message: '' }],
    ['post', `/v1/ops/threads/${ID}/notes`, { note: 'x'.repeat(4001) }],
    ['patch', `/v1/ops/threads/${ID}`, { status: 'closed' }],
    ['patch', `/v1/ops/requests/${ID}`, { status: 'waiting_on_pepper' }],
    ['post', `/v1/ops/threads/${ID}/notes`, { note: 'x', tenantId: TENANT }],
  ] as const)('400 for %s %s %j', async (method, path, body) => {
    expect((await send(method, path, body)).status).toBe(400);
  });

  it('404 support_thread_not_found for a request that isn’t there', async () => {
    core.readOperatorThread.mockRejectedValue(new SupportThreadNotFoundError());
    const response = await get(`/v1/ops/threads/${ID}`);
    expect(response.status).toBe(404);
    expect(ApiErrorSchema.parse(response.body).code).toBe('support_thread_not_found');
  });

  it('403 forbidden when the grant was revoked while the request was on its way', async () => {
    core.readOperatorInbox.mockRejectedValue(new OperatorAccessRefusedError());
    const response = await get('/v1/ops/inbox');
    expect(response.status).toBe(403);
    expect(ApiErrorSchema.parse(response.body).code).toBe('forbidden');
  });
});

describe('saved replies (S59.2.2, AC-X-23)', () => {
  it('lists, adds, edits and deletes, as the session’s operator', async () => {
    expect((await get('/v1/ops/replies')).body).toEqual({ replies: [REPLY] });
    expect(core.listSavedReplies).toHaveBeenCalledWith({}, operator);
    const input = { title: 'Calendar', body: 'Hi {first name}' };
    expect((await send('post', '/v1/ops/replies', input)).status).toBe(201);
    expect(core.addSavedReply).toHaveBeenCalledWith({}, operator, input, OPTIONS);
    expect((await send('put', `/v1/ops/replies/${ID}`, input)).status).toBe(200);
    expect(core.editSavedReply).toHaveBeenCalledWith({}, operator, ID, input);
    const removed = await request(server)
      .delete(`/v1/ops/replies/${ID}`)
      .set('Cookie', 'signed-in')
      .set('Origin', ORIGIN);
    expect(removed.status).toBe(204);
    expect(core.removeSavedReply).toHaveBeenCalledWith({}, operator, ID);
  });

  it('are refused to anyone but an operator', async () => {
    core.isOperator.mockResolvedValue(false);
    expect((await get('/v1/ops/replies')).status).toBe(403);
    expect(core.listSavedReplies).not.toHaveBeenCalled();
  });

  it.each([
    [{ title: '', body: 'x' }],
    [{ title: 'x'.repeat(81), body: 'x' }],
    [{ title: 'x', body: '' }],
    [{ title: 'x', body: 'y', updatedBy: USER }],
  ])('400 for %j', async (body) => {
    expect((await send('post', '/v1/ops/replies', body)).status).toBe(400);
    expect(core.addSavedReply).not.toHaveBeenCalled();
  });

  it('409 saved_replies_full and 404 saved_reply_not_found', async () => {
    core.addSavedReply.mockRejectedValue(new SavedRepliesFullError());
    const full = await send('post', '/v1/ops/replies', { title: 'x', body: 'y' });
    expect([full.status, ApiErrorSchema.parse(full.body).code]).toEqual([
      409,
      'saved_replies_full',
    ]);
    core.editSavedReply.mockRejectedValue(new SavedReplyNotFoundError());
    const missing = await send('put', `/v1/ops/replies/${ID}`, { title: 'x', body: 'y' });
    expect([missing.status, ApiErrorSchema.parse(missing.body).code]).toEqual([
      404,
      'saved_reply_not_found',
    ]);
  });
});

describe('held mail, stopped mail and counts (S59.3.2, AC-X-43…46)', () => {
  it('lists held mail, takes Accept or Discard, and gives the inbox’s held count', async () => {
    expect((await get('/v1/ops/inbox')).body).toMatchObject({ held: 2 });
    expect((await get('/v1/ops/held')).body).toEqual(HELD);
    expect(core.listHeldEmails).toHaveBeenCalledWith({}, operator);
    const accepted = await send('post', `/v1/ops/held/${ID}`, { decision: 'accept' });
    expect([accepted.status, accepted.body]).toEqual([200, { items: [] }]);
    expect(core.decideHeldEmail).toHaveBeenCalledWith(
      {},
      operator,
      ID,
      { decision: 'accept' },
      OPTIONS,
    );
  });

  it.each([[{ decision: 'land' }], [{ decision: 'accept', tenantId: TENANT }], [{}]])(
    '400 for a decision %j',
    async (body) => {
      expect((await send('post', `/v1/ops/held/${ID}`, body)).status).toBe(400);
      expect(core.decideHeldEmail).not.toHaveBeenCalled();
    },
  );

  it('404 held_email_not_found once reviewed', async () => {
    core.decideHeldEmail.mockRejectedValue(new HeldEmailNotFoundError());
    const response = await send('post', `/v1/ops/held/${ID}`, { decision: 'discard' });
    expect([response.status, ApiErrorSchema.parse(response.body).code]).toEqual([
      404,
      'held_email_not_found',
    ]);
  });

  it('resumes mail on a thread and a public request, and reads the counts', async () => {
    expect((await send('post', `/v1/ops/threads/${ID}/resume-mail`, {})).status).toBe(200);
    expect(core.resumeThreadMail).toHaveBeenCalledWith({}, operator, ID, OPTIONS);
    expect((await send('post', `/v1/ops/requests/${ID}/resume-mail`, {})).status).toBe(200);
    expect(core.resumePublicMail).toHaveBeenCalledWith({}, operator, ID, OPTIONS);
    expect((await get('/v1/ops/inbound/counts')).body).toEqual({
      last7Days: PERIOD,
      last30Days: PERIOD,
    });
  });

  it('are refused to anyone but an operator, and a write needs the app’s origin', async () => {
    core.isOperator.mockResolvedValue(false);
    expect((await get('/v1/ops/held')).status).toBe(403);
    expect((await get('/v1/ops/inbound/counts')).status).toBe(403);
    core.isOperator.mockResolvedValue(true);
    const foreign = await request(server)
      .post(`/v1/ops/held/${ID}`)
      .set('Cookie', 'signed-in')
      .set('Origin', 'https://evil.test')
      .send({ decision: 'accept' });
    expect(foreign.status).toBe(403);
    expect(core.decideHeldEmail).not.toHaveBeenCalled();
  });
});

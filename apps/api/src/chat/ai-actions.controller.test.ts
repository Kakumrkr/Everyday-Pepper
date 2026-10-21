import 'reflect-metadata';
import type { IncomingHttpHeaders, Server } from 'node:http';
import {
  ApiErrorSchema,
  AutonomyActionSchema,
  TenantIdSchema,
  UserIdSchema,
  type AiActionView,
  type AiProposalView,
  type MembershipRole,
} from '@pepper/contracts';
import { ProposalNotFoundError, UndoRefusedError } from '@pepper/core';
import { DATABASE, REDIS } from '@pepper/runtime';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenancyService } from '../account/tenancy.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { RateLimiter } from '../http/rate-limit.js';
import { AiActionsService } from './ai-actions.service.js';
import { ChatModule } from './chat.module.js';
import { ChatService } from './chat.service.js';

// The AI's proposals, receipts and autonomy endpoints without a database (S26, ADR-0031): the
// session decides who asks, Approve takes the id and the shown fingerprint only, Undo a reason
// only, staff can't change the dial, refusals are stable codes, and an answer that breaks the
// contract never reaches the browser (OWASP LLM10). chat.int.test.ts proves them end to end.

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const ID = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708194';
const FP = 'b'.repeat(64);
const AT = '2026-10-21T10:00:00.000Z';

class FakeAuth extends AuthService {
  session: AuthSession = {
    id: 'session-1',
    user: { id: USER, name: 'Ana Reyes', email: 'ana@example.test', twoFactorEnabled: true },
    activeTenantId: TENANT,
  };
  readonly setActiveTenant = vi.fn(() => Promise.resolve());
  handle = vi.fn(() => Promise.resolve());
  getSession(headers: IncomingHttpHeaders): Promise<AuthSession | null> {
    return Promise.resolve(headers.cookie === 'signed-in' ? this.session : null);
  }
}

const why = {
  asked: { kind: 'none' },
  steps: [{ tool: 'add_todo' }],
  decision: { outcome: 'propose', reason: 'setting' },
  untrustedContext: false,
} as const;

const proposal = {
  id: ID,
  action: 'task.create',
  tool: 'add_todo',
  status: 'pending',
  fingerprint: FP,
  summary: 'To-do for you: "Call the supplier".',
  before: null,
  after: { title: 'Call the supplier' },
  emails: [],
  expiresAt: AT,
  createdAt: AT,
  executionId: null,
  decidedByName: null,
  forYou: true,
  canDecide: true,
  why,
} as unknown as AiProposalView;

const action = {
  id: ID,
  proposalId: null,
  action: 'task.create',
  tool: 'add_todo',
  outcome: 'execute_and_notify',
  status: 'done',
  summary: null,
  before: null,
  after: null,
  emails: [],
  createdAt: AT,
  undoUntil: AT,
  canUndo: true,
  undoneAt: null,
  undoReason: null,
  approvedByName: null,
  forYou: true,
  why,
} as unknown as AiActionView;

const autonomy = {
  askFirst: false,
  levels: Object.fromEntries(AutonomyActionSchema.options.map((a) => [a, 'ask'])),
};

let role: MembershipRole = 'staff';
const tenancy = { roleIn: vi.fn(() => Promise.resolve(role)) };
const ai = {
  proposal: vi.fn((): Promise<unknown> => Promise.resolve(proposal)),
  proposals: vi.fn(() => Promise.resolve({ proposals: [proposal] })),
  approve: vi.fn((): Promise<unknown> => Promise.resolve({ kind: 'executed', action })),
  reject: vi.fn(() => Promise.resolve({ ...proposal, status: 'rejected', canDecide: false })),
  action: vi.fn(() => Promise.resolve(action)),
  actions: vi.fn(() => Promise.resolve({ actions: [action] })),
  undo: vi.fn((): Promise<unknown> =>
    Promise.resolve({ action: { ...action, status: 'undone' }, takenBack: 1, alreadySent: 0 }),
  ),
  autonomy: vi.fn(() => Promise.resolve(autonomy)),
  changeAutonomy: vi.fn(() => Promise.resolve({ ...autonomy, askFirst: true })),
};
const chat = { status: vi.fn(() => Promise.resolve({ state: 'paused' })) };

@Global()
@Module({
  providers: [
    { provide: DATABASE, useValue: { db: {} } },
    { provide: REDIS, useValue: {} },
  ],
  exports: [DATABASE, REDIS],
})
class FakeConnectionsModule {}

let app: INestApplication;
let server: Server;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      FakeConnectionsModule,
      AuthModule.forRoot({ baseUrl: ORIGIN, secret: 'x'.repeat(32) }),
      ChatModule.forRoot({
        openai: null,
        monthlyTokens: 1_000,
        baseUrl: ORIGIN,
        outboxKey: Buffer.alloc(32),
      }),
    ],
  })
    .overrideProvider(AuthService)
    .useValue(new FakeAuth())
    .overrideProvider(TenancyService)
    .useValue(tenancy)
    .overrideProvider(ChatService)
    .useValue(chat)
    .overrideProvider(AiActionsService)
    .useValue(ai)
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
  role = 'staff';
});

const get = (path: string) => request(server).get(path).set('cookie', 'signed-in');
const send = (method: 'post' | 'put', path: string, body: object = {}) =>
  request(server)[method](path).set('cookie', 'signed-in').set('origin', ORIGIN).send(body);
const code = (body: unknown) => ApiErrorSchema.parse(body).code;
const tenant = { tenantId: TENANT, userId: USER, role: 'staff' };

describe('/v1/ai proposals', () => {
  it('reads one, and the waiting ones, as the session’s member', async () => {
    expect((await get(`/v1/ai/proposals/${ID}`).expect(200)).body).toMatchObject({ id: ID });
    expect(ai.proposal).toHaveBeenCalledWith(tenant, ID);
    expect((await get('/v1/ai/proposals').expect(200)).body).toMatchObject({
      proposals: [{ id: ID }],
    });
    await request(server).get(`/v1/ai/proposals/${ID}`).expect(401);
  });

  it('answers 400 for a bad id and 404 proposal_not_found for one the member can’t see', async () => {
    await get('/v1/ai/proposals/not-a-uuid').expect(400);
    ai.proposal.mockRejectedValueOnce(new ProposalNotFoundError());
    expect(code((await get(`/v1/ai/proposals/${ID}`).expect(404)).body)).toBe('proposal_not_found');
  });

  it('approves with the shown fingerprint only: a payload or a bad fingerprint is refused', async () => {
    const approved = await send('post', `/v1/ai/proposals/${ID}/approve`, { fingerprint: FP });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ kind: 'executed', action: { id: ID } });
    expect(ai.approve).toHaveBeenCalledWith(tenant, ID, FP);
    await send('post', `/v1/ai/proposals/${ID}/approve`, { fingerprint: FP, payload: {} }).expect(
      400,
    );
    await send('post', `/v1/ai/proposals/${ID}/approve`, { fingerprint: 'abc' }).expect(400);
    expect(ai.approve).toHaveBeenCalledTimes(1);
  });

  it('turns one down', async () => {
    const rejected = await send('post', `/v1/ai/proposals/${ID}/reject`).expect(200);
    expect(rejected.body).toMatchObject({ status: 'rejected', canDecide: false });
  });

  it('never sends an answer that breaks the contract (OWASP LLM10)', async () => {
    ai.proposal.mockResolvedValueOnce({ ...proposal, summary: 'Call Maria on 555 123 4567' });
    await get(`/v1/ai/proposals/${ID}`).expect(500);
    ai.approve.mockResolvedValueOnce({ kind: 'executed', action: { ...action, extra: '<b>' } });
    await send('post', `/v1/ai/proposals/${ID}/approve`, { fingerprint: FP }).expect(500);
  });
});

describe('/v1/ai actions', () => {
  it('lists and reads receipts', async () => {
    expect((await get('/v1/ai/actions').expect(200)).body).toMatchObject({ actions: [{ id: ID }] });
    expect((await get(`/v1/ai/actions/${ID}`).expect(200)).body).toMatchObject({ canUndo: true });
  });

  it('undoes with a reason only, and says why when the world moved on', async () => {
    const undone = await send('post', `/v1/ai/actions/${ID}/undo`, { reason: 'wrong' }).expect(200);
    expect(undone.body).toMatchObject({ action: { status: 'undone' }, takenBack: 1 });
    expect(ai.undo).toHaveBeenCalledWith(tenant, ID, 'wrong');
    await send('post', `/v1/ai/actions/${ID}/undo`, { reason: 'wrong', executionId: ID }).expect(
      400,
    );
    ai.undo.mockRejectedValueOnce(new UndoRefusedError('slot_taken'));
    const refused = await send('post', `/v1/ai/actions/${ID}/undo`, { reason: null }).expect(409);
    expect(refused.body).toMatchObject({ code: 'undo_refused', reason: 'slot_taken' });
  });
});

describe('/v1/autonomy and /v1/chat/status', () => {
  it('everyone reads the dial; staff can’t change it', async () => {
    expect((await get('/v1/autonomy').expect(200)).body).toEqual(autonomy);
    expect(code((await send('put', '/v1/autonomy', { askFirst: true }).expect(403)).body)).toBe(
      'forbidden',
    );
    expect(ai.changeAutonomy).not.toHaveBeenCalled();
  });

  it('owners change it; "just do it" for bulk messages is refused before the service', async () => {
    role = 'owner';
    const changed = await send('put', '/v1/autonomy', { askFirst: true }).expect(200);
    expect(changed.body).toMatchObject({ askFirst: true });
    await send('put', '/v1/autonomy', { levels: { 'message.bulk': 'auto' } }).expect(400);
    expect(ai.changeAutonomy).toHaveBeenCalledTimes(1);
  });

  it('says whether the AI is on', async () => {
    expect((await get('/v1/chat/status').expect(200)).body).toEqual({ state: 'paused' });
  });
});

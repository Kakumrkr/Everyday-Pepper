import 'reflect-metadata';
import type { IncomingHttpHeaders, Server } from 'node:http';
import {
  ApiErrorSchema,
  ConversationIdSchema,
  ConversationMessageIdSchema,
  ConversationTurnIdSchema,
  TenantIdSchema,
  UserIdSchema,
  type ChatEventEnvelope,
  type MembershipRole,
} from '@pepper/contracts';
import { ConversationNotFoundError } from '@pepper/core';
import { DATABASE, REDIS } from '@pepper/runtime';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenancyService } from '../account/tenancy.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { TooManyRequestsException } from '../http/domain-errors.js';
import { RateLimiter } from '../http/rate-limit.js';
import { ChatModule } from './chat.module.js';
import { sseFrame, MEMBER_TURNS } from './chat.controller.js';
import { ChatService } from './chat.service.js';

// The chat endpoints without a model or a database (ADR-0030): the session decides who chats,
// the body is validated, the limits come first, busy is 409, and events go out as SSE frames.
// The turns themselves are proven end to end in chat.int.test.ts.

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const TURN = ConversationTurnIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708194');
const CONVERSATION = ConversationIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708195');
const MESSAGE = ConversationMessageIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708196');
const CLIENT_TURN = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708197';

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

let role: MembershipRole = 'staff';
const tenancy = { roleIn: vi.fn(() => Promise.resolve(role)) };
const turnView = {
  id: TURN,
  conversationId: CONVERSATION,
  status: 'completed' as const,
  stopReason: 'answered' as const,
  untrusted: false,
  steps: 1,
  deadlineAt: new Date(),
  startedAt: new Date(),
};
const envelopes: ChatEventEnvelope[] = [
  {
    seq: 1,
    event: {
      type: 'turn.started',
      conversationId: CONVERSATION,
      turnId: TURN,
      requestMessageId: MESSAGE,
    },
  },
  {
    seq: 2,
    event: {
      type: 'message.completed',
      messageId: MESSAGE,
      text: 'Line one\nline two',
      factIds: [],
    },
  },
  { seq: 3, event: { type: 'turn.completed', reason: 'answered' } },
];
const chat = {
  start: vi.fn((): Promise<{ kind: 'started' | 'busy'; turnId: typeof TURN }> =>
    Promise.resolve({ kind: 'started', turnId: TURN }),
  ),
  turn: vi.fn(() => Promise.resolve(turnView)),
  follow: vi.fn(function* (_tenant: unknown, _turn: unknown, after: number) {
    for (const envelope of envelopes) if (envelope.seq > after) yield envelope;
  }),
  cancel: vi.fn(() => Promise.resolve()),
  conversations: vi.fn(() => Promise.resolve({ conversations: [] })),
  history: vi.fn(() => Promise.resolve({ conversationId: CONVERSATION, items: [] })),
};
const limiter = { hit: vi.fn((): Promise<void> => Promise.resolve()) };

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
    .overrideProvider(RateLimiter)
    .useValue(limiter)
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

const post = (path: string, body: object = {}) =>
  request(server).post(path).set('cookie', 'signed-in').set('origin', ORIGIN).send(body);
const code = (body: unknown) => ApiErrorSchema.parse(body).code;
const turnBody = {
  clientTurnId: CLIENT_TURN,
  conversationId: null,
  message: ' What is on today? ',
};

describe('POST /v1/chat/turns', () => {
  it.each<MembershipRole>(['owner', 'manager', 'staff'])(
    'a(n) %s starts a turn and gets its events as SSE',
    async (r) => {
      role = r;
      const response = await post('/v1/chat/turns', turnBody).expect(200);
      expect(response.headers['content-type']).toMatch(/^text\/event-stream/);
      expect(response.text).toBe(
        envelopes.map((e) => sseFrame(e.seq, e.event.type, e.event)).join(''),
      );
      expect(chat.start).toHaveBeenCalledWith(
        { tenantId: TENANT, userId: USER, role: r },
        'Ana Reyes',
        { ...turnBody, message: 'What is on today?' },
      );
      expect(limiter.hit.mock.calls.map((call) => (call as unknown[])[0])).toContainEqual(
        MEMBER_TURNS,
      );
    },
  );

  it('needs a session and a valid body, takes no business id from it, and limits before starting', async () => {
    await request(server).post('/v1/chat/turns').set('origin', ORIGIN).send(turnBody).expect(401);
    await post('/v1/chat/turns', { ...turnBody, tenantId: TENANT }).expect(400);
    await post('/v1/chat/turns', { ...turnBody, message: '' }).expect(400);
    limiter.hit.mockRejectedValueOnce(
      new TooManyRequestsException({ code: 'too_many_requests', message: 'x' }),
    );
    await post('/v1/chat/turns', turnBody).expect(429);
    expect(chat.start).not.toHaveBeenCalled();
  });

  it('409 turn_in_progress while the conversation answers another message', async () => {
    chat.start.mockResolvedValueOnce({ kind: 'busy', turnId: TURN });
    expect(code((await post('/v1/chat/turns', turnBody).expect(409)).body)).toBe(
      'turn_in_progress',
    );
  });
});

describe('resuming, stopping and reading', () => {
  it('resumes after Last-Event-ID; a bad one starts from the beginning', async () => {
    const resumed = await request(server)
      .get(`/v1/chat/turns/${TURN}/events`)
      .set('cookie', 'signed-in')
      .set('last-event-id', '1')
      .expect(200);
    expect(resumed.text).toBe(
      envelopes
        .slice(1)
        .map((e) => sseFrame(e.seq, e.event.type, e.event))
        .join(''),
    );
    await request(server)
      .get(`/v1/chat/turns/${TURN}/events`)
      .set('cookie', 'signed-in')
      .set('last-event-id', 'x')
      .expect(200);
    expect(chat.follow).toHaveBeenLastCalledWith(
      expect.anything(),
      turnView,
      0,
      expect.any(Function),
    );
  });

  it('404 for a turn or conversation that is not the member’s; 400 for a bad id', async () => {
    chat.turn.mockRejectedValueOnce(new ConversationNotFoundError());
    expect(
      code(
        (
          await request(server)
            .get(`/v1/chat/turns/${TURN}/events`)
            .set('cookie', 'signed-in')
            .expect(404)
        ).body,
      ),
    ).toBe('conversation_not_found');
    await request(server).get('/v1/chat/turns/nope/events').set('cookie', 'signed-in').expect(400);
    chat.history.mockRejectedValueOnce(new ConversationNotFoundError());
    await request(server)
      .get(`/v1/chat/conversations/${CONVERSATION}`)
      .set('cookie', 'signed-in')
      .expect(404);
  });

  it('stops a turn (202) and lists conversations and one conversation', async () => {
    await post(`/v1/chat/turns/${TURN}/cancel`).expect(202);
    expect(chat.cancel).toHaveBeenCalledWith(expect.objectContaining({ userId: USER }), TURN);
    expect(
      (await request(server).get('/v1/chat/conversations').set('cookie', 'signed-in').expect(200))
        .body,
    ).toEqual({
      conversations: [],
    });
    expect(
      (
        await request(server)
          .get(`/v1/chat/conversations/${CONVERSATION}`)
          .set('cookie', 'signed-in')
          .expect(200)
      ).body,
    ).toEqual({
      conversationId: CONVERSATION,
      items: [],
    });
  });
});

describe('sseFrame', () => {
  it('keeps the data on one line, so text with new lines cannot end the frame', () => {
    const frame = sseFrame(2, 'message.completed', { text: 'a\n\nb' });
    expect(frame).toBe('id: 2\nevent: message.completed\ndata: {"text":"a\\n\\nb"}\n\n');
    expect(frame.split('\n\n')).toHaveLength(2);
  });
});

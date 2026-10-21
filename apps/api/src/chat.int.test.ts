import 'reflect-metadata';
import type { Server } from 'node:http';
import { Writable } from 'node:stream';
import {
  ApiErrorSchema,
  ChatEventSchema,
  ChatHistoryResponseSchema,
  ConversationsResponseSchema,
  TenantIdSchema,
  UserIdSchema,
  type ChatEvent,
  type LlmRequest,
  type LlmResponse,
} from '@pepper/contracts';
import { LlmError, scriptedResponse, waitForAbort, type LlmProvider } from '@pepper/ai';
import { addMembership, newId, prepareDatabase, withTenant, type DatabaseHandle } from '@pepper/db';
import { createLogger, createServiceApp, DATABASE } from '@pepper/runtime';
import {
  postgresUrlAs,
  startPostgres,
  startRedis,
  totpCodeFromUri,
  type TestService,
} from '@pepper/testing';
import type { DynamicModule, INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from './app.module.js';
import { ChatModule } from './chat/chat.module.js';
import { LLM_PROVIDER } from './chat/chat.service.js';
import { loadApiConfig } from './config.js';

// Chat over HTTP against real Postgres, Redis and Better Auth, with the model swapped for a
// scripted one (ADR-0030): the SSE contract, resuming after Last-Event-ID, a retried request,
// a busy conversation, stopping a turn, the member rate limit under concurrent turns, own-only
// conversations, and AC-X-2: with the model failing, chat answers with its fallback and every
// other screen keeps working.
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct horse battery';

/** A model whose next answers the test decides; `fail` makes every call fail like an outage. */
class TestModel implements LlmProvider {
  readonly requests: LlmRequest[] = [];
  next: ((request: LlmRequest, signal?: AbortSignal) => Promise<LlmResponse> | LlmResponse)[] = [];
  fail = false;

  async respond(request: LlmRequest, options: { signal?: AbortSignal } = {}): Promise<LlmResponse> {
    this.requests.push(request);
    if (this.fail) throw new LlmError('unavailable', 'The provider is down');
    const step = this.next.shift();
    return step === undefined ? scriptedResponse({ text: 'Sure.' }) : step(request, options.signal);
  }

  async *stream(request: LlmRequest, options: { signal?: AbortSignal } = {}) {
    const response = await this.respond(request, options);
    if (response.text !== '') yield { type: 'text_delta' as const, delta: response.text };
    yield { type: 'done' as const, response };
  }
}

let postgres: TestService;
let redis: TestService;
let app: INestApplication;
let server: Server;
let database: DatabaseHandle;
const model = new TestModel();
let ipCounter = 0;
let emailCounter = 0;

/** The app as in production, with the chat module's model replaced by the test's. */
function withTestModel(root: DynamicModule): DynamicModule {
  return {
    ...root,
    imports: (root.imports ?? []).map((imported) => {
      const dynamic = imported as DynamicModule;
      if (dynamic.module !== ChatModule) return imported;
      return {
        ...dynamic,
        providers: (dynamic.providers ?? []).map((provider) =>
          typeof provider === 'object' && 'provide' in provider && provider.provide === LLM_PROVIDER
            ? { provide: LLM_PROVIDER, useValue: model }
            : provider,
        ),
      };
    }),
  };
}

beforeAll(async () => {
  [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
  const databaseUrl = postgresUrlAs(postgres.url, 'pepper_service', 'test-password');
  await prepareDatabase(postgres.url, databaseUrl);
  const config = loadApiConfig({
    DATABASE_URL: databaseUrl,
    REDIS_URL: redis.url,
    AUTH_SECRET: 'an-integration-test-secret-32-chars',
    OUTBOX_SECRET: 'an-integration-test-outbox-secret-32+',
    AUTH_BASE_URL: ORIGIN,
    LOG_LEVEL: 'warn',
  });
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  app = await createServiceApp(withTestModel(AppModule.forRoot(config)), config, {
    logger: createLogger(config, sink),
  });
  await app.init();
  server = app.getHttpServer() as Server;
  database = app.get<DatabaseHandle>(DATABASE);
});

afterAll(async () => {
  await app.close();
  await Promise.all([postgres.stop(), redis.stop()]);
});

function browser() {
  const agent = request.agent(server);
  ipCounter += 1;
  const ip = `198.51.100.${String(ipCounter)}`;
  const send = <T extends request.Test>(test: T): T =>
    test.set('origin', ORIGIN).set('x-forwarded-for', ip);
  return {
    get: (path: string) => send(agent.get(path)),
    post: (path: string, body: object = {}) => send(agent.post(path)).send(body),
    put: (path: string, body: object) => send(agent.put(path)).send(body),
  };
}
type Browser = ReturnType<typeof browser>;

async function signUp(name: string): Promise<{ browser: Browser; userId: string }> {
  const b = browser();
  emailCounter += 1;
  const email = `${name.split(' ')[0]?.toLowerCase() ?? 'member'}.${String(emailCounter)}@example.test`;
  const response = await b
    .post('/api/auth/sign-up/email', { name, email, password: PASSWORD })
    .expect(200);
  return { browser: b, userId: (response.body as { user: { id: string } }).user.id };
}

/** An owner with a business and a second factor, and a staff member of it. */
async function business() {
  const owner = await signUp('Ana Reyes');
  const created = await owner.browser
    .post('/v1/tenants', {
      name: 'Juniper Hair Studio',
      timeZone: 'America/New_York',
      slug: `juniper-${newId().slice(-8)}`,
    })
    .expect(201);
  const tenantId = TenantIdSchema.parse((created.body as { id: string }).id);
  const enabled = await owner.browser
    .post('/api/auth/two-factor/enable', { password: PASSWORD })
    .expect(200);
  const { totpURI } = enabled.body as { totpURI: string };
  await owner.browser
    .post('/api/auth/two-factor/verify-totp', { code: totpCodeFromUri(totpURI) })
    .expect(200);
  const staff = await signUp('Jess Moreno');
  await withTenant(database.db, tenantId, (tx) =>
    addMembership(tx, { userId: UserIdSchema.parse(staff.userId), role: 'staff' }),
  );
  await staff.browser.put('/v1/me/active-tenant', { tenantId }).expect(204);
  return { tenantId, owner: owner.browser, staff: staff.browser };
}

interface Frame {
  id: number;
  event: string;
  data: ChatEvent;
}

/** Parses an SSE body into frames, checking each against the contract. */
function frames(body: string): Frame[] {
  return body
    .split('\n\n')
    .filter((block) => block.trim() !== '' && !block.startsWith(':'))
    .map((block) => {
      const fields = Object.fromEntries(
        block
          .split('\n')
          .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]),
      );
      return {
        id: Number(fields['id']),
        event: String(fields['event']),
        data: ChatEventSchema.parse(JSON.parse(String(fields['data']))),
      };
    });
}

const sse = (test: request.Test) =>
  test.buffer(true).parse((response, callback) => {
    let text = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      text += chunk;
    });
    response.on('end', () => {
      callback(null, text);
    });
  });

function turnRequest(
  message: string,
  conversationId: string | null = null,
  clientTurnId = newId(),
) {
  return { clientTurnId, conversationId, message };
}

function errorCode(body: unknown): string {
  return ApiErrorSchema.parse(body).code;
}

describe('POST /v1/chat/turns', () => {
  it('streams typed events with increasing ids, ending with the turn', async () => {
    const { owner } = await business();
    model.next.push(
      () =>
        scriptedResponse({
          toolCalls: [{ id: 'c1', name: 'list_services_and_staff', arguments: '{}' }],
        }),
      () => scriptedResponse({ text: 'You have no services yet.' }),
    );
    const response = await sse(
      owner.post('/v1/chat/turns', turnRequest('What do we offer?')),
    ).expect(200);
    expect(response.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(response.headers['cache-control']).toContain('no-store');
    const stream = frames(response.body as string);
    expect(stream.map((frame) => frame.id)).toEqual(stream.map((_frame, index) => index + 1));
    expect(stream.every((frame) => frame.event === frame.data.type)).toBe(true);
    expect(stream.map((frame) => frame.event)).toEqual([
      'turn.started',
      'tool.started',
      'tool.finished',
      'text.delta',
      'message.completed',
      'turn.completed',
    ]);
    expect(stream[2]?.data).toMatchObject({
      type: 'tool.finished',
      tool: 'list_services_and_staff',
      status: 'answered',
    });
    // Nothing in the stream is the business's or the member's id.
    const started = stream[0]?.data;
    if (started?.type !== 'turn.started') throw new Error('no start');
    const conversations = ConversationsResponseSchema.parse(
      (await owner.get('/v1/chat/conversations').expect(200)).body,
    );
    expect(conversations.conversations.map((c) => c.id)).toContain(started.conversationId);
  });

  it('resumes after Last-Event-ID, and a retried request gets the same turn, never a second run', async () => {
    const { owner } = await business();
    const body = turnRequest('Hi there');
    const first = frames(
      (await sse(owner.post('/v1/chat/turns', body)).expect(200)).body as string,
    );
    const started = first[0]?.data;
    if (started?.type !== 'turn.started') throw new Error('no start');
    const calls = model.requests.length;
    const again = frames(
      (await sse(owner.post('/v1/chat/turns', body)).expect(200)).body as string,
    );
    expect(again).toEqual(first);
    expect(model.requests.length).toBe(calls);
    const resumed = frames(
      (
        await sse(
          owner.get(`/v1/chat/turns/${started.turnId}/events`).set('last-event-id', '2'),
        ).expect(200)
      ).body as string,
    );
    expect(resumed).toEqual(first.slice(2));
    const history = ChatHistoryResponseSchema.parse(
      (await owner.get(`/v1/chat/conversations/${started.conversationId}`).expect(200)).body,
    );
    expect(history.items.map((item) => item.kind)).toEqual(['user', 'assistant']);
  });

  it('answers busy while the conversation is still answering, and stops a turn when asked', async () => {
    const { owner, tenantId } = await business();
    model.next.push((_request, signal) => waitForAbort(signal));
    const running = sse(owner.post('/v1/chat/turns', turnRequest('Think hard about this'))).then(
      (r) => r,
    );
    const turn = await vi.waitFor(
      async () => {
        const { rows } = await withTenant(database.db, tenantId, (tx) =>
          tx.execute<{ id: string; conversation_id: string }>(
            sql`SELECT id, conversation_id FROM conversation_turns WHERE status = 'running'`,
          ),
        );
        if (rows[0] === undefined) throw new Error('not started yet');
        return rows[0];
      },
      { timeout: 10_000, interval: 50 },
    );
    const busy = await owner
      .post('/v1/chat/turns', turnRequest('And this?', turn.conversation_id))
      .expect(409);
    expect(errorCode(busy.body)).toBe('turn_in_progress');
    await owner.post(`/v1/chat/turns/${turn.id}/cancel`).expect(202);
    const stream = frames((await running).body as string);
    expect(stream.at(-1)?.data).toMatchObject({
      type: 'turn.failed',
      fallback: { reason: 'cancelled' },
    });
  });

  it('limits each member to 20 turns in 5 minutes, also when they arrive at once', async () => {
    const { staff } = await business();
    const results = await Promise.all(
      Array.from({ length: 24 }, () =>
        sse(staff.post('/v1/chat/turns', turnRequest('Hi'))).then((r) => r.status),
      ),
    );
    expect(results.filter((status) => status === 200)).toHaveLength(20);
    expect(results.filter((status) => status === 429)).toHaveLength(4);
  });

  it('keeps every conversation its member’s own, even from the owner', async () => {
    const { owner, staff } = await business();
    const stream = frames(
      (await sse(staff.post('/v1/chat/turns', turnRequest('Mine'))).expect(200)).body as string,
    );
    const started = stream[0]?.data;
    if (started?.type !== 'turn.started') throw new Error('no start');
    expect(
      errorCode(
        (await owner.get(`/v1/chat/conversations/${started.conversationId}`).expect(404)).body,
      ),
    ).toBe('conversation_not_found');
    await owner.get(`/v1/chat/turns/${started.turnId}/events`).expect(404);
    await owner.post(`/v1/chat/turns/${started.turnId}/cancel`).expect(404);
    const continued = await owner
      .post('/v1/chat/turns', turnRequest('Hijack', started.conversationId))
      .expect(404);
    expect(errorCode(continued.body)).toBe('conversation_not_found');
  });

  it('refuses an invalid body and a business id in it', async () => {
    const { owner, tenantId } = await business();
    await owner.post('/v1/chat/turns', { ...turnRequest('Hi'), tenantId }).expect(400);
    await owner.post('/v1/chat/turns', turnRequest('')).expect(400);
  });
});

describe('AC-X-2: the model is down', () => {
  it('chat answers with the fallback and a link, and every other screen keeps working', async () => {
    const { owner, staff } = await business();
    model.fail = true;
    try {
      const stream = frames(
        (await sse(owner.post('/v1/chat/turns', turnRequest('Book Maria tomorrow'))).expect(200))
          .body as string,
      );
      expect(stream.at(-1)?.data).toEqual({
        type: 'turn.failed',
        fallback: {
          reason: 'provider_unavailable',
          text: expect.stringContaining('can’t reach my AI') as string,
          link: { label: 'Calendar', href: '/calendar' },
        },
      });
      // After a few failures the breaker answers at once, without calling the model.
      for (let index = 0; index < 3; index += 1) {
        await sse(staff.post('/v1/chat/turns', turnRequest('Anything?'))).expect(200);
      }
      const calls = model.requests.length;
      const quick = frames(
        (await sse(staff.post('/v1/chat/turns', turnRequest('Still there?'))).expect(200))
          .body as string,
      );
      expect(quick.at(-1)?.data).toMatchObject({
        type: 'turn.failed',
        fallback: { reason: 'provider_unavailable' },
      });
      expect(model.requests.length).toBe(calls);

      for (const path of [
        '/v1/tenant',
        '/v1/services',
        '/v1/staff',
        '/v1/clients',
        '/v1/tasks',
        '/v1/rules',
        '/v1/members',
      ]) {
        await owner.get(path).expect(200);
      }
      const client = await owner.post('/v1/clients', { name: 'Maria Lopez' }).expect(201);
      expect((client.body as { name: string }).name).toBe('Maria Lopez');
      await owner.post('/v1/tasks', { title: 'Call Maria' }).expect(201);
      await staff.get('/v1/tasks').expect(200);
    } finally {
      model.fail = false;
    }
  });
});

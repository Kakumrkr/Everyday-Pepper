import 'reflect-metadata';
import type { Server } from 'node:http';
import { Writable } from 'node:stream';
import {
  AiActionsResponseSchema,
  AiActionViewSchema,
  AiProposalViewSchema,
  ApiErrorSchema,
  ApproveProposalResponseSchema,
  BusinessAutonomySchema,
  ChatEventSchema,
  ChatStatusSchema,
  UndoActionResponseSchema,
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
import { TurnEventLog } from './chat/turn-events.js';
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
  const userId = (response.body as { user: { id: string } }).user.id;
  // The email check is auth.int.test's subject (S44): here it is marked done, then signed in.
  await database.db.execute(sql`UPDATE users SET email_verified = true WHERE id = ${userId}`);
  await b.post('/api/auth/sign-in/email', { email, password: PASSWORD }).expect(200);
  return { browser: b, userId };
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
    // The answer may stream in several deltas (the link scrubber holds back the last word, S27).
    expect(
      stream
        .map((frame) => frame.event)
        .filter((event, index, events) => event !== 'text.delta' || events[index - 1] !== event),
    ).toEqual([
      'turn.started',
      'tool.started',
      'tool.finished',
      'text.delta',
      'message.completed',
      'turn.completed',
    ]);
    const streamed = stream.flatMap((frame) =>
      frame.data.type === 'text.delta' ? [frame.data.delta] : [],
    );
    expect(streamed.join('')).toBe('You have no services yet.');
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

describe('S26: proposals, receipts, Why, Undo and the autonomy dial over HTTP (ADR-0031)', () => {
  const todoCall =
    (title: string, due: { date: string; time: string } | null = null) =>
    () =>
      scriptedResponse({
        toolCalls: [
          {
            id: 'c1',
            name: 'add_todo',
            arguments: JSON.stringify({
              title,
              dueDate: due?.date ?? null,
              dueTime: due?.time ?? null,
              assigneeStaffMemberId: null,
            }),
          },
        ],
      });

  /** A turn in which the member asks for a to-do; returns the card the stream showed. */
  async function askForTodo(
    member: Browser,
    message: string,
    due: { date: string; time: string } | null = null,
  ) {
    model.next.push(todoCall(message, due), () => scriptedResponse({ text: 'Noted.' }));
    const stream = frames(
      (await sse(member.post('/v1/chat/turns', turnRequest(message))).expect(200)).body as string,
    );
    const finished = stream.find((frame) => frame.data.type === 'tool.finished')?.data;
    if (finished?.type !== 'tool.finished' || finished.card?.kind !== 'change') {
      throw new Error('expected a change card');
    }
    return finished.card;
  }

  it('the dial: everyone reads it, staff cannot change it, "just do it" never for bulk', async () => {
    const { owner, staff } = await business();
    const read = BusinessAutonomySchema.parse((await staff.get('/v1/autonomy').expect(200)).body);
    expect(read.askFirst).toBe(false);
    expect(errorCode((await staff.put('/v1/autonomy', { askFirst: true }).expect(403)).body)).toBe(
      'forbidden',
    );
    await owner.put('/v1/autonomy', { levels: { 'message.bulk': 'auto' } }).expect(400);
    const changed = BusinessAutonomySchema.parse(
      (await owner.put('/v1/autonomy', { askFirst: true }).expect(200)).body,
    );
    expect(changed.askFirst).toBe(true);
    expect(ChatStatusSchema.parse((await staff.get('/v1/chat/status').expect(200)).body)).toEqual({
      state: 'on',
    });
  });

  it('a staff proposal: shown with the member’s own words, approved by the lead exactly as shown, the receipt is the staff member’s too, and Undo takes it back', async () => {
    const { owner, staff } = await business();
    await owner.put('/v1/autonomy', { askFirst: true }).expect(200);
    const card = await askForTodo(staff, 'Remind me to restock the towels', {
      date: '2030-01-15',
      time: '10:00',
    });
    expect(card).toMatchObject({
      state: 'proposed',
      summary: expect.stringContaining('towels') as string,
    });
    const proposalId = String(card.proposalId);

    const mine = AiProposalViewSchema.parse(
      (await staff.get(`/v1/ai/proposals/${proposalId}`).expect(200)).body,
    );
    expect(mine).toMatchObject({
      status: 'pending',
      forYou: true,
      canDecide: true,
      fingerprint: card.fingerprint,
      why: {
        asked: { kind: 'message', text: 'Remind me to restock the towels' },
        steps: [{ tool: 'add_todo' }],
        decision: { outcome: 'propose', reason: 'ask_first' },
        // What the domain checked (S26b), as codes and flat values.
        facts: [{ kind: 'reminds', value: { date: '2030-01-15', time: '10:00' } }],
      },
    });
    // The owner sees the proposal, but never the staff member's own words (own conversations).
    const seenByOwner = AiProposalViewSchema.parse(
      (await owner.get(`/v1/ai/proposals/${proposalId}`).expect(200)).body,
    );
    expect(seenByOwner).toMatchObject({
      forYou: false,
      canDecide: true,
      why: { asked: { kind: 'not_shown' } },
    });
    // Another business: as if it did not exist.
    const other = await business();
    expect(
      errorCode((await other.owner.get(`/v1/ai/proposals/${proposalId}`).expect(404)).body),
    ).toBe('proposal_not_found');
    expect(
      errorCode(
        (
          await other.owner
            .post(`/v1/ai/proposals/${proposalId}/approve`, { fingerprint: card.fingerprint })
            .expect(404)
        ).body,
      ),
    ).toBe('proposal_not_found');
    // Only the fingerprint: a payload in the body is refused.
    await owner
      .post(`/v1/ai/proposals/${proposalId}/approve`, {
        fingerprint: card.fingerprint,
        payload: { title: 'Something else' },
      })
      .expect(400);

    // An out-of-date card: nothing runs, the fresh proposal comes back to show.
    const stale = ApproveProposalResponseSchema.parse(
      (
        await owner
          .post(`/v1/ai/proposals/${proposalId}/approve`, { fingerprint: 'f'.repeat(64) })
          .expect(200)
      ).body,
    );
    if (stale.kind !== 'stale') throw new Error('expected stale');
    expect(stale.proposal.id).not.toBe(proposalId);
    expect(
      AiProposalViewSchema.parse(
        (await staff.get(`/v1/ai/proposals/${proposalId}`).expect(200)).body,
      ).status,
    ).toBe('superseded');

    // Approving the fresh one exactly as shown runs it once, also on a double tap.
    const fresh = stale.proposal;
    const [first, second] = await Promise.all([
      owner.post(`/v1/ai/proposals/${fresh.id}/approve`, { fingerprint: fresh.fingerprint }),
      owner.post(`/v1/ai/proposals/${fresh.id}/approve`, { fingerprint: fresh.fingerprint }),
    ]);
    const approved = ApproveProposalResponseSchema.parse(first.body);
    if (approved.kind !== 'executed') throw new Error('expected an execution');
    expect(ApproveProposalResponseSchema.parse(second.body)).toMatchObject({
      kind: 'executed',
      action: { id: approved.action.id },
    });

    // The staff member sees the receipt a lead approved for them (S23 log), and may undo it.
    const receipt = AiActionViewSchema.parse(
      (await staff.get(`/v1/ai/actions/${approved.action.id}`).expect(200)).body,
    );
    expect(receipt).toMatchObject({
      status: 'done',
      forYou: true,
      canUndo: true,
      approvedByName: 'Ana',
      summary: expect.stringContaining('towels') as string,
    });
    const listed = AiActionsResponseSchema.parse(
      (await staff.get('/v1/ai/actions').expect(200)).body,
    );
    expect(listed.actions.map((a) => a.id)).toContain(approved.action.id);
    expect(
      errorCode((await other.owner.get(`/v1/ai/actions/${approved.action.id}`).expect(404)).body),
    ).toBe('action_not_found');
    await other.owner
      .post(`/v1/ai/actions/${approved.action.id}/undo`, { reason: null })
      .expect(404);

    const undone = UndoActionResponseSchema.parse(
      (
        await staff
          .post(`/v1/ai/actions/${approved.action.id}/undo`, { reason: 'changed_mind' })
          .expect(200)
      ).body,
    );
    expect(undone).toMatchObject({
      action: { status: 'undone', canUndo: false, undoReason: 'changed_mind' },
      takenBack: 0,
      alreadySent: 0,
    });
    const tasks = (await staff.get('/v1/tasks').expect(200)).body as { tasks: { title: string }[] };
    expect(tasks.tasks.map((t) => t.title)).not.toContain('Remind me to restock the towels');
  });

  it('rejecting: the member turns it down once; it can no longer be approved', async () => {
    const { owner, staff } = await business();
    await owner.put('/v1/autonomy', { askFirst: true }).expect(200);
    const card = await askForTodo(staff, 'Remind me to order foils');
    const rejected = AiProposalViewSchema.parse(
      (await staff.post(`/v1/ai/proposals/${String(card.proposalId)}/reject`).expect(200)).body,
    );
    expect(rejected).toMatchObject({ status: 'rejected', canDecide: false });
    expect(
      errorCode(
        (
          await owner
            .post(`/v1/ai/proposals/${String(card.proposalId)}/approve`, {
              fingerprint: card.fingerprint,
            })
            .expect(409)
        ).body,
      ),
    ).toBe('proposal_not_pending');
  });

  it('a staff member cannot see or decide a colleague’s proposal', async () => {
    const { tenantId, owner, staff } = await business();
    await owner.put('/v1/autonomy', { askFirst: true }).expect(200);
    const card = await askForTodo(staff, 'Remind me to sweep');
    const colleague = await signUp('Priya Shah');
    await withTenant(database.db, tenantId, (tx) =>
      addMembership(tx, { userId: UserIdSchema.parse(colleague.userId), role: 'staff' }),
    );
    await colleague.browser.put('/v1/me/active-tenant', { tenantId }).expect(204);
    await colleague.browser.get(`/v1/ai/proposals/${String(card.proposalId)}`).expect(404);
    await colleague.browser
      .post(`/v1/ai/proposals/${String(card.proposalId)}/approve`, {
        fingerprint: card.fingerprint,
      })
      .expect(404);
  });

  it('a resumed turn whose event log expired still shows its cards', async () => {
    const { owner } = await business();
    await owner.put('/v1/autonomy', { askFirst: true }).expect(200);
    model.next.push(todoCall('Call the supplier'), () => scriptedResponse({ text: 'Asked.' }));
    const stream = frames(
      (await sse(owner.post('/v1/chat/turns', turnRequest('Call the supplier'))).expect(200))
        .body as string,
    );
    const started = stream[0]?.data;
    if (started?.type !== 'turn.started') throw new Error('no start');
    // The log is gone (as after its hour): the events are rebuilt from the conversation.
    await app.get(TurnEventLog).drop(started.turnId);
    const rebuilt = frames(
      (await sse(owner.get(`/v1/chat/turns/${started.turnId}/events`)).expect(200)).body as string,
    );
    expect(rebuilt.map((frame) => frame.data.type)).toEqual([
      'turn.started',
      'tool.finished',
      'message.completed',
      'turn.completed',
    ]);
    expect(rebuilt[1]?.data).toMatchObject({
      status: 'awaiting_approval',
      card: { kind: 'change', state: 'proposed' },
    });
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

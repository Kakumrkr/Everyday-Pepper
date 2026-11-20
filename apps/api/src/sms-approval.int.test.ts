import 'reflect-metadata';
import type { Server } from 'node:http';
import { Writable } from 'node:stream';
import { scriptedResponse, type LlmProvider } from '@pepper/ai';
import {
  ActionProposalIdSchema,
  AiActionsResponseSchema,
  AiProposalViewSchema,
  ChatEventSchema,
  MemberTextsSchema,
  SandboxInboundSmsResponseSchema,
  SandboxSentSmsResponseSchema,
  TenantIdSchema,
  UserIdSchema,
  type LlmResponse,
  type TenantId,
} from '@pepper/contracts';
import {
  deliverOutboxMessage,
  getProposal,
  outboxKeyFrom,
  queueApprovalTexts,
  smsCodeKeyFrom,
  systemClock,
  type Mailer,
} from '@pepper/core';
import {
  listDueOutboxMessages,
  newId,
  prepareDatabase,
  withTenant,
  type DatabaseHandle,
} from '@pepper/db';
import {
  createLogger,
  createServiceApp,
  DATABASE,
  REDIS,
  SandboxSmsSender,
  SandboxTextLog,
  type Redis,
} from '@pepper/runtime';
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import { APPROVAL_REPLIES } from './sms/sms-inbound.service.js';
import { ChatModule } from './chat/chat.module.js';
import { LLM_PROVIDER } from './chat/chat.service.js';
import { loadApiConfig } from './config.js';

// Approve by text end to end through the sandbox's text path (S63, ADR-0066, AC-X-80…87): the
// whole app from its environment with `SMS_PROVIDER=sandbox`, a member checking their number
// with the code the sandbox "sent", turning "Text me cards" on, a real card waiting for an OK
// texted to them, and "Y" and its code answered as Twilio's webhook would: done once, used on a
// replay, a miss from any other number, nothing after a STOP. The model is scripted (ADR-0030).

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct horse battery';
const OUTBOX_SECRET = 'an-integration-test-outbox-secret-32+';
const outboxKey = outboxKeyFrom(OUTBOX_SECRET);

class TestModel implements LlmProvider {
  next: (() => LlmResponse)[] = [];
  respond(): Promise<LlmResponse> {
    return Promise.resolve(this.next.shift()?.() ?? scriptedResponse({ text: 'Sure.' }));
  }
  async *stream() {
    const response = await this.respond();
    if (response.text !== '') yield { type: 'text_delta' as const, delta: response.text };
    yield { type: 'done' as const, response };
  }
}

let postgres: TestService;
let redis: TestService;
let app: INestApplication;
let server: Server;
let database: DatabaseHandle;
let textLog: SandboxTextLog;
const model = new TestModel();
let counter = 0;

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

/**
 * A zone where it is now between 9:00 and 16:00, so a card's text goes now and not in the
 * morning (texts wait for the business's hours, AC-X-82): the six cover every UTC hour.
 */
function daytimeZone(): string {
  const zones = [
    'America/New_York',
    'Europe/London',
    'Asia/Kolkata',
    'Asia/Tokyo',
    'Australia/Sydney',
    'Pacific/Honolulu',
  ];
  const hourIn = (timeZone: string) =>
    Number(
      new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(
        new Date(),
      ),
    );
  const zone = zones.find((candidate) => hourIn(candidate) >= 9 && hourIn(candidate) < 16);
  if (zone === undefined) throw new Error('No zone in its daytime');
  return zone;
}

beforeAll(async () => {
  [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
  const databaseUrl = postgresUrlAs(postgres.url, 'pepper_service', 'test-password');
  await prepareDatabase(postgres.url, databaseUrl);
  const config = loadApiConfig({
    DATABASE_URL: databaseUrl,
    REDIS_URL: redis.url,
    AUTH_SECRET: 'an-integration-test-secret-32-chars',
    OUTBOX_SECRET,
    AUTH_BASE_URL: ORIGIN,
    LOG_LEVEL: 'warn',
    SMS_PROVIDER: 'sandbox',
  });
  expect(config.smsSandbox).toBe(true);
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
  textLog = new SandboxTextLog(app.get<Redis>(REDIS));
});

afterAll(async () => {
  await app.close();
  await Promise.all([postgres.stop(), redis.stop()]);
});

function browser() {
  const agent = request.agent(server);
  counter += 1;
  const ip = `198.51.100.${String(counter)}`;
  const send = <T extends request.Test>(test: T): T =>
    test.set('origin', ORIGIN).set('x-forwarded-for', ip);
  return {
    get: (path: string) => send(agent.get(path)),
    post: (path: string, body: object = {}) => send(agent.post(path)).send(body),
    put: (path: string, body: object) => send(agent.put(path)).send(body),
    patch: (path: string, body: object) => send(agent.patch(path)).send(body),
  };
}
type Browser = ReturnType<typeof browser>;

function newPhone(): string {
  counter += 1;
  return `+1555600${String(counter).padStart(4, '0')}`;
}

/** An owner with a second factor and a business in its daytime. */
async function owner(): Promise<{ browser: Browser; userId: string; tenantId: TenantId }> {
  const b = browser();
  const email = `ana.${String(counter)}@example.test`;
  const response = await b
    .post('/api/auth/sign-up/email', { name: 'Ana Reyes', email, password: PASSWORD })
    .expect(200);
  const userId = (response.body as { user: { id: string } }).user.id;
  await database.db.execute(sql`UPDATE users SET email_verified = true WHERE id = ${userId}`);
  await b.post('/api/auth/sign-in/email', { email, password: PASSWORD }).expect(200);
  const created = await b
    .post('/v1/tenants', {
      name: 'Juniper Hair Studio',
      timeZone: daytimeZone(),
      slug: `juniper-${newId().slice(-8)}`,
    })
    .expect(201);
  const enabled = await b.post('/api/auth/two-factor/enable', { password: PASSWORD }).expect(200);
  const { totpURI } = enabled.body as { totpURI: string };
  await b.post('/api/auth/two-factor/verify-totp', { code: totpCodeFromUri(totpURI) }).expect(200);
  return {
    browser: b,
    userId,
    tenantId: TenantIdSchema.parse((created.body as { id: string }).id),
  };
}

/** Sends the business's due texts through the sandbox, recording them where tests read them. */
async function deliverDue(tenantId: TenantId): Promise<void> {
  const sender = new SandboxSmsSender(() => undefined, textLog);
  const mailer: Mailer = { send: () => Promise.reject(new Error('no email here')) };
  for (const due of await listDueOutboxMessages(database.db, new Date(), 100)) {
    if (due.tenantId !== tenantId) continue;
    await deliverOutboxMessage(database.db, due, {
      key: outboxKey,
      mailer,
      sms: sender,
      smsStatusBaseUrl: ORIGIN,
      clock: systemClock,
    });
  }
}

async function lastTextTo(phone: string): Promise<string> {
  const sent = SandboxSentSmsResponseSchema.parse(
    (await request(server).get('/v1/dev/sms/sent').query({ to: phone }).expect(200)).body,
  );
  const latest = sent.texts[0];
  if (latest === undefined) throw new Error('nothing sent');
  return latest.body;
}

async function textIn(from: string, body: string): Promise<string | null> {
  const response = await request(server)
    .post('/v1/dev/sms/inbound')
    .send({ from, body })
    .expect(200);
  return SandboxInboundSmsResponseSchema.parse(response.body).reply;
}

/** The owner's number checked with the code the sandbox sent, and "Text me cards" on. */
async function textingCards(member: Awaited<ReturnType<typeof owner>>, phone: string) {
  await member.browser.post('/v1/me/phone', { phone }).expect(200);
  await deliverDue(member.tenantId);
  const code = /your code is (\d{6})\./.exec(await lastTextTo(phone))?.[1];
  if (code === undefined) throw new Error('no code in the text');
  // A wrong code first: refused, the right one still works.
  await member.browser.post('/v1/me/phone/verify', { code: '000000' }).expect(422);
  const verified = MemberTextsSchema.parse(
    (await member.browser.post('/v1/me/phone/verify', { code }).expect(200)).body,
  );
  expect(verified).toEqual({ phone, cardTexts: false, canTextCards: true });
  const on = MemberTextsSchema.parse(
    (await member.browser.patch('/v1/me/texts', { cardTexts: true }).expect(200)).body,
  );
  expect(on.cardTexts).toBe(true);
}

/** A real card waiting for the owner's OK (a to-do asked for in chat), texted to them. */
async function cardTexted(member: Awaited<ReturnType<typeof owner>>, phone: string) {
  await member.browser.put('/v1/autonomy', { askFirst: true }).expect(200);
  model.next.push(
    () =>
      scriptedResponse({
        toolCalls: [
          {
            id: 'c1',
            name: 'add_todo',
            arguments: JSON.stringify({
              title: 'Order more towels',
              dueDate: null,
              dueTime: null,
              assigneeStaffMemberId: null,
            }),
          },
        ],
      }),
    () => scriptedResponse({ text: 'Asked.' }),
  );
  const turn = await member.browser
    .post('/v1/chat/turns', {
      clientTurnId: newId(),
      conversationId: null,
      message: 'Remind me to order towels',
    })
    .buffer(true)
    .parse((response, callback) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (text += chunk));
      response.on('end', () => {
        callback(null, text);
      });
    })
    .expect(200);
  const card = (turn.body as string)
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
    .flatMap((line) =>
      line === undefined ? [] : [ChatEventSchema.parse(JSON.parse(line.slice(6)))],
    )
    .flatMap((event) =>
      event.type === 'tool.finished' && event.card?.kind === 'change' ? [event.card] : [],
    )[0];
  if (card?.proposalId === undefined || card.proposalId === null) throw new Error('no card');
  const proposalId = ActionProposalIdSchema.parse(card.proposalId);
  const actor = {
    context: {
      tenantId: member.tenantId,
      userId: UserIdSchema.parse(member.userId),
      role: 'owner' as const,
    },
  };
  const proposal = await getProposal(database.db, actor, proposalId);
  const queued = await withTenant(database.db, member.tenantId, (tx) =>
    queueApprovalTexts(tx, proposal, 'Add a to-do: order more towels?', {
      codeKey: smsCodeKeyFrom(outboxKey),
      outboxKey,
      now: new Date(),
    }),
  );
  expect(queued).toBe(1);
  await deliverDue(member.tenantId);
  const body = await lastTextTo(phone);
  expect(body).toMatch(
    /^Pepper: Add a to-do: order more towels\? Reply Y \d{4} by \d{1,2}:\d{2}(am|pm)\.$/,
  );
  const code = /Reply Y (\d{4})/.exec(body)?.[1];
  if (code === undefined) throw new Error('no code');
  return { proposalId, code, actor };
}

describe('approve by text through the sandbox (AC-X-83…87)', () => {
  it('"Y" and the code approves that card once, from that number only', async () => {
    const member = await owner();
    const phone = newPhone();
    await textingCards(member, phone);
    const { proposalId, code, actor } = await cardTexted(member, phone);

    // Another number with the right code: the one answer for any miss (AC-X-85).
    expect(await textIn(newPhone(), `Y ${code}`)).toBe(APPROVAL_REPLIES.miss);
    // A bare "Y" asks for the code (AC-X-86).
    expect(await textIn(phone, 'Y')).toBe(APPROVAL_REPLIES.withoutCode);
    expect((await getProposal(database.db, actor, proposalId)).status).toBe('pending');

    // The sandbox takes the number as typed, as the provider gives it.
    const local = `(${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}`;
    expect(await textIn(local, `y ${code}`)).toBe(APPROVAL_REPLIES.done);
    expect((await getProposal(database.db, actor, proposalId)).status).toBe('approved');
    // The same reply again (a replay, AC-X-84).
    expect(await textIn(phone, `Y ${code}`)).toBe(APPROVAL_REPLIES.used);
  });

  it('answers nothing after a STOP, and keeps "C" for visits', async () => {
    const member = await owner();
    const phone = newPhone();
    await textingCards(member, phone);
    const { proposalId, code, actor } = await cardTexted(member, phone);
    // "C" with no visit to confirm: the visit answer, never a card's.
    expect(await textIn(phone, 'C')).toMatch(/^Pepper/);
    expect(await textIn(phone, 'STOP')).toContain('Reply START to resubscribe');
    expect(await textIn(phone, `Y ${code}`)).toBeNull();
    expect((await getProposal(database.db, actor, proposalId)).status).toBe('pending');
  });

  it('stops a number’s codes after 5 misses in an hour (AC-X-85)', async () => {
    const member = await owner();
    const phone = newPhone();
    await textingCards(member, phone);
    const { proposalId, code, actor } = await cardTexted(member, phone);
    const wrong = code === '0000' ? '0001' : '0000';
    for (let i = 0; i < 5; i += 1) {
      expect(await textIn(phone, `Y ${wrong}`)).toBe(APPROVAL_REPLIES.miss);
    }
    // The right code now gets the miss answer too, and the card still waits.
    expect(await textIn(phone, `Y ${code}`)).toBe(APPROVAL_REPLIES.miss);
    expect((await getProposal(database.db, actor, proposalId)).status).toBe('pending');
  });

  /** The card's receipt in Activity, as the owner's app reads it. */
  async function receiptOf(member: Awaited<ReturnType<typeof owner>>, proposalId: string) {
    const page = AiActionsResponseSchema.parse(
      (await member.browser.get('/v1/ai/actions?limit=20').expect(200)).body,
    );
    const receipt = page.actions.find((action) => action.proposalId === proposalId);
    if (receipt === undefined) throw new Error('no receipt');
    return receipt;
  }

  it('says in Activity that a card was approved by text (AC-X-91)', async () => {
    const member = await owner();
    const phone = newPhone();
    await textingCards(member, phone);
    const { proposalId, code } = await cardTexted(member, phone);
    expect(await textIn(phone, `Y ${code}`)).toBe(APPROVAL_REPLIES.done);
    const receipt = await receiptOf(member, proposalId);
    expect(receipt.approvedVia).toBe('text');
    // Its own receipt says so too.
    const own = await member.browser.get(`/v1/ai/actions/${receipt.id}`).expect(200);
    expect((own.body as { approvedVia?: string }).approvedVia).toBe('text');
  });

  it('never says "by text" of a card approved in the app, even after its code was spent', async () => {
    const member = await owner();
    const phone = newPhone();
    await textingCards(member, phone);
    const { proposalId, code } = await cardTexted(member, phone);
    const card = AiProposalViewSchema.parse(
      (await member.browser.get(`/v1/ai/proposals/${proposalId}`).expect(200)).body,
    );
    await member.browser
      .post(`/v1/ai/proposals/${proposalId}/approve`, { fingerprint: card.fingerprint })
      .expect(200);
    // The reply spends the code but approves nothing: the card was handled in the app.
    expect(await textIn(phone, `Y ${code}`)).toBe(APPROVAL_REPLIES.handled);
    expect((await receiptOf(member, proposalId)).approvedVia).toBeUndefined();
  });
});

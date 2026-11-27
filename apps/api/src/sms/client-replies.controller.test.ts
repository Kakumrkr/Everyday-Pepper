import 'reflect-metadata';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type * as Appointments from '@pepper/appointments';
import {
  ApiErrorSchema,
  ClientIdSchema,
  TenantIdSchema,
  UserIdSchema,
  type MembershipRole,
} from '@pepper/contracts';
import { ClientNotFoundError } from '@pepper/core';
import { DATABASE } from '@pepper/runtime';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenancyService } from '../account/tenancy.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { RateLimiter } from '../http/rate-limit.js';
import { ClientRepliesModule } from './client-replies.controller.js';

// A member's reply to a client's text over HTTP, without a database (S80, AC-X-233): owners and
// managers only, the domain's refusals as their codes, and only a queued reply counts against
// the hour's limit. appointments' client-texts.int.test.ts proves what the calls do.

const appointments = vi.hoisted(() => ({
  replyToClientText: vi.fn(),
  undoClientTextReply: vi.fn(),
}));
vi.mock('@pepper/appointments', async (original) => ({
  ...(await original<typeof Appointments>()),
  replyToClientText: appointments.replyToClientText,
  undoClientTextReply: appointments.undoClientTextReply,
}));

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const CLIENT_ID = ClientIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708190');
const REPLY_ID = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708199';
const REPLY = { replyId: REPLY_ID, sendsAt: '2026-11-02T15:00:10.000Z' };

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

@Global()
@Module({ providers: [{ provide: DATABASE, useValue: { db: {} } }], exports: [DATABASE] })
class FakeConnectionsModule {}

let role: MembershipRole = 'owner';
const tenancy = { roleIn: vi.fn(() => Promise.resolve(role)) };
const limits = { hit: vi.fn(() => Promise.resolve()), spent: vi.fn(() => Promise.resolve(false)) };
let app: INestApplication;
let server: Server;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      FakeConnectionsModule,
      AuthModule.forRoot({ baseUrl: ORIGIN, secret: 'x'.repeat(32) }),
      ClientRepliesModule.forRoot({ outboxKey: Buffer.alloc(32, 7), texts: true }),
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
  role = 'owner';
  appointments.replyToClientText.mockReset();
  appointments.replyToClientText.mockResolvedValue(REPLY);
  appointments.undoClientTextReply.mockReset();
  appointments.undoClientTextReply.mockResolvedValue({ outcome: 'taken_back' });
  limits.hit.mockClear();
  limits.spent.mockReset();
  limits.spent.mockResolvedValue(false);
});

const path = `/v1/clients/${CLIENT_ID}/texts/replies`;
const reply = (body: object) =>
  request(server).post(path).set('cookie', 'signed-in').set('origin', ORIGIN).send(body);
const undo = (id = REPLY_ID) =>
  request(server).delete(`${path}/${id}`).set('cookie', 'signed-in').set('origin', ORIGIN);
const code = (body: unknown) => ApiErrorSchema.parse(body).code;

describe('POST /v1/clients/:clientId/texts/replies', () => {
  it.each<MembershipRole>(['owner', 'manager'])('a(n) %s queues a reply', async (r) => {
    role = r;
    expect((await reply({ body: 'See you then' }).expect(201)).body).toEqual(REPLY);
    expect(appointments.replyToClientText).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ context: { tenantId: TENANT, userId: USER, role: r } }),
      CLIENT_ID,
      { body: 'See you then' },
      expect.objectContaining({ texts: true }),
    );
    expect(limits.hit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'client-reply-tenant' }),
      TENANT,
    );
  });

  it('is 403 for staff, 400 for an empty or too long reply', async () => {
    role = 'staff';
    await reply({ body: 'Hi' }).expect(403);
    role = 'owner';
    expect(code((await reply({ body: '  ' }).expect(400)).body)).toBe('validation_failed');
    await reply({ body: 'x'.repeat(301) }).expect(400);
    expect(appointments.replyToClientText).not.toHaveBeenCalled();
  });

  it('answers the domain’s refusals with their codes, and counts none of them', async () => {
    const { ClientTextNotSendableError } =
      await vi.importActual<typeof Appointments>('@pepper/appointments');
    for (const [reason, status, answer] of [
      ['texts_off', 409, 'texts_off'],
      ['no_consent', 409, 'client_not_textable'],
      ['too_long', 422, 'reply_too_long'],
    ] as const) {
      appointments.replyToClientText.mockRejectedValueOnce(new ClientTextNotSendableError(reason));
      expect(code((await reply({ body: 'Hi' }).expect(status)).body)).toBe(answer);
    }
    appointments.replyToClientText.mockRejectedValueOnce(new ClientNotFoundError());
    expect(code((await reply({ body: 'Hi' }).expect(404)).body)).toBe('client_not_found');
    expect(limits.hit).not.toHaveBeenCalled();
  });

  it('is 429 once the hour’s replies are spent, before anything is queued', async () => {
    limits.spent.mockResolvedValue(true);
    expect(code((await reply({ body: 'Hi' }).expect(429)).body)).toBe('too_many_requests');
    expect(appointments.replyToClientText).not.toHaveBeenCalled();
  });
});

describe('DELETE /v1/clients/:clientId/texts/replies/:replyId', () => {
  it('takes a reply back, or says it is too late', async () => {
    expect((await undo().expect(200)).body).toEqual({ outcome: 'taken_back' });
    appointments.undoClientTextReply.mockResolvedValueOnce({ outcome: 'too_late' });
    expect((await undo().expect(200)).body).toEqual({ outcome: 'too_late' });
  });

  it('is 404 reply_not_found for no such reply, 400 for a bad id, 403 for staff', async () => {
    const { ClientTextNotSendableError } =
      await vi.importActual<typeof Appointments>('@pepper/appointments');
    appointments.undoClientTextReply.mockRejectedValueOnce(
      new ClientTextNotSendableError('not_found'),
    );
    expect(code((await undo().expect(404)).body)).toBe('reply_not_found');
    await undo('nope').expect(400);
    role = 'staff';
    await undo().expect(403);
  });
});

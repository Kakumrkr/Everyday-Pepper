import 'reflect-metadata';
import type { IncomingHttpHeaders, Server } from 'node:http';
import {
  ApiErrorSchema,
  TaskIdSchema,
  TenantIdSchema,
  UserIdSchema,
  UtcDateTimeSchema,
  type MembershipRole,
  type Task,
} from '@pepper/contracts';
import { ForbiddenError, TaskAssigneeNotMemberError, TaskNotFoundError } from '@pepper/core';
import { DATABASE } from '@pepper/runtime';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenancyService } from '../account/tenancy.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { TasksModule } from './tasks.module.js';
import { TasksService } from './tasks.service.js';

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const TASK_ID = TaskIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708190');
const AT = UtcDateTimeSchema.parse('2026-10-17T12:00:00.000Z');
const TASK: Task = {
  id: TASK_ID,
  title: 'Order color',
  dueAt: AT,
  assigneeUserId: USER,
  status: 'open',
  source: 'manual',
  createdByUserId: USER,
  completedAt: null,
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
const tasks = {
  list: vi.fn(() => Promise.resolve([TASK])),
  create: vi.fn((): Promise<Task> => Promise.resolve(TASK)),
  change: vi.fn((): Promise<Task> => Promise.resolve(TASK)),
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
      TasksModule,
    ],
  })
    .overrideProvider(AuthService)
    .useValue(new FakeAuth())
    .overrideProvider(TenancyService)
    .useValue(tenancy)
    .overrideProvider(TasksService)
    .useValue(tasks)
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

describe('/v1/tasks', () => {
  it.each<MembershipRole>(['owner', 'manager', 'staff'])('a(n) %s lists tasks', async (r) => {
    role = r;
    expect((await get('/v1/tasks?status=all&mine=true&limit=20').expect(200)).body).toEqual({
      tasks: [TASK],
    });
    expect(tasks.list).toHaveBeenCalledWith(context(), { status: 'all', mine: true, limit: 20 });
    await get('/v1/tasks');
    expect(tasks.list).toHaveBeenLastCalledWith(context(), {
      status: 'open',
      mine: false,
      limit: 100,
    });
  });

  it('needs a session; 400 for an unknown status', async () => {
    await request(server).get('/v1/tasks').expect(401);
    await get('/v1/tasks?status=archived').expect(400);
    expect(tasks.list).not.toHaveBeenCalled();
  });

  it.each<MembershipRole>(['owner', 'manager', 'staff'])('a(n) %s adds a task (201)', async (r) => {
    role = r;
    expect(
      (await send('post', '/v1/tasks', { title: ' Order color ', dueAt: AT }).expect(201)).body,
    ).toEqual(TASK);
    expect(tasks.create).toHaveBeenCalledWith(context(), { title: 'Order color', dueAt: AT });
  });

  it('403 forbidden and 422 task_assignee_not_member from the service; 400 for a bad body', async () => {
    tasks.create.mockRejectedValueOnce(new ForbiddenError('tasks.manage'));
    expect(
      code(
        (await send('post', '/v1/tasks', { title: 'X', assigneeUserId: USER }).expect(403)).body,
      ),
    ).toBe('forbidden');
    tasks.create.mockRejectedValueOnce(new TaskAssigneeNotMemberError());
    expect(
      code(
        (await send('post', '/v1/tasks', { title: 'X', assigneeUserId: USER }).expect(422)).body,
      ),
    ).toBe('task_assignee_not_member');
    await send('post', '/v1/tasks', { title: '' }).expect(400);
    await send('post', '/v1/tasks', { title: 'X', source: 'ai' }).expect(400);
    expect(tasks.create).toHaveBeenCalledTimes(2);
  });

  it('PATCH changes a task; 404 task_not_found; 400 for a bad id or an empty change', async () => {
    await send('patch', `/v1/tasks/${TASK_ID}`, { status: 'done' }).expect(200);
    expect(tasks.change).toHaveBeenCalledWith(context(), TASK_ID, { status: 'done' });
    tasks.change.mockRejectedValueOnce(new TaskNotFoundError());
    expect(
      code((await send('patch', `/v1/tasks/${TASK_ID}`, { status: 'done' }).expect(404)).body),
    ).toBe('task_not_found');
    await send('patch', '/v1/tasks/not-an-id', { status: 'done' }).expect(400);
    await send('patch', `/v1/tasks/${TASK_ID}`, {}).expect(400);
    expect(tasks.change).toHaveBeenCalledTimes(2);
  });

  it('403 from another origin', async () => {
    await send('post', '/v1/tasks', { title: 'X' }, 'https://evil.test').expect(403);
    await send('patch', `/v1/tasks/${TASK_ID}`, { status: 'done' }, 'https://evil.test').expect(
      403,
    );
    expect(tasks.create).not.toHaveBeenCalled();
    expect(tasks.change).not.toHaveBeenCalled();
  });
});

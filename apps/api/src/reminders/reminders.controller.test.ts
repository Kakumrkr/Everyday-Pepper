import 'reflect-metadata';
import type { IncomingHttpHeaders, Server } from 'node:http';
import {
  ApiErrorSchema,
  TenantIdSchema,
  UserIdSchema,
  type MembershipRole,
  type ReminderSettingsView,
} from '@pepper/contracts';
import { DATABASE } from '@pepper/runtime';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenancyService } from '../account/tenancy.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { RemindersModule, RemindersService } from './reminders.controller.js';

// `/v1/reminders/settings` without a database (S62, AC-X-75): every member reads, owners and
// managers change, a change is validated before the domain sees it, answers are parsed on the
// way out. appointments' reminder-texts.int.test.ts proves what the calls do.

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const VIEW: ReminderSettingsView = {
  settings: {
    texts: true,
    dayBefore: true,
    sameDay: true,
    sameDayLeadHours: 2,
    askToConfirm: false,
  },
  canChange: true,
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
const reminders = {
  get: vi.fn(() => Promise.resolve(VIEW)),
  change: vi.fn(() =>
    Promise.resolve({ ...VIEW, settings: { ...VIEW.settings, sameDayLeadHours: 3 } }),
  ),
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
      RemindersModule,
    ],
  })
    .overrideProvider(AuthService)
    .useValue(new FakeAuth())
    .overrideProvider(TenancyService)
    .useValue(tenancy)
    .overrideProvider(RemindersService)
    .useValue(reminders)
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
const PATH = '/v1/reminders/settings';
const patch = (body: object, origin = ORIGIN) =>
  request(server).patch(PATH).set('cookie', 'signed-in').set('origin', origin).send(body);

describe('/v1/reminders/settings', () => {
  it.each<MembershipRole>(['owner', 'manager', 'staff'])('a(n) %s reads them', async (r) => {
    role = r;
    expect((await request(server).get(PATH).set('cookie', 'signed-in').expect(200)).body).toEqual(
      VIEW,
    );
    expect(reminders.get).toHaveBeenCalledWith(context());
  });

  it('needs a session', async () => {
    await request(server).get(PATH).expect(401);
    expect(reminders.get).not.toHaveBeenCalled();
  });

  it.each<MembershipRole>(['owner', 'manager'])('a(n) %s changes them', async (r) => {
    role = r;
    const body: unknown = (await patch({ sameDayLeadHours: 3 }).expect(200)).body;
    expect(body).toMatchObject({ settings: { sameDayLeadHours: 3 } });
    expect(reminders.change).toHaveBeenCalledWith(context(), { sameDayLeadHours: 3 });
  });

  it('403 for staff; 400 for an empty, unknown or out-of-range change; 403 cross-origin', async () => {
    role = 'staff';
    expect(ApiErrorSchema.parse((await patch({ texts: false }).expect(403)).body).code).toBe(
      'forbidden',
    );
    role = 'owner';
    await patch({}).expect(400);
    await patch({ sameDayLeadHours: 4 }).expect(400);
    await patch({ texts: 'no' }).expect(400);
    await patch({ tenantId: TENANT }).expect(400);
    await patch({ texts: false }, 'https://evil.example').expect(403);
    expect(reminders.change).not.toHaveBeenCalled();
  });
});

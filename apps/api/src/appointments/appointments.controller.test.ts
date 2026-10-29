import 'reflect-metadata';
import type { IncomingHttpHeaders, Server } from 'node:http';
import {
  ServiceNotFoundError,
  StaffMemberNotFoundError,
  TimeOffNotFoundError,
} from '@pepper/appointments';
import {
  ApiErrorSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  TimeOffIdSchema,
  UserIdSchema,
  UtcDateTimeSchema,
  type BookingRules,
  type BookingRulesResponse,
  PLATFORM_RULE_DEFAULTS,
  type MembershipRole,
  type Service,
  type SetupReview,
  type StaffMember,
  type TimeOff,
  type WeeklyHours,
} from '@pepper/contracts';
import { ForbiddenError, MemberNotFoundError } from '@pepper/core';
import { ServiceNameTakenError, StaffMemberLinkTakenError } from '@pepper/db';
import { DATABASE } from '@pepper/runtime';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenancyService } from '../account/tenancy.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { BookingEmailsModule } from '../booking-emails/booking-emails.js';
import { AppointmentsModule } from './appointments.module.js';
import { AppointmentsService } from './appointments.service.js';

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const SERVICE_ID = ServiceIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708197');
const STAFF_ID = StaffMemberIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708198');
const TIME_OFF_ID = TimeOffIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708199');
const AT = UtcDateTimeSchema.parse('2026-10-17T12:00:00.000Z');

const SERVICE: Service = {
  id: SERVICE_ID,
  name: "Women's haircut",
  category: null,
  durationMinutes: 60,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  priceFromCents: 6500,
  priceToCents: null,
  active: true,
  createdAt: AT,
  updatedAt: AT,
};
const STAFF: StaffMember = {
  id: STAFF_ID,
  displayName: 'Jess',
  color: '#2a7230',
  active: true,
  userId: USER,
  serviceIds: [SERVICE_ID],
  createdAt: AT,
  updatedAt: AT,
};
const HOURS: WeeklyHours = { intervals: [{ weekday: 1, start: '09:00', end: '17:00' }] };
const RULES: BookingRules = {
  rules: [
    { type: 'minimum_notice', version: 1, staffMemberId: null, params: { minutes: 60 } },
    { type: 'maximum_advance', version: 1, staffMemberId: STAFF_ID, params: { days: 30 } },
  ],
};
const RULES_RESPONSE: BookingRulesResponse = {
  ...RULES,
  defaults: { ...PLATFORM_RULE_DEFAULTS, slotIntervalMinutes: 30 },
};
const REVIEW: SetupReview = {
  reviewedAt: null,
  timeZone: 'America/Chicago',
  services: { count: 1, lowestPriceCents: 6500, highestPriceCents: 6500 },
  providers: [{ id: STAFF_ID, displayName: 'Jess', isYou: true, serviceCount: 1, hours: HOURS }],
  warnings: [],
};
const TIME_OFF: TimeOff = {
  id: TIME_OFF_ID,
  staffMemberId: STAFF_ID,
  startsAt: UtcDateTimeSchema.parse('2026-10-20T13:00:00.000Z'),
  endsAt: UtcDateTimeSchema.parse('2026-10-20T17:00:00.000Z'),
  createdAt: AT,
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
const appointments = {
  setup: vi.fn(() => Promise.resolve(REVIEW)),
  reviewSetup: vi.fn(() => Promise.resolve({ ...REVIEW, reviewedAt: AT })),
  services: vi.fn(() => Promise.resolve([SERVICE])),
  createService: vi.fn((): Promise<Service> => Promise.resolve(SERVICE)),
  updateService: vi.fn((): Promise<Service> => Promise.resolve(SERVICE)),
  staff: vi.fn(() => Promise.resolve([STAFF])),
  createStaffMember: vi.fn((): Promise<StaffMember> => Promise.resolve(STAFF)),
  updateStaffMember: vi.fn((): Promise<StaffMember> => Promise.resolve(STAFF)),
  hours: vi.fn(() => Promise.resolve(HOURS)),
  replaceHours: vi.fn((): Promise<WeeklyHours> => Promise.resolve(HOURS)),
  timeOff: vi.fn(() => Promise.resolve([TIME_OFF])),
  addTimeOff: vi.fn((): Promise<TimeOff> => Promise.resolve(TIME_OFF)),
  removeTimeOff: vi.fn((): Promise<void> => Promise.resolve()),
  rules: vi.fn(() => Promise.resolve(RULES_RESPONSE)),
  replaceRules: vi.fn((): Promise<BookingRulesResponse> => Promise.resolve(RULES_RESPONSE)),
};

@Global()
@Module({ providers: [{ provide: DATABASE, useValue: { db: {} } }], exports: [DATABASE] })
class FakeConnectionsModule {}

let app: INestApplication;
let server: Server;
const auth = new FakeAuth();

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      FakeConnectionsModule,
      AuthModule.forRoot({ baseUrl: ORIGIN, secret: 'x'.repeat(32) }),
      BookingEmailsModule.forRoot({ baseUrl: ORIGIN, outboxKey: Buffer.alloc(32) }),
      AppointmentsModule,
    ],
  })
    .overrideProvider(AuthService)
    .useValue(auth)
    .overrideProvider(TenancyService)
    .useValue(tenancy)
    .overrideProvider(AppointmentsService)
    .useValue(appointments)
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
const send = (method: 'post' | 'put', path: string, body: object) =>
  request(server)[method](path).set('cookie', 'signed-in').set('origin', ORIGIN).send(body);
const del = (path: string) =>
  request(server).delete(path).set('cookie', 'signed-in').set('origin', ORIGIN);

function code(body: unknown): string {
  return ApiErrorSchema.parse(body).code;
}

const haircut = { name: "Women's haircut", durationMinutes: 60, priceFromCents: 6500 };
const span = { startsAt: '2026-10-20T13:00:00.000Z', endsAt: '2026-10-20T17:00:00.000Z' };

describe('the setup review (S46)', () => {
  it.each<MembershipRole>(['owner', 'manager'])('a(n) %s reads and checks it', async (r) => {
    role = r;
    expect((await get('/v1/setup').expect(200)).body).toEqual(REVIEW);
    expect((await send('post', '/v1/setup/review', {}).expect(200)).body).toEqual({
      ...REVIEW,
      reviewedAt: AT,
    });
    expect(appointments.reviewSetup).toHaveBeenCalledWith(context());
  });

  it('403 for staff, before the domain is asked', async () => {
    role = 'staff';
    expect(code((await get('/v1/setup').expect(403)).body)).toBe('forbidden');
    expect(code((await send('post', '/v1/setup/review', {}).expect(403)).body)).toBe('forbidden');
    expect(appointments.setup).not.toHaveBeenCalled();
    expect(appointments.reviewSetup).not.toHaveBeenCalled();
  });
});

describe('reading: every role', () => {
  it.each<MembershipRole>(['owner', 'manager', 'staff'])('a(n) %s reads everything', async (r) => {
    role = r;
    expect((await get('/v1/services').expect(200)).body).toEqual({ services: [SERVICE] });
    expect((await get('/v1/staff').expect(200)).body).toEqual({ staff: [STAFF] });
    expect((await get(`/v1/staff/${STAFF_ID}/hours`).expect(200)).body).toEqual(HOURS);
    expect((await get('/v1/rules').expect(200)).body).toEqual(RULES_RESPONSE);
    expect(
      (
        await get(`/v1/staff/${STAFF_ID}/time-off?from=2026-10-01T00:00:00.000Z&limit=5`).expect(
          200,
        )
      ).body,
    ).toEqual({ timeOff: [TIME_OFF] });
    expect(appointments.timeOff).toHaveBeenCalledWith(context(), STAFF_ID, {
      from: '2026-10-01T00:00:00.000Z',
      limit: 5,
    });
  });

  it('401 signed out', async () => {
    await request(server).get('/v1/services').expect(401);
    expect(appointments.services).not.toHaveBeenCalled();
  });

  it('400 for a malformed staff id or query', async () => {
    expect((await get('/v1/staff/jess/hours').expect(400)).body).toMatchObject({
      code: 'validation_failed',
      fields: ['staffMemberId'],
    });
    expect((await get(`/v1/staff/${STAFF_ID}/time-off?limit=0`).expect(400)).body).toMatchObject({
      fields: ['limit'],
    });
  });
});

describe('services', () => {
  it('creates (201) and replaces with validated, defaulted input', async () => {
    expect((await send('post', '/v1/services', haircut).expect(201)).body).toEqual(SERVICE);
    expect(appointments.createService).toHaveBeenCalledWith(context(), {
      ...haircut,
      category: null,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceToCents: null,
      active: true,
    });
    await send('put', `/v1/services/${SERVICE_ID}`, haircut).expect(200);
    expect(appointments.updateService).toHaveBeenCalledWith(
      context(),
      SERVICE_ID,
      expect.objectContaining(haircut),
    );
  });

  it.each([
    ['a price in dollars', { ...haircut, priceFromCents: 65.5 }, 'priceFromCents'],
    [
      'a range without "from"',
      { name: 'X', durationMinutes: 30, priceToCents: 100 },
      'priceToCents',
    ],
    ['a smuggled tenant', { ...haircut, tenantId: TENANT }, '(body)'],
  ])('400 for %s', async (_label, body, field) => {
    const response = await send('post', '/v1/services', body).expect(400);
    expect(response.body).toMatchObject({ code: 'validation_failed', fields: [field] });
    expect(appointments.createService).not.toHaveBeenCalled();
  });

  it('403 for staff, before the service is asked', async () => {
    role = 'staff';
    expect(code((await send('post', '/v1/services', haircut).expect(403)).body)).toBe('forbidden');
    expect(code((await send('put', `/v1/services/${SERVICE_ID}`, haircut).expect(403)).body)).toBe(
      'forbidden',
    );
    expect(appointments.createService).not.toHaveBeenCalled();
    expect(appointments.updateService).not.toHaveBeenCalled();
  });

  it.each([
    [new ServiceNotFoundError(), 404, 'service_not_found'],
    [new ServiceNameTakenError(), 409, 'service_name_taken'],
  ])('answers %s with %d %s', async (error, status, expected) => {
    appointments.updateService.mockRejectedValueOnce(error);
    const response = await send('put', `/v1/services/${SERVICE_ID}`, haircut).expect(status);
    expect(code(response.body)).toBe(expected);
  });

  it('403 forbidden_origin without the app origin (CSRF)', async () => {
    await request(server).post('/v1/services').set('cookie', 'signed-in').send(haircut).expect(403);
    expect(appointments.createService).not.toHaveBeenCalled();
  });
});

describe('staff members', () => {
  const jess = { displayName: 'Jess', userId: USER, serviceIds: [SERVICE_ID] };

  it('creates and replaces', async () => {
    role = 'manager';
    expect((await send('post', '/v1/staff', jess).expect(201)).body).toEqual(STAFF);
    expect(appointments.createStaffMember).toHaveBeenCalledWith(context(), {
      ...jess,
      color: '#2a7230',
      active: true,
    });
    await send('put', `/v1/staff/${STAFF_ID}`, jess).expect(200);
    expect(appointments.updateStaffMember).toHaveBeenCalledWith(
      context(),
      STAFF_ID,
      expect.objectContaining(jess),
    );
  });

  it('403 for staff', async () => {
    role = 'staff';
    await send('post', '/v1/staff', jess).expect(403);
    await send('put', `/v1/staff/${STAFF_ID}`, jess).expect(403);
    expect(appointments.createStaffMember).not.toHaveBeenCalled();
  });

  it.each([
    [new MemberNotFoundError(), 404, 'member_not_found'],
    [new ServiceNotFoundError(), 404, 'service_not_found'],
    [new StaffMemberNotFoundError(), 404, 'staff_member_not_found'],
    [new StaffMemberLinkTakenError(), 409, 'staff_member_link_taken'],
  ])('answers %s with %d %s', async (error, status, expected) => {
    appointments.updateStaffMember.mockRejectedValueOnce(error);
    const response = await send('put', `/v1/staff/${STAFF_ID}`, jess).expect(status);
    expect(code(response.body)).toBe(expected);
  });
});

describe('working hours', () => {
  it('owners and managers replace the week', async () => {
    role = 'manager';
    await send('put', `/v1/staff/${STAFF_ID}/hours`, HOURS).expect(200);
    expect(appointments.replaceHours).toHaveBeenCalledWith(context(), STAFF_ID, HOURS);
  });

  it('403 for staff, even for their own week', async () => {
    role = 'staff';
    await send('put', `/v1/staff/${STAFF_ID}/hours`, HOURS).expect(403);
    expect(appointments.replaceHours).not.toHaveBeenCalled();
  });

  it('400 for overlapping intervals', async () => {
    const overlapping = {
      intervals: [
        { weekday: 1, start: '09:00', end: '13:00' },
        { weekday: 1, start: '12:00', end: '17:00' },
      ],
    };
    const response = await send('put', `/v1/staff/${STAFF_ID}/hours`, overlapping).expect(400);
    expect(response.body).toMatchObject({ fields: ['intervals'] });
  });
});

describe('time off', () => {
  it('staff may ask to add and remove (the service checks it is their own)', async () => {
    role = 'staff';
    expect((await send('post', `/v1/staff/${STAFF_ID}/time-off`, span).expect(201)).body).toEqual(
      TIME_OFF,
    );
    expect(appointments.addTimeOff).toHaveBeenCalledWith(context(), STAFF_ID, span);
    await del(`/v1/staff/${STAFF_ID}/time-off/${TIME_OFF_ID}`).expect(204);
    expect(appointments.removeTimeOff).toHaveBeenCalledWith(context(), STAFF_ID, TIME_OFF_ID);
  });

  it.each([
    [new ForbiddenError('time_off.manage'), 403, 'forbidden'],
    [new StaffMemberNotFoundError(), 404, 'staff_member_not_found'],
    [new TimeOffNotFoundError(), 404, 'time_off_not_found'],
  ])('answers %s with %d %s', async (error, status, expected) => {
    appointments.removeTimeOff.mockRejectedValueOnce(error);
    const response = await del(`/v1/staff/${STAFF_ID}/time-off/${TIME_OFF_ID}`).expect(status);
    expect(code(response.body)).toBe(expected);
  });

  it('400 for an end before the start or a free-text reason', async () => {
    await send('post', `/v1/staff/${STAFF_ID}/time-off`, {
      startsAt: span.endsAt,
      endsAt: span.startsAt,
    }).expect(400);
    await send('post', `/v1/staff/${STAFF_ID}/time-off`, { ...span, reason: 'dentist' }).expect(
      400,
    );
    expect(appointments.addTimeOff).not.toHaveBeenCalled();
  });
});

describe('booking rules', () => {
  const body = {
    rules: [
      { type: 'maximum_advance', staffMemberId: STAFF_ID, params: { days: 30 } },
      { type: 'minimum_notice', params: { minutes: 60 } },
    ],
  };

  it('owners and managers replace the set, validated, defaulted and sorted', async () => {
    for (const r of ['owner', 'manager'] as const) {
      role = r;
      expect((await send('put', '/v1/rules', body).expect(200)).body).toEqual(RULES_RESPONSE);
      expect(appointments.replaceRules).toHaveBeenLastCalledWith(context(), RULES);
    }
  });

  it('403 for staff, before the service is asked', async () => {
    role = 'staff';
    expect(code((await send('put', '/v1/rules', body).expect(403)).body)).toBe('forbidden');
    expect(appointments.replaceRules).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown rule type', { rules: [{ type: 'learned', params: {} }] }, 'rules.0.type'],
    [
      'a slot step that does not divide an hour',
      { rules: [{ type: 'slot_interval', params: { minutes: 45 } }] },
      'rules.0.params.minutes',
    ],
    [
      'the same rule twice',
      {
        rules: [
          { type: 'minimum_notice', params: { minutes: 60 } },
          { type: 'minimum_notice', params: { minutes: 30 } },
        ],
      },
      'rules',
    ],
    [
      'a blackout ending before it starts',
      {
        rules: [
          { type: 'blackout_window', params: { startDate: '2026-12-26', endDate: '2026-12-25' } },
        ],
      },
      'rules.0.params.endDate',
    ],
    ['a smuggled tenant', { rules: [], tenantId: TENANT }, '(body)'],
  ])('400 for %s', async (_label, invalid, field) => {
    const response = await send('put', '/v1/rules', invalid).expect(400);
    expect(response.body).toMatchObject({ code: 'validation_failed', fields: [field] });
    expect(appointments.replaceRules).not.toHaveBeenCalled();
  });

  it('404 staff_member_not_found for a staff member the business does not have', async () => {
    appointments.replaceRules.mockRejectedValueOnce(new StaffMemberNotFoundError());
    const response = await send('put', '/v1/rules', body).expect(404);
    expect(code(response.body)).toBe('staff_member_not_found');
  });

  it('403 forbidden_origin without the app origin (CSRF)', async () => {
    await request(server).put('/v1/rules').set('cookie', 'signed-in').send(body).expect(403);
    expect(appointments.replaceRules).not.toHaveBeenCalled();
  });
});

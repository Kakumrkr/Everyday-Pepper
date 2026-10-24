import 'reflect-metadata';
import type { IncomingHttpHeaders, Server } from 'node:http';
import {
  BookingNotFoundError,
  SlotUnavailableError,
  WaitlistExpiredError,
} from '@pepper/appointments';
import {
  ApiErrorSchema,
  AvailabilityResponseSchema,
  AvailableSlotSchema,
  BookingIdSchema,
  BookingsResponseSchema,
  BusyResponseSchema,
  ClientIdSchema,
  MAX_LIST_ITEMS,
  ServiceIdSchema,
  SlotUnavailableSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  UserIdSchema,
  UtcDateTimeSchema,
  WaitlistEntryIdSchema,
  type Booking,
  type BusyTime,
  type MembershipRole,
  type WaitlistEntry,
} from '@pepper/contracts';
import { ForbiddenError } from '@pepper/core';
import { DATABASE } from '@pepper/runtime';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenancyService } from '../account/tenancy.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { AppointmentsModule } from './appointments.module.js';
import { capped } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const CLIENT_ID = ClientIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708190');
const SERVICE_ID = ServiceIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708197');
const STAFF_ID = StaffMemberIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708198');
const BOOKING_ID = BookingIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f70819b');
const ENTRY_ID = WaitlistEntryIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f70819c');
const utc = (iso: string) => UtcDateTimeSchema.parse(iso);
const AT = utc('2026-10-17T12:00:00.000Z');
const FROM = '2026-11-03T05:00:00.000Z';
const TO = '2026-11-04T05:00:00.000Z';

const BOOKING: Booking = {
  id: BOOKING_ID,
  clientId: CLIENT_ID,
  serviceId: SERVICE_ID,
  staffMemberId: STAFF_ID,
  startsAt: utc('2026-11-03T15:00:00.000Z'),
  endsAt: utc('2026-11-03T16:00:00.000Z'),
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 10,
  priceFromCents: 6500,
  priceToCents: null,
  status: 'confirmed',
  source: 'team',
  overridden: false,
  createdAt: AT,
  updatedAt: AT,
};
const BUSY: BusyTime = {
  staffMemberId: STAFF_ID,
  startsAt: BOOKING.startsAt,
  endsAt: BOOKING.endsAt,
  occupiedFrom: BOOKING.startsAt,
  occupiedTo: utc('2026-11-03T16:10:00.000Z'),
};
const SLOT = AvailableSlotSchema.parse({
  staffMemberId: STAFF_ID,
  startsAt: '2026-11-03T20:15:00.000Z',
  endsAt: '2026-11-03T21:15:00.000Z',
});
const WINDOWS = [{ date: '2026-11-05', start: '09:00', end: '12:00' }];
const ENTRY: WaitlistEntry = {
  id: ENTRY_ID,
  clientId: CLIENT_ID,
  serviceId: SERVICE_ID,
  staffMemberId: null,
  windows: WINDOWS,
  status: 'waiting',
  expiresAt: utc('2026-11-05T17:00:00.000Z'),
  bookingId: null,
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
const bookings = {
  bookings: vi.fn(() => Promise.resolve([BOOKING])),
  booking: vi.fn((): Promise<Booking> => Promise.resolve(BOOKING)),
  createBooking: vi.fn((): Promise<Booking> => Promise.resolve(BOOKING)),
  changeBooking: vi.fn((): Promise<Booking> => Promise.resolve(BOOKING)),
  busy: vi.fn(() => Promise.resolve([BUSY])),
  availability: vi.fn(() => Promise.resolve([SLOT])),
  waitlist: vi.fn(() => Promise.resolve([ENTRY])),
  addToWaitlist: vi.fn((): Promise<WaitlistEntry> => Promise.resolve(ENTRY)),
  changeWaitlistEntry: vi.fn((): Promise<WaitlistEntry> => Promise.resolve(ENTRY)),
  waitlistOffers: vi.fn(() => Promise.resolve([])),
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
      AppointmentsModule,
    ],
  })
    .overrideProvider(AuthService)
    .useValue(auth)
    .overrideProvider(TenancyService)
    .useValue(tenancy)
    .overrideProvider(BookingsService)
    .useValue(bookings)
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
const send = (method: 'post' | 'patch', path: string, body: object) =>
  request(server)[method](path).set('cookie', 'signed-in').set('origin', ORIGIN).send(body);

function code(body: unknown): string {
  return ApiErrorSchema.parse(body).code;
}

const newBooking = {
  clientId: CLIENT_ID,
  serviceId: SERVICE_ID,
  staffMemberId: STAFF_ID,
  startsAt: '2026-11-03T15:00:00.000Z',
};

describe('reading: every role', () => {
  it.each<MembershipRole>(['owner', 'manager', 'staff'])(
    'a(n) %s reads bookings, busy times, availability and the waitlist',
    async (r) => {
      role = r;
      expect(
        (await get(`/v1/bookings?from=${FROM}&to=${TO}&status=confirmed`).expect(200)).body,
      ).toEqual({ bookings: [BOOKING], truncated: false });
      expect(bookings.bookings).toHaveBeenCalledWith(
        context(),
        { from: FROM, to: TO, status: 'confirmed' },
        MAX_LIST_ITEMS + 1,
      );
      expect((await get(`/v1/bookings/${BOOKING_ID}`).expect(200)).body).toEqual(BOOKING);
      expect((await get(`/v1/calendar/busy?from=${FROM}&to=${TO}`).expect(200)).body).toEqual({
        busy: [BUSY],
        truncated: false,
      });
      expect(
        (await get(`/v1/availability?serviceId=${SERVICE_ID}&from=${FROM}&to=${TO}`).expect(200))
          .body,
      ).toEqual({ slots: [SLOT], truncated: false });
      expect((await get('/v1/waitlist?all=true&limit=5').expect(200)).body).toEqual({
        entries: [ENTRY],
      });
      expect(bookings.waitlist).toHaveBeenCalledWith(context(), { all: true, limit: 5 });
      // The offers of freed times (S37), as the domain scopes them.
      expect((await get('/v1/waitlist/offers').expect(200)).body).toEqual({ offers: [] });
    },
  );

  it('cuts long answers at MAX_LIST_ITEMS and says so', async () => {
    const more = <T>(item: T): T[] => Array.from({ length: MAX_LIST_ITEMS + 1 }, () => item);
    bookings.bookings.mockResolvedValueOnce(more(BOOKING));
    bookings.busy.mockResolvedValueOnce(more(BUSY));
    bookings.availability.mockResolvedValueOnce(more(SLOT));
    const listed = BookingsResponseSchema.parse(
      (await get(`/v1/bookings?from=${FROM}&to=${TO}`).expect(200)).body,
    );
    expect(listed.bookings).toHaveLength(MAX_LIST_ITEMS);
    expect(listed.truncated).toBe(true);
    const busy = BusyResponseSchema.parse(
      (await get(`/v1/calendar/busy?from=${FROM}&to=${TO}`).expect(200)).body,
    );
    expect([busy.busy.length, busy.truncated]).toEqual([MAX_LIST_ITEMS, true]);
    const slots = AvailabilityResponseSchema.parse(
      (await get(`/v1/availability?serviceId=${SERVICE_ID}&from=${FROM}&to=${TO}`).expect(200))
        .body,
    );
    expect([slots.slots.length, slots.truncated]).toEqual([MAX_LIST_ITEMS, true]);
  });

  it('exactly MAX_LIST_ITEMS is not truncated', () => {
    const items = Array.from({ length: MAX_LIST_ITEMS }, (_, i) => i);
    expect(capped(items)).toEqual([items, false]);
    expect(capped([...items, MAX_LIST_ITEMS])).toEqual([items, true]);
    expect(capped([])).toEqual([[], false]);
  });

  it('401 signed out', async () => {
    await request(server).get(`/v1/bookings?from=${FROM}&to=${TO}`).expect(401);
    expect(bookings.bookings).not.toHaveBeenCalled();
  });

  it('400 for a missing or too long range, and a malformed id', async () => {
    const missing = (await get('/v1/bookings').expect(400)).body as { fields: string[] };
    expect(code(missing)).toBe('validation_failed');
    expect(missing.fields).toEqual(expect.arrayContaining(['from', 'to']));
    const tooLong = await get(`/v1/calendar/busy?from=${FROM}&to=2027-01-05T05:00:00.000Z`).expect(
      400,
    );
    expect(tooLong.body).toMatchObject({ fields: ['to'] });
    await get(`/v1/availability?from=${FROM}&to=${TO}`).expect(400);
    await get('/v1/bookings/not-a-uuid').expect(400);
    expect(bookings.busy).not.toHaveBeenCalled();
  });

  it('404 booking_not_found (also for staff asking about another staff member)', async () => {
    bookings.booking.mockRejectedValueOnce(new BookingNotFoundError());
    expect(code((await get(`/v1/bookings/${BOOKING_ID}`).expect(404)).body)).toBe(
      'booking_not_found',
    );
  });
});

describe('booking', () => {
  it.each<MembershipRole>(['owner', 'manager', 'staff'])(
    'a(n) %s may ask to book (201); the service checks whose staff member it is',
    async (r) => {
      role = r;
      expect((await send('post', '/v1/bookings', newBooking).expect(201)).body).toEqual(BOOKING);
      expect(bookings.createBooking).toHaveBeenCalledWith(context(), {
        ...newBooking,
        override: false,
        notifyClient: true,
      });
    },
  );

  it('passes on the exact contact staff found the client by (ADR-0020), normalised', async () => {
    role = 'staff';
    const found = { ...newBooking, clientContact: 'Maria@Example.test' };
    await send('post', '/v1/bookings', found).expect(201);
    expect(bookings.createBooking).toHaveBeenCalledWith(context(), {
      ...newBooking,
      clientContact: 'maria@example.test',
      override: false,
      notifyClient: true,
    });
    await send('post', '/v1/bookings', { ...newBooking, clientContact: 'mar' }).expect(400);
  });

  it('409 slot_unavailable carries the nearest alternatives (AC-W2-1)', async () => {
    bookings.createBooking.mockRejectedValueOnce(new SlotUnavailableError([SLOT]));
    const response = await send('post', '/v1/bookings', newBooking).expect(409);
    expect(SlotUnavailableSchema.parse(response.body)).toEqual({
      code: 'slot_unavailable',
      message: 'That time cannot be booked',
      alternatives: [SLOT],
    });
  });

  it('403 forbidden from the service (staff booking someone else or overriding)', async () => {
    role = 'staff';
    bookings.createBooking.mockRejectedValueOnce(new ForbiddenError('bookings.manage'));
    const response = await send('post', '/v1/bookings', { ...newBooking, override: true });
    expect(response.status).toBe(403);
    expect(code(response.body)).toBe('forbidden');
  });

  it('400 for a start with an offset, a status, or a source from the caller', async () => {
    for (const body of [
      { ...newBooking, startsAt: '2026-11-03T10:00:00-05:00' },
      { ...newBooking, status: 'completed' },
      { ...newBooking, source: 'booking_page' },
    ]) {
      await send('post', '/v1/bookings', body).expect(400);
    }
    expect(bookings.createBooking).not.toHaveBeenCalled();
  });

  it('moves or changes the status with PATCH', async () => {
    await send('patch', `/v1/bookings/${BOOKING_ID}`, { startsAt: newBooking.startsAt }).expect(
      200,
    );
    expect(bookings.changeBooking).toHaveBeenCalledWith(context(), BOOKING_ID, {
      startsAt: newBooking.startsAt,
      override: false,
      notifyClient: true,
    });
    await send('patch', `/v1/bookings/${BOOKING_ID}`, { status: 'cancelled' }).expect(200);
    expect(bookings.changeBooking).toHaveBeenLastCalledWith(context(), BOOKING_ID, {
      status: 'cancelled',
      notifyClient: true,
    });
    await send('patch', `/v1/bookings/${BOOKING_ID}`, {
      status: 'cancelled',
      notifyClient: false,
    }).expect(200);
    expect(bookings.changeBooking).toHaveBeenLastCalledWith(context(), BOOKING_ID, {
      status: 'cancelled',
      notifyClient: false,
    });
    await send('patch', `/v1/bookings/${BOOKING_ID}`, { status: 'confirmed' }).expect(400);
  });

  it('403 forbidden_origin without the app origin (CSRF)', async () => {
    const response = await request(server)
      .patch(`/v1/bookings/${BOOKING_ID}`)
      .set('cookie', 'signed-in')
      .send({ status: 'cancelled' });
    expect(response.status).toBe(403);
    expect(code(response.body)).toBe('forbidden_origin');
    expect(bookings.changeBooking).not.toHaveBeenCalled();
  });
});

describe('waitlist', () => {
  const newEntry = { clientId: CLIENT_ID, serviceId: SERVICE_ID, windows: WINDOWS };

  it('adds (201) with sorted windows and a default of anyone', async () => {
    expect((await send('post', '/v1/waitlist', newEntry).expect(201)).body).toEqual(ENTRY);
    expect(bookings.addToWaitlist).toHaveBeenCalledWith(context(), {
      ...newEntry,
      staffMemberId: null,
    });
  });

  it('400 waitlist_expired when every window has passed', async () => {
    bookings.addToWaitlist.mockRejectedValueOnce(new WaitlistExpiredError());
    expect(code((await send('post', '/v1/waitlist', newEntry).expect(400)).body)).toBe(
      'waitlist_expired',
    );
  });

  it('cancels with PATCH; nothing else', async () => {
    await send('patch', `/v1/waitlist/${ENTRY_ID}`, { status: 'cancelled' }).expect(200);
    expect(bookings.changeWaitlistEntry).toHaveBeenCalledWith(context(), ENTRY_ID, {
      status: 'cancelled',
    });
    await send('patch', `/v1/waitlist/${ENTRY_ID}`, { status: 'booked' }).expect(400);
  });
});

import 'reflect-metadata';
import type { Server } from 'node:http';
import {
  BookingPageNotFoundError,
  WaitlistOfferTakenError,
  SlotUnavailableError,
  WrongVerificationCodeError,
} from '@pepper/appointments';
import {
  ApiErrorSchema,
  AvailableSlotSchema,
  BookingConfirmResponseSchema,
  BookingRequestResponseSchema,
  PublicBookingResponseSchema,
  PublicBusinessSchema,
  PublicOfferResponseSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  type PublicBooking,
  type PublicBusiness,
  type PublicOffer,
} from '@pepper/contracts';
import { DATABASE, REDIS } from '@pepper/runtime';
import { Global, HttpException, HttpStatus, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenancyService } from '../account/tenancy.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { RateLimiter, type RateLimit } from '../http/rate-limit.js';
import { MailModule } from '@pepper/runtime';
import { PublicBookingModule } from './public-booking.module.js';
import { PublicBookingService } from './public-booking.service.js';

const ORIGIN = 'http://localhost:3000';
const SERVICE_ID = ServiceIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708197');
const STAFF_ID = StaffMemberIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708198');
const REQUEST_ID = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f70819d';
const TOKEN = 'q1W2e3R4t5Y6u7I8o9P0a_S-d1F2g3H4j5K6l7Z8x9C';
const BASE = '/v1/public/businesses/juniper';

const BUSINESS: PublicBusiness = {
  name: 'Juniper Hair Studio',
  slug: 'juniper',
  timeZone: 'America/New_York',
  brandColor: '#7a3e6c',
  phone: '+15551234567',
  publicAddress: null,
  cancellationPolicy: 'Cancel 24 hours ahead.',
  cancellationSentence: null,
  services: [],
  staff: [],
  photos: { logo: null, cover: null, gallery: [] },
  depositAudience: 'everyone',
};
const SLOT = AvailableSlotSchema.parse({
  staffMemberId: STAFF_ID,
  startsAt: '2026-11-03T15:00:00.000Z',
  endsAt: '2026-11-03T16:00:00.000Z',
});
const BOOKING = {
  status: 'confirmed',
  startsAt: SLOT.startsAt,
  endsAt: SLOT.endsAt,
  service: { id: SERVICE_ID, name: 'Haircut' },
  staff: { id: STAFF_ID, displayName: 'Jess' },
  changeable: true,
  deposit: null,
} as PublicBooking;
const OFFER = {
  status: 'open',
  startsAt: SLOT.startsAt,
  endsAt: SLOT.endsAt,
  service: { id: SERVICE_ID, name: 'Haircut' },
  staff: { id: STAFF_ID, displayName: 'Jess' },
  expiresAt: '2026-11-03T13:00:00.000Z',
} as PublicOffer;
const ASK = {
  serviceId: SERVICE_ID,
  staffMemberId: STAFF_ID,
  startsAt: SLOT.startsAt,
  name: 'Ana Ruiz',
  email: 'Ana@Example.test',
};

const service = {
  business: vi.fn(() => Promise.resolve(BUSINESS)),
  availability: vi.fn(() => Promise.resolve([SLOT])),
  request: vi.fn((): Promise<{ response: unknown; refreshDevice?: string }> =>
    Promise.resolve({
      response: { requestId: REQUEST_ID, expiresAt: '2026-11-02T12:10:00.000Z' },
    }),
  ),
  confirm: vi.fn((): Promise<{ response: unknown; device?: string }> =>
    Promise.resolve({ response: { booking: BOOKING, manageToken: TOKEN } }),
  ),
  secureCookies: false,
  forget: vi.fn(() => Promise.resolve(true)),
  funnelStep: vi.fn(() => Promise.resolve()),
  managed: vi.fn(() => Promise.resolve(BOOKING)),
  reschedule: vi.fn(() => Promise.resolve(BOOKING)),
  cancel: vi.fn(() => Promise.resolve({ ...BOOKING, status: 'cancelled', changeable: false })),
  offer: vi.fn(() => Promise.resolve(OFFER)),
  claim: vi.fn(() => Promise.resolve({ booking: BOOKING, manageToken: TOKEN })),
  waitlistRequest: vi.fn(() =>
    Promise.resolve({ requestId: REQUEST_ID, expiresAt: '2026-11-02T12:10:00.000Z' }),
  ),
  waitlistConfirm: vi.fn(() =>
    Promise.resolve({
      entry: {
        service: { id: SERVICE_ID, name: 'Haircut' },
        staff: { id: STAFF_ID, displayName: 'Jess' },
        date: '2026-11-03',
        expiresAt: '2026-11-04T05:00:00.000Z',
      },
    }),
  ),
};
const hits: { limit: string; key: string }[] = [];
let overLimit: string | null = null;
const limiter = {
  hit: vi.fn((limit: RateLimit, key: string) => {
    hits.push({ limit: limit.name, key });
    if (limit.name === overLimit) {
      return Promise.reject(
        new HttpException(
          { code: 'too_many_requests', message: 'x' },
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );
    }
    return Promise.resolve();
  }),
};

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
      MailModule.forRoot(null),
      PublicBookingModule.forRoot({ codeKey: Buffer.alloc(32) }),
    ],
  })
    .overrideProvider(TenancyService)
    .useValue({})
    .overrideProvider(PublicBookingService)
    .useValue(service)
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
  hits.length = 0;
  overLimit = null;
});

const post = (path: string, body: object) =>
  request(server)
    .post(`${BASE}${path}`)
    .set('origin', ORIGIN)
    .set('x-forwarded-for', '203.0.113.7')
    .send(body);

describe('the public booking page api (no session)', () => {
  it('shows the page by slug, counted per address', async () => {
    const response = await request(server)
      .get(BASE)
      .set('x-forwarded-for', '203.0.113.7')
      .expect(200);
    expect(PublicBusinessSchema.parse(response.body)).toEqual(BUSINESS);
    expect(service.business).toHaveBeenCalledWith('juniper');
    expect(hits).toEqual([{ limit: 'page-read', key: '203.0.113.7' }]);
  });

  it('404 booking_page_not_found for an unknown page', async () => {
    service.business.mockRejectedValueOnce(new BookingPageNotFoundError());
    const response = await request(server).get('/v1/public/businesses/nobody').expect(404);
    expect(ApiErrorSchema.parse(response.body).code).toBe('booking_page_not_found');
  });

  it('lists free times for a service', async () => {
    const response = await request(server)
      .get(`${BASE}/availability`)
      .query({
        serviceId: SERVICE_ID,
        from: '2026-11-03T05:00:00.000Z',
        to: '2026-11-04T05:00:00.000Z',
      })
      .expect(200);
    expect(response.body).toEqual({ slots: [SLOT], truncated: false });
  });

  it('asks for a code: 201, counted per address and per business', async () => {
    const response = await post('/booking-requests', ASK).expect(201);
    expect(BookingRequestResponseSchema.parse(response.body).requestId).toBe(REQUEST_ID);
    expect(service.request).toHaveBeenCalledWith(
      'juniper',
      { ...ASK, email: 'ana@example.test', phone: null, smsConsent: null },
      undefined,
    );
    expect(hits).toEqual([
      { limit: 'request-ip', key: '203.0.113.7' },
      { limit: 'request-biz', key: 'juniper' },
    ]);
  });

  it('passes a ticked SMS box on, and refuses one with a number Pepper can’t text (AC-X-64)', async () => {
    await post('/booking-requests', {
      ...ASK,
      phone: '+15552345678',
      smsConsent: 'sms-consent-v1',
    }).expect(201);
    expect(service.request).toHaveBeenCalledWith(
      'juniper',
      expect.objectContaining({ phone: '+15552345678', smsConsent: 'sms-consent-v1' }),
      undefined,
    );
    service.request.mockClear();
    const refused = await post('/booking-requests', {
      ...ASK,
      phone: '+447700900123',
      smsConsent: 'sms-consent-v1',
    }).expect(400);
    expect(refused.body).toMatchObject({ code: 'validation_failed' });
    expect(service.request).not.toHaveBeenCalled();
  });

  it('refuses a request body with a tenant id, naming the field only', async () => {
    const response = await post('/booking-requests', { ...ASK, tenantId: SERVICE_ID }).expect(400);
    expect(response.body).toMatchObject({ code: 'validation_failed' });
    expect(service.request).not.toHaveBeenCalled();
  });

  it('429 too_many_requests over a limit, before anything is stored or sent', async () => {
    overLimit = 'request-biz';
    await post('/booking-requests', ASK).expect(429);
    expect(service.request).not.toHaveBeenCalled();
  });

  it('403 forbidden_origin for a write from another site', async () => {
    await request(server)
      .post(`${BASE}/booking-requests`)
      .set('origin', 'https://evil.example')
      .send(ASK)
      .expect(403);
    expect(service.request).not.toHaveBeenCalled();
  });

  it('409 slot_unavailable with the alternatives', async () => {
    service.request.mockRejectedValueOnce(new SlotUnavailableError([SLOT]));
    const response = await post('/booking-requests', ASK).expect(409);
    expect(response.body).toMatchObject({ code: 'slot_unavailable', alternatives: [SLOT] });
  });

  it('confirms with the code: 201 with the booking and its link secret', async () => {
    const response = await post(`/booking-requests/${REQUEST_ID}/confirm`, {
      code: '042917',
    }).expect(201);
    expect(BookingConfirmResponseSchema.parse(response.body)).toEqual({
      booking: BOOKING,
      manageToken: TOKEN,
    });
    expect(service.confirm).toHaveBeenCalledWith(
      'juniper',
      REQUEST_ID,
      { code: '042917' },
      undefined,
    );
    expect(hits).toEqual([{ limit: 'confirm-ip', key: '203.0.113.7' }]);
  });

  it('passes the remembered-device cookie on with the request (S47)', async () => {
    const device = 'd'.repeat(43);
    await request(server)
      .post(`${BASE}/booking-requests`)
      .set('origin', ORIGIN)
      .set('cookie', `pepper_device=${device}`)
      .send(ASK)
      .expect(201);
    expect(service.request).toHaveBeenCalledWith('juniper', expect.anything(), device);
  });

  it('renews the device cookie when a remembered browser books (S47)', async () => {
    const device = 'd'.repeat(43);
    service.request.mockResolvedValueOnce({
      response: { requestId: REQUEST_ID, expiresAt: '2026-11-02T12:10:00.000Z' },
      refreshDevice: device,
    });
    const response = await post('/booking-requests', ASK).expect(201);
    expect(response.headers['set-cookie']?.[0]).toMatch(
      new RegExp(`^pepper_device=${device}; .*Max-Age=7776000`),
    );
    expect(JSON.stringify(response.body)).not.toContain(device);
  });

  it('sets the httpOnly device cookie only when the client asked to be remembered (S47)', async () => {
    const plain = await post(`/booking-requests/${REQUEST_ID}/confirm`, { code: '042917' });
    expect(plain.headers['set-cookie']).toBeUndefined();
    service.confirm.mockResolvedValueOnce({
      response: { booking: BOOKING, manageToken: TOKEN },
      device: 'd'.repeat(43),
    });
    const remembered = await post(`/booking-requests/${REQUEST_ID}/confirm`, {
      code: '042917',
      remember: true,
    }).expect(201);
    expect(remembered.headers['set-cookie']).toEqual([
      `pepper_device=${'d'.repeat(43)}; Path=/v1/public/businesses/juniper; Max-Age=7776000; HttpOnly; SameSite=Lax`,
    ]);
    // The secret never appears in the body.
    expect(JSON.stringify(remembered.body)).not.toContain('d'.repeat(43));
    expect(service.confirm).toHaveBeenLastCalledWith(
      'juniper',
      REQUEST_ID,
      { code: '042917', remember: true },
      undefined,
    );
  });

  it('forgets the device: whether it was known, and the cookie cleared (S47)', async () => {
    const response = await request(server)
      .post(`${BASE}/device/forget`)
      .set('origin', ORIGIN)
      .set('x-forwarded-for', '203.0.113.7')
      .set('cookie', `pepper_device=${'d'.repeat(43)}`)
      .send({})
      .expect(200);
    expect(response.body).toEqual({ forgotten: true });
    expect(service.forget).toHaveBeenCalledWith('juniper', 'd'.repeat(43));
    expect(response.headers['set-cookie']?.[0]).toMatch(/^pepper_device=; .*Max-Age=0/);
    expect(hits).toEqual([{ limit: 'forget-ip', key: '203.0.113.7' }]);
  });

  it('records a booking step: 204, counted per address, nothing personal accepted (S47)', async () => {
    const visitId = '7d0c3c56-1f6e-4c56-9d8e-0f3f1b2d4a10';
    await post('/funnel', { visitId, step: 'time' }).expect(204);
    expect(service.funnelStep).toHaveBeenCalledWith('juniper', { visitId, step: 'time' });
    expect(hits).toEqual([{ limit: 'funnel-ip', key: '203.0.113.7' }]);
    await post('/funnel', { visitId, step: 'time', email: 'ana@example.test' }).expect(400);
    await post('/funnel', { visitId, step: 'paid' }).expect(400);
    await post('/funnel', { visitId: 'nope', step: 'time' }).expect(400);
    overLimit = 'funnel-ip';
    await post('/funnel', { visitId, step: 'time' }).expect(429);
    expect(service.funnelStep).toHaveBeenCalledTimes(1);
  });

  it('422 wrong_code with the attempts left', async () => {
    service.confirm.mockRejectedValueOnce(new WrongVerificationCodeError(2));
    const response = await post(`/booking-requests/${REQUEST_ID}/confirm`, {
      code: '000000',
    }).expect(422);
    expect(response.body).toMatchObject({ code: 'wrong_code', attemptsLeft: 2 });
  });

  it("asks to join the waitlist for a day: 201, under the booking requests' limits (S38a)", async () => {
    const join = {
      serviceId: SERVICE_ID,
      staffMemberId: null,
      date: '2026-11-03',
      name: 'Ana Ruiz',
      email: 'Ana@Example.test',
    };
    const response = await post('/waitlist-requests', join).expect(201);
    expect(BookingRequestResponseSchema.parse(response.body).requestId).toBe(REQUEST_ID);
    expect(service.waitlistRequest).toHaveBeenCalledWith('juniper', {
      ...join,
      email: 'ana@example.test',
      phone: null,
    });
    expect(hits).toEqual([
      { limit: 'request-ip', key: '203.0.113.7' },
      { limit: 'request-biz', key: 'juniper' },
    ]);
    await post('/waitlist-requests', { ...join, date: 'Tuesday' }).expect(400);
    await post('/waitlist-requests', { ...join, tenantId: SERVICE_ID }).expect(400);
    overLimit = 'request-ip';
    await post('/waitlist-requests', join).expect(429);
    expect(service.waitlistRequest).toHaveBeenCalledTimes(1);
  });

  it('confirms the waitlist code: 201 with the entry; a wrong code is 422', async () => {
    const response = await post(`/waitlist-requests/${REQUEST_ID}/confirm`, {
      code: '042917',
    }).expect(201);
    expect(response.body).toMatchObject({
      entry: { date: '2026-11-03', staff: { displayName: 'Jess' } },
    });
    expect(service.waitlistConfirm).toHaveBeenCalledWith('juniper', REQUEST_ID, { code: '042917' });
    expect(hits).toEqual([{ limit: 'confirm-ip', key: '203.0.113.7' }]);
    service.waitlistConfirm.mockRejectedValueOnce(new WrongVerificationCodeError(4));
    const wrong = await post(`/waitlist-requests/${REQUEST_ID}/confirm`, { code: '000000' }).expect(
      422,
    );
    expect(wrong.body).toMatchObject({ code: 'wrong_code', attemptsLeft: 4 });
  });

  it('400 for a malformed request id or code', async () => {
    await post('/booking-requests/not-an-id/confirm', { code: '042917' }).expect(400);
    await post(`/booking-requests/${REQUEST_ID}/confirm`, { code: '42' }).expect(400);
    expect(service.confirm).not.toHaveBeenCalled();
  });

  it('looks up, reschedules and cancels by the link secret in the body', async () => {
    const lookup = await post('/booking/lookup', { token: TOKEN }).expect(200);
    expect(PublicBookingResponseSchema.parse(lookup.body).booking).toEqual(BOOKING);
    await post('/booking/reschedule', { token: TOKEN, startsAt: SLOT.startsAt }).expect(200);
    expect(service.reschedule).toHaveBeenCalledWith('juniper', TOKEN, SLOT.startsAt);
    const cancelled = await post('/booking/cancel', { token: TOKEN }).expect(200);
    expect(cancelled.body).toMatchObject({ booking: { status: 'cancelled' } });
    expect(hits.map((h) => h.limit)).toEqual(['link-ip', 'link-ip', 'link-ip']);
  });

  it('400 for a malformed link secret', async () => {
    await post('/booking/lookup', { token: 'short' }).expect(400);
    expect(service.managed).not.toHaveBeenCalled();
  });

  it('reads and claims a waitlist offer by the secret in the body (S37)', async () => {
    const seen = await post('/waitlist-offer/lookup', { token: TOKEN }).expect(200);
    expect(PublicOfferResponseSchema.parse(seen.body).offer).toEqual(OFFER);
    const claimed = await post('/waitlist-offer/claim', { token: TOKEN }).expect(200);
    expect(BookingConfirmResponseSchema.parse(claimed.body)).toEqual({
      booking: BOOKING,
      manageToken: TOKEN,
    });
    expect(service.claim).toHaveBeenCalledWith('juniper', TOKEN);
    // Claims have their own tighter limit per address.
    expect(hits.map((h) => h.limit)).toEqual(['link-ip', 'claim-ip']);
  });

  it('409 waitlist_offer_taken without saying who has it; 400 for a malformed secret', async () => {
    service.claim.mockRejectedValueOnce(new WaitlistOfferTakenError());
    const taken = await post('/waitlist-offer/claim', { token: TOKEN }).expect(409);
    expect(ApiErrorSchema.parse(taken.body)).toEqual({
      code: 'waitlist_offer_taken',
      message: 'Sorry, this time has been taken',
    });
    await post('/waitlist-offer/claim', { token: 'short' }).expect(400);
    expect(service.claim).toHaveBeenCalledTimes(1);
  });
});

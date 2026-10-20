import 'reflect-metadata';
import { createECDH } from 'node:crypto';
import type { Server } from 'node:http';
import { createService, createStaffMember, replaceWorkingHours } from '@pepper/appointments';
import {
  AvailabilityResponseSchema,
  BookingConfirmResponseSchema,
  BookingRequestResponseSchema,
  PublicBookingResponseSchema,
  PublicBusinessSchema,
  TenantIdSchema,
  UserIdSchema,
  type AvailableSlot,
  type StaffMemberId,
  type TenantId,
} from '@pepper/contracts';
import {
  createBusiness,
  createClient,
  deliverOutboxMessage,
  outboxKeyFrom,
  removePushDevice,
  savePushDevice,
  systemClock,
  updateBookingPage,
  type Actor,
  type EmailMessage,
  type Mailer,
  type PushMessage,
  type Pusher,
  type TenantContext,
} from '@pepper/core';
import {
  listDueOutboxMessages,
  prepareDatabase,
  users,
  withTenant,
  type Database,
  type DatabaseHandle,
} from '@pepper/db';
import { DATABASE, MAILER } from '@pepper/runtime';
import { postgresUrlAs, startPostgres, startRedis, type TestService } from '@pepper/testing';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import { BookingsService } from './appointments/bookings.service.js';
import { loadApiConfig } from './config.js';

// The public booking page through the api against real Postgres and Redis (ADR-0022): a
// booking only after the emailed code (AC-W8-2), the link that reschedules and cancels it, and
// the Redis rate limits. Email goes to a recording mailer instead of SMTP: the code at once,
// the emails about the booking through the outbox (ADR-0024), delivered here as the worker
// would.

const ORIGIN = 'http://localhost:3000';
const OUTBOX_SECRET = 'an-integration-test-outbox-secret-32+';
const SLUG = 'plum-salon';
const DAY = 86_400_000;

class RecordingMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

let postgres: TestService;
let redis: TestService;
let app: INestApplication;
let server: Server;
let db: Database;
class RecordingPusher implements Pusher {
  readonly sent: PushMessage[] = [];
  send(message: PushMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

/** A VAPID public key (an uncompressed P-256 point), so the api turns pushes on. */
const vapid = createECDH('prime256v1');
vapid.generateKeys();

const mailer = new RecordingMailer();
const pusher = new RecordingPusher();
let serviceId: string;
let tenantId: TenantId;
/** The owner's context, for team bookings through `BookingsService`. */
let ownerContext: TenantContext;
let jessId: StaffMemberId;
let ipCounter = 0;

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
    SMTP_URL: 'smtp://127.0.0.1:1',
    VAPID_PUBLIC_KEY: vapid.getPublicKey().toString('base64url'),
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
    .overrideProvider(MAILER)
    .useValue(mailer)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  server = app.getHttpServer() as Server;
  db = app.get<DatabaseHandle>(DATABASE).db;

  // Plum Salon (UTC): a 60-minute cut with Jess, every day 09:00–17:00.
  const [owner] = await db
    .insert(users)
    .values({ name: 'Ana', email: 'owner@example.test' })
    .returning({ id: users.id });
  if (owner === undefined) throw new Error('no owner');
  const tenant = await createBusiness(db, owner.id as never, {
    name: 'Plum Salon',
    slug: SLUG,
    timeZone: 'UTC',
  });
  tenantId = TenantIdSchema.parse(tenant.id);
  ownerContext = { tenantId, userId: UserIdSchema.parse(owner.id), role: 'owner' };
  const actor: Actor = { context: ownerContext };
  await updateBookingPage(db, actor, { brandColor: '#7a3e6c' });
  const service = await createService(db, actor, { name: 'Cut', durationMinutes: 60 });
  serviceId = service.id;
  const jess = await createStaffMember(db, actor, {
    displayName: 'Jess',
    serviceIds: [service.id],
  });
  jessId = jess.id;
  await replaceWorkingHours(db, actor, jess.id, {
    intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
  });
});

afterAll(async () => {
  await app.close();
  await Promise.all([postgres.stop(), redis.stop()]);
});

beforeEach(() => {
  mailer.sent.length = 0;
});

/** Delivers the queued emails and pushes, as the worker does; returns how many were sent. */
async function deliverQueued(): Promise<number> {
  const options = { key: outboxKeyFrom(OUTBOX_SECRET), mailer, pusher, clock: systemClock };
  const results = [];
  for (const due of await listDueOutboxMessages(db, new Date(), 100)) {
    results.push(await deliverOutboxMessage(db, due, options));
  }
  return results.filter((result) => result === 'sent').length;
}

/** A visitor with their own client address, sending the app's Origin. */
function visitor() {
  ipCounter += 1;
  const ip = `198.51.100.${String(ipCounter)}`;
  return {
    get: (path: string) =>
      request(server).get(`/v1/public/businesses/${SLUG}${path}`).set('x-forwarded-for', ip),
    post: (path: string, body: object) =>
      request(server)
        .post(`/v1/public/businesses/${SLUG}${path}`)
        .set('origin', ORIGIN)
        .set('x-forwarded-for', ip)
        .send(body),
  };
}

async function freeSlots(): Promise<AvailableSlot[]> {
  const from = new Date(Math.ceil(Date.now() / DAY) * DAY + DAY).toISOString();
  const to = new Date(Date.parse(from) + 2 * DAY).toISOString();
  const response = await visitor().get('/availability').query({ serviceId, from, to }).expect(200);
  return AvailabilityResponseSchema.parse(response.body).slots;
}

function codeIn(message: EmailMessage | undefined): string {
  const code = /^ {4}(\d{6})$/m.exec(message?.text ?? '')?.[1];
  if (code === undefined) throw new Error('no code in the email');
  return code;
}

/** Bookings the booking page made for the client with this email. */
async function bookedFor(email: string): Promise<number> {
  const { rows } = await withTenant(db, tenantId, (tx) =>
    tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM bookings b JOIN clients c ON c.id = b.client_id
           WHERE c.email = ${email} AND b.source = 'booking_page'`,
    ),
  );
  return rows[0]?.n ?? 0;
}

describe('the public booking page', () => {
  it('shows the business in its color, with no ids of the business itself', async () => {
    const response = await visitor().get('').expect(200);
    const page = PublicBusinessSchema.parse(response.body);
    expect(page).toMatchObject({ name: 'Plum Salon', brandColor: '#7a3e6c' });
    expect(JSON.stringify(response.body)).not.toContain('owner@example.test');
    await visitor().get('-nobody').expect(404);
  });

  it('AC-W8-2: books only after the emailed code, with a link to reschedule and cancel', async () => {
    const [slot, later] = await freeSlots();
    if (slot === undefined || later === undefined) throw new Error('no free times');
    const ana = visitor();
    const asked = await ana
      .post('/booking-requests', {
        serviceId,
        staffMemberId: null,
        startsAt: slot.startsAt,
        name: 'Ana Ruiz',
        email: 'ana.flow@example.test',
      })
      .expect(201);
    const { requestId } = BookingRequestResponseSchema.parse(asked.body);
    // The code only goes to the inbox.
    expect(Object.keys(asked.body as object).sort()).toEqual(['expiresAt', 'requestId']);
    const [codeMail] = mailer.sent;
    expect(codeMail?.to).toBe('ana.flow@example.test');
    const code = codeIn(codeMail);
    // Nothing booked before the code.
    expect(await bookedFor('ana.flow@example.test')).toBe(0);

    const wrongCode = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    const wrong = await ana
      .post(`/booking-requests/${requestId}/confirm`, { code: wrongCode })
      .expect(422);
    expect(wrong.body).toMatchObject({ code: 'wrong_code', attemptsLeft: 4 });

    const confirmed = await ana
      .post(`/booking-requests/${requestId}/confirm`, { code })
      .expect(201);
    const { booking, manageToken } = BookingConfirmResponseSchema.parse(confirmed.body);
    expect(booking).toMatchObject({
      startsAt: slot.startsAt,
      status: 'confirmed',
      changeable: true,
    });
    expect(await bookedFor('ana.flow@example.test')).toBe(1);
    // Queued with the booking, sent by the worker, exactly once.
    expect(mailer.sent).toHaveLength(1);
    expect(await deliverQueued()).toBe(1);
    expect(await deliverQueued()).toBe(0);
    const confirmation = mailer.sent.at(-1);
    expect(confirmation?.subject).toContain("You're booked");
    expect(confirmation?.text).toContain(`${ORIGIN}/book/${SLUG}/manage#${manageToken}`);
    await ana.post(`/booking-requests/${requestId}/confirm`, { code }).expect(409);

    // The taken time is no longer offered to others.
    expect((await freeSlots()).map((s) => s.startsAt)).not.toContain(slot.startsAt);

    const looked = await ana.post('/booking/lookup', { token: manageToken }).expect(200);
    expect(PublicBookingResponseSchema.parse(looked.body).booking.startsAt).toBe(slot.startsAt);
    const moved = await ana
      .post('/booking/reschedule', { token: manageToken, startsAt: later.startsAt })
      .expect(200);
    expect(moved.body).toMatchObject({ booking: { startsAt: later.startsAt } });
    expect(await deliverQueued()).toBe(1);
    expect(mailer.sent.at(-1)?.subject).toContain('has moved');
    expect(mailer.sent.at(-1)?.text).toContain(`${ORIGIN}/book/${SLUG}/manage#${manageToken}`);
    const cancelled = await ana.post('/booking/cancel', { token: manageToken }).expect(200);
    expect(cancelled.body).toMatchObject({ booking: { status: 'cancelled', changeable: false } });
    await ana.post('/booking/cancel', { token: manageToken }).expect(409);
    // The refused second cancel queued nothing.
    expect(await deliverQueued()).toBe(1);
    expect(mailer.sent.at(-1)?.subject).toContain('is cancelled');
    expect(mailer.sent.map((m) => m.to)).toEqual(Array(4).fill('ana.flow@example.test'));
    // A token for another booking or business is simply not found.
    await ana.post('/booking/lookup', { token: 'A'.repeat(43) }).expect(404);
  });

  it('limits booking requests per client address in Redis', async () => {
    const [slot] = await freeSlots();
    if (slot === undefined) throw new Error('no free times');
    const busy = visitor();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const response = await busy.post('/booking-requests', {
        serviceId,
        startsAt: slot.startsAt,
        name: 'Bo',
        email: `bo.${String(i)}@example.test`,
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('refuses writes from another site', async () => {
    await request(server)
      .post(`/v1/public/businesses/${SLUG}/booking/lookup`)
      .set('origin', 'https://evil.example')
      .send({ token: 'A'.repeat(43) })
      .expect(403);
  });
});

describe('team bookings (ADR-0025)', () => {
  it("email the client a confirmation with a link that works on the business's page", async () => {
    const [slot, later] = await freeSlots();
    if (slot === undefined || later === undefined) throw new Error('no free times');
    const bookings = app.get(BookingsService);
    const maria = await createClient(
      db,
      { context: ownerContext },
      {
        name: 'Maria Lopez',
        email: 'maria@example.test',
      },
    );
    const booking = await bookings.createBooking(ownerContext, {
      clientId: maria.id,
      serviceId,
      staffMemberId: jessId,
      startsAt: slot.startsAt,
    });
    expect(await deliverQueued()).toBe(1);
    const confirmation = mailer.sent.at(-1);
    expect(confirmation).toMatchObject({
      to: 'maria@example.test',
      subject: "You're booked at Plum Salon",
    });
    const token = new RegExp(`${ORIGIN}/book/${SLUG}/manage#([A-Za-z0-9_-]{43})`).exec(
      confirmation?.text ?? '',
    )?.[1];
    if (token === undefined) throw new Error('no link in the confirmation');
    const looked = await visitor().post('/booking/lookup', { token }).expect(200);
    expect(PublicBookingResponseSchema.parse(looked.body).booking.startsAt).toBe(slot.startsAt);

    // A move without telling the client sends nothing, and keeps the link working.
    await bookings.changeBooking(ownerContext, booking.id, {
      startsAt: later.startsAt,
      notifyClient: false,
    });
    expect(await deliverQueued()).toBe(0);
    await visitor().post('/booking/lookup', { token }).expect(200);

    await bookings.changeBooking(ownerContext, booking.id, { status: 'cancelled' });
    expect(await deliverQueued()).toBe(1);
    expect(mailer.sent.at(-1)).toMatchObject({
      to: 'maria@example.test',
      subject: 'Your booking at Plum Salon is cancelled',
    });
  });
});

describe('team pushes (ADR-0026)', () => {
  it("tell the owner's device about a booking made on the page, never naming the client; not about the team's own", async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/owner-phone';
    await savePushDevice(
      db,
      { context: ownerContext },
      {
        endpoint,
        keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) },
      },
    );
    const [slot] = await freeSlots();
    if (slot === undefined) throw new Error('no free times');
    const bea = visitor();
    const asked = await bea
      .post('/booking-requests', {
        serviceId,
        staffMemberId: jessId,
        startsAt: slot.startsAt,
        name: 'Bea Lima',
        email: 'bea.push@example.test',
      })
      .expect(201);
    const { requestId } = BookingRequestResponseSchema.parse(asked.body);
    const code = codeIn(mailer.sent.at(-1));
    await bea.post(`/booking-requests/${requestId}/confirm`, { code }).expect(201);

    pusher.sent.length = 0;
    // The client's confirmation and the owner's push.
    expect(await deliverQueued()).toBe(2);
    expect(pusher.sent).toHaveLength(1);
    const [push] = pusher.sent;
    expect(push?.endpoint).toBe(endpoint);
    const shown = JSON.parse(push?.payload ?? '{}') as Record<string, string>;
    expect(shown).toMatchObject({
      title: 'New booking',
      url: expect.stringMatching(/^\/calendar\?date=/) as string,
    });
    expect(shown['body']).toContain('Cut with Jess');
    expect(push?.payload).not.toMatch(/Bea|bea\.push/);

    // A booking the team makes itself pushes nothing.
    const [other] = await freeSlots();
    if (other === undefined) throw new Error('no free times');
    const maria = await createClient(db, { context: ownerContext }, { name: 'Maria Push' });
    await app.get(BookingsService).createBooking(ownerContext, {
      clientId: maria.id,
      serviceId,
      staffMemberId: jessId,
      startsAt: other.startsAt,
    });
    pusher.sent.length = 0;
    await deliverQueued();
    expect(pusher.sent).toEqual([]);
    await removePushDevice(db, { context: ownerContext }, { endpoint });
  });
});

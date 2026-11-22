import 'reflect-metadata';
import type { Server } from 'node:http';
import { createService, createStaffMember, replaceWorkingHours } from '@pepper/appointments';
import {
  AvailabilityResponseSchema,
  BookingConfirmResponseSchema,
  BookingIdSchema,
  BookingPaymentStartSchema,
  BookingRequestResponseSchema,
  PublicBusinessSchema,
  TenantIdSchema,
  UserIdSchema,
  type AvailableSlot,
  type TenantId,
} from '@pepper/contracts';
import {
  createBusiness,
  deliverOutboxMessage,
  outboxKeyFrom,
  systemClock,
  updateBookingPage,
  type Actor,
  type EmailMessage,
  type Mailer,
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
import { RedisSandboxAccountStore, runPaymentJob, SandboxPaymentsProvider } from '@pepper/payments';
import { DATABASE, MAILER, REDIS, type Redis } from '@pepper/runtime';
import { postgresUrlAs, startPostgres, startRedis, type TestService } from '@pepper/testing';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import { BookingsService } from './appointments/bookings.service.js';
import { loadApiConfig } from './config.js';
import { PaymentsService } from './payments/payments.service.js';

// Deposits through the api against real Postgres and Redis (S66, ADR-0068, AC-X-113…120): the
// whole app with the payments sandbox. A client sees the deposit, can't book before paying, pays
// with the sandbox's card after the code, books, and the deposit is captured; cancelling in time
// refunds it, late keeps it, the team's cancel always refunds. Queued steps are delivered here as
// the worker would, with a sandbox sharing the api's store in Redis.

const ORIGIN = 'http://localhost:3000';
const OUTBOX_SECRET = 'an-integration-test-outbox-secret-32+';
const SLUG = 'fade-deposits';
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
let sandbox: SandboxPaymentsProvider;
const mailer = new RecordingMailer();
let tenantId: TenantId;
let owner: TenantContext;
let depositServiceId: string;
let ipCounter = 0;
let emails = 0;

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
    PAYMENTS_PROVIDER: 'sandbox',
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
    .overrideProvider(MAILER)
    .useValue(mailer)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  server = app.getHttpServer() as Server;
  db = app.get<DatabaseHandle>(DATABASE).db;
  sandbox = new SandboxPaymentsProvider({
    store: new RedisSandboxAccountStore(app.get<Redis>(REDIS)),
    baseUrl: ORIGIN,
  });

  // Fade Deposits (UTC): a $40 fade with a $15 deposit and a free consult, Jess every day 9–17.
  const [user] = await db
    .insert(users)
    .values({ name: 'Ana', email: 'owner-deposits@example.test' })
    .returning({ id: users.id });
  if (user === undefined) throw new Error('no owner');
  const tenant = await createBusiness(db, UserIdSchema.parse(user.id), {
    name: 'Fade Deposits',
    slug: SLUG,
    timeZone: 'UTC',
  });
  tenantId = TenantIdSchema.parse(tenant.id);
  owner = { tenantId, userId: UserIdSchema.parse(user.id), role: 'owner' };
  const actor: Actor = { context: owner };
  const fade = await createService(db, actor, {
    name: 'Fade',
    durationMinutes: 60,
    priceFromCents: 4000,
    deposit: { kind: 'fixed', amountCents: 1500 },
  });
  depositServiceId = fade.id;
  const consult = await createService(db, actor, { name: 'Consult', durationMinutes: 30 });
  const jess = await createStaffMember(db, actor, {
    displayName: 'Jess',
    serviceIds: [fade.id, consult.id],
  });
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
    card: (body: object) =>
      request(server)
        .post('/v1/dev/payments/intent')
        .set('origin', ORIGIN)
        .set('x-forwarded-for', ip)
        .send(body),
  };
}

/** Delivers what's queued (emails, captures, refunds), as the worker does. */
async function deliverQueued(): Promise<void> {
  const options = {
    key: outboxKeyFrom(OUTBOX_SECRET),
    mailer,
    clock: systemClock,
    payments: (database: Database, tenant: TenantId, job: Parameters<typeof runPaymentJob>[2]) =>
      runPaymentJob(
        {
          db: database,
          provider: sandbox,
          clock: systemClock,
          outboxKey: outboxKeyFrom(OUTBOX_SECRET),
        },
        tenant,
        job,
      ),
  };
  for (const due of await listDueOutboxMessages(db, new Date(), 100)) {
    await deliverOutboxMessage(db, due, options);
  }
}

async function slots(serviceId: string, daysAhead: number): Promise<AvailableSlot[]> {
  const from = new Date(Math.ceil(Date.now() / DAY) * DAY + daysAhead * DAY).toISOString();
  const to = new Date(Date.parse(from) + 2 * DAY).toISOString();
  const response = await visitor().get('/availability').query({ serviceId, from, to }).expect(200);
  return AvailabilityResponseSchema.parse(response.body).slots;
}

function codeIn(message: EmailMessage | undefined): string {
  const code = /^ {4}(\d{6})$/m.exec(message?.text ?? '')?.[1];
  if (code === undefined) throw new Error('no code in the email');
  return code;
}

async function paymentStatus(bookingOrRequest: string): Promise<string | undefined> {
  const { rows } = await withTenant(db, tenantId, (tx) =>
    tx.execute<{ status: string }>(
      sql`SELECT status FROM booking_payments WHERE booking_id::text = ${bookingOrRequest} OR request_id::text = ${bookingOrRequest}`,
    ),
  );
  return rows[0]?.status;
}

/** The booking a request's payment was booked with. */
async function bookingOf(requestId: string): Promise<string> {
  const { rows } = await withTenant(db, tenantId, (tx) =>
    tx.execute<{ id: string }>(
      sql`SELECT booking_id::text AS id FROM booking_payments WHERE request_id = ${requestId}`,
    ),
  );
  return String(rows[0]?.id);
}

/** A request for the deposit service, its code, a paid deposit and the booking. */
async function bookWithDeposit(slot: AvailableSlot) {
  const client = visitor();
  emails += 1;
  const email = `client-${String(emails)}@example.test`;
  const asked = await client
    .post('/booking-requests', {
      serviceId: depositServiceId,
      staffMemberId: null,
      startsAt: slot.startsAt,
      name: 'Bea',
      email,
      phone: null,
    })
    .expect(201);
  const { requestId } = BookingRequestResponseSchema.parse(asked.body);
  const code = codeIn(mailer.sent.at(-1));
  const paid = await client.post(`/booking-requests/${requestId}/payment`, { code }).expect(200);
  const payment = BookingPaymentStartSchema.parse(paid.body);
  await client.card({ clientSecret: payment.clientSecret, outcome: 'succeeded' }).expect(204);
  const confirmed = await client
    .post(`/booking-requests/${requestId}/confirm`, { code })
    .expect(201);
  const booked = BookingConfirmResponseSchema.parse(confirmed.body);
  await deliverQueued();
  return { client, requestId, code, payment, booked, bookingId: await bookingOf(requestId) };
}

describe('deposits on the booking page (S66)', () => {
  it('AC-X-113: shows only services it can take a deposit for, with their terms', async () => {
    // Not connected yet: the deposit service isn't offered online.
    const before = PublicBusinessSchema.parse((await visitor().get('').expect(200)).body);
    expect(before.services.map((s) => s.name)).toEqual(['Consult']);
    const payments = app.get(PaymentsService);
    await payments.onboarding(owner);
    await payments.sandboxState(owner, 'ready');
    const page = PublicBusinessSchema.parse((await visitor().get('').expect(200)).body);
    expect(page.services.map((s) => [s.name, s.deposit])).toEqual([
      ['Consult', null],
      ['Fade', { kind: 'deposit', amountCents: 1500, refundHours: 24 }],
    ]);
  });

  it('AC-X-114/115: books only after the deposit is authorized, then captures it once', async () => {
    const [slot] = await slots(depositServiceId, 3);
    if (slot === undefined) throw new Error('no free time');
    const client = visitor();
    const asked = await client
      .post('/booking-requests', {
        serviceId: depositServiceId,
        staffMemberId: null,
        startsAt: slot.startsAt,
        name: 'Cara',
        email: 'cara@example.test',
        phone: null,
      })
      .expect(201);
    const { requestId } = BookingRequestResponseSchema.parse(asked.body);
    const code = codeIn(mailer.sent.at(-1));
    // No payment yet: nothing is booked.
    const unpaid = await client
      .post(`/booking-requests/${requestId}/confirm`, { code })
      .expect(402);
    expect(unpaid.body).toMatchObject({ code: 'payment_required' });
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    await client.post(`/booking-requests/${requestId}/payment`, { code: wrong }).expect(422);
    const first = BookingPaymentStartSchema.parse(
      (await client.post(`/booking-requests/${requestId}/payment`, { code }).expect(200)).body,
    );
    const again = BookingPaymentStartSchema.parse(
      (await client.post(`/booking-requests/${requestId}/payment`, { code }).expect(200)).body,
    );
    expect(again.clientSecret).toBe(first.clientSecret);
    expect(first).toMatchObject({
      provider: 'sandbox',
      terms: { kind: 'deposit', amountCents: 1500, refundHours: 24 },
      refundEndsAt: new Date(Date.parse(slot.startsAt) - DAY).toISOString(),
    });
    // A declined card books nothing.
    await client.card({ clientSecret: first.clientSecret, outcome: 'declined' }).expect(204);
    await client.post(`/booking-requests/${requestId}/confirm`, { code }).expect(402);
    await client.card({ clientSecret: 'pi_none_secret_x', outcome: 'succeeded' }).expect(404);
    await client.card({ clientSecret: first.clientSecret, outcome: 'succeeded' }).expect(204);
    BookingConfirmResponseSchema.parse(
      (await client.post(`/booking-requests/${requestId}/confirm`, { code }).expect(201)).body,
    );
    expect(await paymentStatus(requestId)).toBe('booked');
    await deliverQueued();
    expect(await paymentStatus(requestId)).toBe('captured');
  });

  it('AC-X-117: a cancel from the link in time refunds the deposit in full', async () => {
    const [slot] = await slots(depositServiceId, 4);
    if (slot === undefined) throw new Error('no free time');
    const { client, booked, bookingId } = await bookWithDeposit(slot);
    expect(await paymentStatus(bookingId)).toBe('captured');
    await client.post('/booking/cancel', { token: booked.manageToken }).expect(200);
    expect(await paymentStatus(bookingId)).toBe('refund_pending');
    await deliverQueued();
    expect(await paymentStatus(bookingId)).toBe('refunded');
  });

  it('AC-X-117: a cancel after the window keeps the deposit', async () => {
    await updateBookingPage(db, { context: owner }, { depositRefundHours: 168 });
    const [slot] = await slots(depositServiceId, 2);
    if (slot === undefined) throw new Error('no free time');
    const { client, payment, booked, bookingId } = await bookWithDeposit(slot);
    expect(payment.terms.refundHours).toBe(168);
    await client.post('/booking/cancel', { token: booked.manageToken }).expect(200);
    await deliverQueued();
    expect(await paymentStatus(bookingId)).toBe('kept');
    await updateBookingPage(db, { context: owner }, { depositRefundHours: 24 });
  });

  it('AC-X-118: the team’s cancel always refunds', async () => {
    await updateBookingPage(db, { context: owner }, { depositRefundHours: 168 });
    const [slot] = await slots(depositServiceId, 5);
    if (slot === undefined) throw new Error('no free time');
    const { bookingId } = await bookWithDeposit(slot);
    await app.get(BookingsService).changeBooking(owner, BookingIdSchema.parse(bookingId), {
      status: 'cancelled',
      notifyClient: false,
    });
    await deliverQueued();
    expect(await paymentStatus(bookingId)).toBe('refunded');
    await updateBookingPage(db, { context: owner }, { depositRefundHours: 24 });
  });

  it('AC-X-118: correcting a no-show to cancelled moves no money (review)', async () => {
    const [slot] = await slots(depositServiceId, 7);
    if (slot === undefined) throw new Error('no free time');
    const { requestId, bookingId } = await bookWithDeposit(slot);
    // As if the visit happened and the owner marked it a no-show.
    await withTenant(db, tenantId, (tx) =>
      tx.execute(sql`UPDATE bookings SET status = 'no_show' WHERE id = ${bookingId}`),
    );
    await app.get(BookingsService).changeBooking(owner, BookingIdSchema.parse(bookingId), {
      status: 'cancelled',
      notifyClient: false,
    });
    await deliverQueued();
    expect(await paymentStatus(requestId)).toBe('captured');
  });

  it('AC-X-113: while payments can’t take charges, the deposit service can’t be requested', async () => {
    const [slot] = await slots(depositServiceId, 6);
    if (slot === undefined) throw new Error('no free time');
    await app.get(PaymentsService).sandboxState(owner, 'rejected');
    const refused = await visitor()
      .post('/booking-requests', {
        serviceId: depositServiceId,
        staffMemberId: null,
        startsAt: slot.startsAt,
        name: 'Dee',
        email: 'dee@example.test',
        phone: null,
      })
      .expect(409);
    expect(refused.body).toMatchObject({ code: 'deposits_unavailable' });
    await app.get(PaymentsService).sandboxState(owner, 'ready');
  });
});

import 'reflect-metadata';
import type { Server } from 'node:http';
import { createService, createStaffMember, replaceWorkingHours } from '@pepper/appointments';
import {
  AvailabilityResponseSchema,
  BookingConfirmResponseSchema,
  BookingIdSchema,
  BookingPaymentStartSchema,
  BookingRequestResponseSchema,
  ClientIdSchema,
  PublicBookingResponseSchema,
  PublicBusinessSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  UserIdSchema,
  type AvailableSlot,
  type TenantId,
  shortDateTimeWords,
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
  insertBooking,
  insertClient,
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
let jessId: string;
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

  it('AC-X-114: a client typing a card has 30 minutes, not the code’s 10 (review)', async () => {
    const [, , slot] = await slots(depositServiceId, 6);
    if (slot === undefined) throw new Error('no free time');
    const client = visitor();
    const asked = await client
      .post('/booking-requests', {
        serviceId: depositServiceId,
        staffMemberId: null,
        startsAt: slot.startsAt,
        name: 'Dee',
        email: 'dee@example.test',
        phone: null,
      })
      .expect(201);
    const { requestId } = BookingRequestResponseSchema.parse(asked.body);
    const expiry = async () => {
      const { rows } = await withTenant(db, tenantId, (tx) =>
        tx.execute<{ at: string }>(
          sql`SELECT expires_at::text AS at FROM booking_verifications WHERE id = ${requestId}`,
        ),
      );
      return Date.parse(String(rows[0]?.at));
    };
    expect(await expiry()).toBeLessThan(Date.now() + 11 * 60_000);
    const code = codeIn(mailer.sent.at(-1));
    await client.post(`/booking-requests/${requestId}/payment`, { code }).expect(200);
    expect(await expiry()).toBeGreaterThan(Date.now() + 29 * 60_000);
  });

  it('AC-X-117: a cancel from the link in time refunds the deposit in full', async () => {
    const [slot] = await slots(depositServiceId, 4);
    if (slot === undefined) throw new Error('no free time');
    const { client, booked, bookingId } = await bookWithDeposit(slot);
    expect(await paymentStatus(bookingId)).toBe('captured');
    // AC-X-123: the manage page is told, before the cancel, that it gets the $15 back.
    const refundEndsAt = new Date(Date.parse(slot.startsAt) - DAY).toISOString();
    expect(booked.booking.deposit).toEqual({
      kind: 'deposit',
      amountCents: 1500,
      refundEndsAt,
      status: 'held',
      refundableNow: true,
    });
    const looked = await client.post('/booking/lookup', { token: booked.manageToken }).expect(200);
    expect(PublicBookingResponseSchema.parse(looked.body).booking.deposit).toMatchObject({
      status: 'held',
      refundableNow: true,
    });
    const cancelled = await client
      .post('/booking/cancel', { token: booked.manageToken })
      .expect(200);
    expect(PublicBookingResponseSchema.parse(cancelled.body).booking.deposit).toMatchObject({
      status: 'refunding',
      refundableNow: false,
    });
    expect(await paymentStatus(bookingId)).toBe('refund_pending');
    await deliverQueued();
    expect(await paymentStatus(bookingId)).toBe('refunded');
    const after = await client.post('/booking/lookup', { token: booked.manageToken }).expect(200);
    expect(PublicBookingResponseSchema.parse(after.body).booking.deposit).toMatchObject({
      status: 'refunded',
    });
  });

  it('AC-X-117: a cancel after the window keeps the deposit', async () => {
    await updateBookingPage(db, { context: owner }, { depositRefundHours: 168 });
    const [slot] = await slots(depositServiceId, 2);
    if (slot === undefined) throw new Error('no free time');
    const { client, payment, booked, bookingId } = await bookWithDeposit(slot);
    expect(payment.terms.refundHours).toBe(168);
    expect(payment.publishableKey).toBeNull();
    // AC-X-123: the window has passed, so the page says the deposit is kept, before and after.
    expect(booked.booking.deposit).toMatchObject({ status: 'held', refundableNow: false });
    const cancelled = await client
      .post('/booking/cancel', { token: booked.manageToken })
      .expect(200);
    expect(PublicBookingResponseSchema.parse(cancelled.body).booking.deposit).toMatchObject({
      status: 'kept',
      amountCents: 1500,
    });
    await deliverQueued();
    expect(await paymentStatus(bookingId)).toBe('kept');
    await updateBookingPage(db, { context: owner }, { depositRefundHours: 24 });
  });

  it('AC-X-117: moving the booking inside the window doesn’t win the deposit back (security review)', async () => {
    await updateBookingPage(db, { context: owner }, { depositRefundHours: 48 });
    const [slot] = await slots(depositServiceId, 0);
    const [far] = await slots(depositServiceId, 8);
    if (slot === undefined || far === undefined) throw new Error('no free time');
    const { client, booked, bookingId } = await bookWithDeposit(slot);
    await client
      .post('/booking/reschedule', { token: booked.manageToken, startsAt: far.startsAt })
      .expect(200);
    await client.post('/booking/cancel', { token: booked.manageToken }).expect(200);
    await deliverQueued();
    expect(await paymentStatus(bookingId)).toBe('kept');
    await updateBookingPage(db, { context: owner }, { depositRefundHours: 24 });
  });

  it('AC-X-134: the confirmation email says the deposit in the team sheet’s words', async () => {
    const [slot] = await slots(depositServiceId, 3);
    if (slot === undefined) throw new Error('no free time');
    const { booked } = await bookWithDeposit(slot);
    const refundEndsAt = booked.booking.deposit?.refundEndsAt ?? '';
    const confirmation = [...mailer.sent]
      .reverse()
      .find((m) => m.subject.startsWith("You're booked"));
    expect(confirmation?.text).toContain(
      `$15 deposit paid · refundable until ${shortDateTimeWords('UTC', refundEndsAt)}`,
    );
  });

  it('AC-X-135: a late cancel and a no-show under a policy with fees move no more money', async () => {
    const fee = { kind: 'fixed', amountCents: 2000 } as const;
    await updateBookingPage(
      db,
      { context: owner },
      { depositRefundHours: 168, cancellationFees: { lateCancel: fee, noShow: fee } },
    );
    const [late, missed] = await slots(depositServiceId, 4);
    if (late === undefined || missed === undefined) throw new Error('no free time');
    const first = await bookWithDeposit(late);
    await first.client.post('/booking/cancel', { token: first.booked.manageToken }).expect(200);
    const second = await bookWithDeposit(missed);
    await withTenant(db, tenantId, (tx) =>
      tx.execute(sql`UPDATE bookings SET status = 'no_show' WHERE id = ${second.bookingId}`),
    );
    await deliverQueued();
    const { rows } = await withTenant(db, tenantId, (tx) =>
      tx.execute<{ status: string; amount: number }>(
        sql`SELECT status, amount_cents AS amount FROM booking_payments WHERE booking_id IN (${first.bookingId}, ${second.bookingId}) ORDER BY created_at`,
      ),
    );
    // The deposits stay what they were (kept, captured); no fee was added or charged.
    expect(rows).toEqual([
      { status: 'kept', amount: 1500 },
      { status: 'captured', amount: 1500 },
    ]);
    await updateBookingPage(
      db,
      { context: owner },
      { depositRefundHours: 24, cancellationFees: null },
    );
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

  it("AC-X-129: the team reads the booking's deposit; staff can't", async () => {
    const [, , , slot] = await slots(depositServiceId, 5);
    if (slot === undefined) throw new Error('no free time');
    const { bookingId } = await bookWithDeposit(slot);
    const payments = app.get(PaymentsService);
    expect(await payments.bookingDeposit(owner, BookingIdSchema.parse(bookingId))).toEqual({
      kind: 'deposit',
      amountCents: 1500,
      refundEndsAt: new Date(Date.parse(slot.startsAt) - DAY).toISOString(),
      status: 'held',
      refundableNow: true,
    });
    await expect(
      payments.bookingDeposit({ ...owner, role: 'staff' }, BookingIdSchema.parse(bookingId)),
    ).rejects.toThrow();
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

describe('who pays a deposit (S67, ADR-0068 amendment)', () => {
  const HOUR = 3_600_000;

  beforeAll(async () => {
    await app.get(PaymentsService).sandboxState(owner, 'ready');
    await updateBookingPage(db, { context: owner }, { depositAudience: 'new_and_no_show' });
  });

  afterAll(async () => {
    await updateBookingPage(db, { context: owner }, { depositAudience: 'everyone' });
  });

  /** A client of the business with one visit that ended `daysAgo` days ago, in `status`. */
  async function clientWithVisit(status: 'confirmed' | 'completed' | 'no_show', daysAgo: number) {
    emails += 1;
    const email = `known-${String(emails)}@example.test`;
    await withTenant(db, tenantId, async (tx) => {
      const client = await insertClient(tx, { name: 'Rae', email, phone: null, source: 'team' });
      // Each past visit at its own hour, so two never overlap for Jess.
      const start = new Date(
        Math.floor(Date.now() / DAY) * DAY - daysAgo * DAY - (emails % 200) * DAY - HOUR,
      );
      const row = await insertBooking(tx, {
        clientId: ClientIdSchema.parse(client.id),
        serviceId: ServiceIdSchema.parse(depositServiceId),
        staffMemberId: StaffMemberIdSchema.parse(jessId),
        startsAt: start,
        endsAt: new Date(start.getTime() + HOUR),
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        priceFromCents: 4000,
        priceToCents: null,
        source: 'team',
        overridden: false,
        idempotencyKey: null,
        createdBy: null,
      });
      if (status !== 'confirmed') {
        await tx.execute(sql`UPDATE bookings SET status = ${status} WHERE id = ${row.id}`);
      }
    });
    return email;
  }

  async function ask(email: string, slot: AvailableSlot, cookie?: string) {
    const client = visitor();
    let call = request(server)
      .post(`/v1/public/businesses/${SLUG}/booking-requests`)
      .set('origin', ORIGIN)
      .set('x-forwarded-for', `198.51.100.${String((ipCounter += 1))}`);
    if (cookie !== undefined) call = call.set('cookie', cookie);
    const asked = await call
      .send({
        serviceId: depositServiceId,
        staffMemberId: null,
        startsAt: slot.startsAt,
        name: 'Rae',
        email,
        phone: null,
      })
      .expect(201);
    return { client, asked };
  }

  it('AC-X-126/127: a regular books with no payment once the code proves the email', async () => {
    const [slot] = await slots(depositServiceId, 8);
    if (slot === undefined) throw new Error('no free time');
    const email = await clientWithVisit('completed', 30);
    const { client, asked } = await ask(email, slot);
    const { requestId } = BookingRequestResponseSchema.parse(asked.body);
    const code = codeIn(mailer.sent.at(-1));
    const exempt = await client.post(`/booking-requests/${requestId}/payment`, { code });
    expect(exempt.status).toBe(409);
    expect(exempt.body).toMatchObject({ code: 'payment_not_needed' });
    await client.post(`/booking-requests/${requestId}/confirm`, { code }).expect(201);
    expect(await paymentStatus(requestId)).toBeUndefined();
  });

  it('AC-X-126: a visit that ended without being marked completed makes a regular too', async () => {
    const [, slot] = await slots(depositServiceId, 8);
    if (slot === undefined) throw new Error('no free time');
    const { client, asked } = await ask(await clientWithVisit('confirmed', 3), slot);
    const { requestId } = BookingRequestResponseSchema.parse(asked.body);
    const code = codeIn(mailer.sent.at(-1));
    await client.post(`/booking-requests/${requestId}/payment`, { code }).expect(409);
  });

  it('AC-X-126: a new client, and a client with a recent no-show, pay', async () => {
    const [, , slot] = await slots(depositServiceId, 8);
    if (slot === undefined) throw new Error('no free time');
    emails += 1;
    for (const email of [
      `new-${String(emails)}@example.test`,
      await clientWithVisit('no_show', 60),
    ]) {
      const { client, asked } = await ask(email, slot);
      const { requestId } = BookingRequestResponseSchema.parse(asked.body);
      const code = codeIn(mailer.sent.at(-1));
      await client.post(`/booking-requests/${requestId}/payment`, { code }).expect(200);
      await client.post(`/booking-requests/${requestId}/confirm`, { code }).expect(402);
    }
  });

  it('AC-X-127: before the code, a regular and a stranger get the same answer', async () => {
    const [, , , slot] = await slots(depositServiceId, 8);
    if (slot === undefined) throw new Error('no free time');
    emails += 1;
    const stranger = await ask(`stranger-${String(emails)}@example.test`, slot);
    const regular = await ask(await clientWithVisit('completed', 10), slot);
    expect(Object.keys(regular.asked.body as object).sort()).toEqual(
      Object.keys(stranger.asked.body as object).sort(),
    );
    expect(regular.asked.body).not.toHaveProperty('confirmed');
  });

  it('AC-X-127: a no-show marked after the code makes them pay at confirm', async () => {
    const [slot] = await slots(depositServiceId, 9);
    if (slot === undefined) throw new Error('no free time');
    const email = await clientWithVisit('completed', 30);
    const { client, asked } = await ask(email, slot);
    const { requestId } = BookingRequestResponseSchema.parse(asked.body);
    const code = codeIn(mailer.sent.at(-1));
    await client.post(`/booking-requests/${requestId}/payment`, { code }).expect(409);
    await withTenant(db, tenantId, (tx) =>
      tx.execute(
        sql`UPDATE bookings SET status = 'no_show' WHERE client_id = (SELECT id FROM clients WHERE email = ${email})`,
      ),
    );
    const refused = await client.post(`/booking-requests/${requestId}/confirm`, { code });
    expect(refused.status).toBe(402);
    expect(refused.body).toMatchObject({ code: 'payment_required' });
  });

  it('AC-X-127: a remembered regular is confirmed at once, with no code email', async () => {
    const [slot] = await slots(depositServiceId, 10);
    const [later] = await slots(depositServiceId, 12);
    if (slot === undefined || later === undefined) throw new Error('no free time');
    const email = await clientWithVisit('completed', 30);
    const first = await ask(email, slot);
    const { requestId } = BookingRequestResponseSchema.parse(first.asked.body);
    const code = codeIn(mailer.sent.at(-1));
    const confirmed = await first.client
      .post(`/booking-requests/${requestId}/confirm`, { code, remember: true })
      .expect(201);
    const cookie = (confirmed.headers['set-cookie']?.[0] ?? '').split(';')[0];
    expect(cookie).not.toBe('');
    const sent = mailer.sent.length;
    const again = await ask(email, later, cookie);
    expect(again.asked.body).toHaveProperty('confirmed');
    // No code email: the confirmation goes through the outbox.
    expect(mailer.sent.length).toBe(sent);
  });
});

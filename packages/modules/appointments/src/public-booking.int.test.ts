import { randomBytes } from 'node:crypto';
import {
  ManageTokenSchema,
  MAX_VERIFICATION_ATTEMPTS,
  TenantIdSchema,
  VerificationCodeSchema,
  type BookingRequestInput,
  type ManageToken,
  type Service,
  type StaffMember,
  type TenantId,
  type TenantSlug,
  type VerificationCode,
} from '@pepper/contracts';
import {
  createBusiness,
  createClient,
  listClients,
  ManualClock,
  updateBookingPage,
  type Actor,
} from '@pepper/core';
import { findCurrentTenant, listAuditEntries, withTenant, type Database } from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BookingNotChangeableError,
  BookingNotFoundError,
  BookingPageNotFoundError,
  BookingRequestExpiredError,
  BookingRequestNotFoundError,
  BookingRequestUsedError,
  ServiceNotFoundError,
  SlotUnavailableError,
  TooManyBookingRequestsError,
  WaitlistDayTooFarError,
  WaitlistExpiredError,
  WrongVerificationCodeError,
} from './errors.js';
import { createBooking, listBookings } from './services/bookings.js';
import { replaceWorkingHours } from './services/hours.js';
import {
  cancelManagedBooking,
  codeHash,
  confirmBookingRequest,
  findPublicAvailability,
  getManagedBooking,
  getPublicBusiness,
  MAX_REQUESTS_PER_EMAIL_PER_HOUR,
  confirmWaitlistJoin,
  requestBooking,
  requestWaitlistJoin,
  rescheduleManagedBooking,
} from './services/public-booking.js';
import { addToWaitlist, listWaitlist } from './services/waitlist.js';
import type { BookingNotice, BookingNotify } from './services/notices.js';
import { createService, updateService } from './services/services.js';
import { createStaffMember } from './services/staff.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The public booking page through the domain services, against real Postgres (ADR-0022): a
// booking only after the emailed code (AC-W8-2), the attempt cap, the link scoped to one
// booking, and exactly one winner for the last slot (AC-W8-1).

let database: TestDatabase;
let db: Database;
let slugs = 0;

const KEY = randomBytes(32);

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

// Monday 2 November 2026, 07:00 in New York (EST).
const NOW = '2026-11-02T12:00:00.000Z';
/** Tuesday 3 November, `HH:MM` in New York (UTC-5). */
const tue = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, 3, (h ?? 0) + 5, m ?? 0)).toISOString();
};

interface Page {
  slug: TenantSlug;
  tenantId: TenantId;
  owner: Actor;
  service: Service;
  hidden: Service;
  jess: StaffMember;
  marco: StaffMember;
  clock: ManualClock;
}

/**
 * Juniper: a 60-minute haircut that Jess and Marco offer (Monday–Friday 09:00–17:00), and a
 * colour service nobody offers. Default rules: 15-minute slots, 2 hours' notice.
 */
async function newPage(): Promise<Page> {
  slugs += 1;
  const slug = `juniper-page-${String(slugs)}`;
  const ownerId = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Juniper Hair Studio',
    slug,
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const owner: Actor = { context: { tenantId, userId: ownerId, role: 'owner' } };
  const service = await createService(db, owner, {
    name: 'Haircut',
    durationMinutes: 60,
    priceFromCents: 6500,
  });
  const hidden = await createService(db, owner, { name: 'Colour', durationMinutes: 90 });
  const jess = await createStaffMember(db, owner, {
    displayName: 'Jess',
    serviceIds: [service.id],
  });
  const marco = await createStaffMember(db, owner, {
    displayName: 'Marco',
    serviceIds: [service.id],
  });
  const week = {
    intervals: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
  };
  await replaceWorkingHours(db, owner, jess.id, week);
  await replaceWorkingHours(db, owner, marco.id, week);
  return { slug, tenantId, owner, service, hidden, jess, marco, clock: new ManualClock(NOW) };
}

function ask(p: Page, extra: Partial<BookingRequestInput> = {}): BookingRequestInput {
  return {
    serviceId: p.service.id,
    staffMemberId: p.jess.id,
    startsAt: tue('10:00'),
    name: 'Ana Ruiz',
    email: 'ana@example.test',
    ...extra,
  };
}

function request(p: Page, extra: Partial<BookingRequestInput> = {}) {
  return requestBooking(db, p.slug, ask(p, extra), { codeKey: KEY, clock: p.clock });
}

function confirm(p: Page, requestId: string, code: VerificationCode, startsAt?: string) {
  return confirmBookingRequest(
    db,
    p.slug,
    requestId as never,
    { code, startsAt },
    {
      codeKey: KEY,
      clock: p.clock,
    },
  );
}

/** A code that is not `code`. */
function wrong(code: VerificationCode): VerificationCode {
  return VerificationCodeSchema.parse(String((Number(code) + 1) % 1_000_000).padStart(6, '0'));
}

async function bookingsOf(p: Page) {
  return listBookings(db, p.owner, { from: tue('00:00'), to: '2026-11-10T00:00:00.000Z' });
}

async function auditOf(tenantId: TenantId) {
  return withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 100 }));
}

async function book(p: Page, extra: Partial<BookingRequestInput> = {}) {
  const asked = await request(p, extra);
  return confirm(p, asked.requestId, asked.code);
}

describe('getPublicBusiness', () => {
  it('shows the page: name, color, the services someone offers and who offers them', async () => {
    const p = await newPage();
    await updateBookingPage(db, p.owner, { brandColor: '#7a3e6c' });
    const business = await getPublicBusiness(db, p.slug);
    expect(business).toEqual({
      name: 'Juniper Hair Studio',
      slug: p.slug,
      timeZone: 'America/New_York',
      brandColor: '#7a3e6c',
      services: [
        {
          id: p.service.id,
          name: 'Haircut',
          category: null,
          durationMinutes: 60,
          priceFromCents: 6500,
          priceToCents: null,
        },
      ],
      staff: [
        { id: p.jess.id, displayName: 'Jess', color: p.jess.color, serviceIds: [p.service.id] },
        { id: p.marco.id, displayName: 'Marco', color: p.marco.color, serviceIds: [p.service.id] },
      ],
    });
  });

  it('hides a service that is not bookable', async () => {
    const p = await newPage();
    await updateService(db, p.owner, p.service.id, {
      name: 'Haircut',
      durationMinutes: 60,
      active: false,
    });
    const business = await getPublicBusiness(db, p.slug);
    expect([business.services, business.staff]).toEqual([[], []]);
  });

  it.each(['no-such-page', 'Not A Slug', ''])('has no page at %j', async (slug) => {
    await expect(getPublicBusiness(db, slug)).rejects.toBeInstanceOf(BookingPageNotFoundError);
  });
});

describe('findPublicAvailability', () => {
  it('offers free times with one staff member, and once per time with anyone', async () => {
    const p = await newPage();
    const range = { serviceId: p.service.id, from: tue('09:00'), to: tue('10:00') };
    const jess = await findPublicAvailability(
      db,
      p.slug,
      { ...range, staffMemberId: p.jess.id },
      { clock: p.clock },
    );
    const anyone = await findPublicAvailability(db, p.slug, range, { clock: p.clock });
    expect(jess.map((s) => s.startsAt)).toEqual([
      tue('09:00'),
      tue('09:15'),
      tue('09:30'),
      tue('09:45'),
    ]);
    expect(anyone.map((s) => s.startsAt)).toEqual(jess.map((s) => s.startsAt));
  });

  it('refuses a service that is not bookable', async () => {
    const p = await newPage();
    await updateService(db, p.owner, p.service.id, {
      name: 'Haircut',
      durationMinutes: 60,
      active: false,
    });
    await expect(
      findPublicAvailability(
        db,
        p.slug,
        { serviceId: p.service.id, from: tue('09:00'), to: tue('10:00') },
        { clock: p.clock },
      ),
    ).rejects.toBeInstanceOf(ServiceNotFoundError);
  });
});

describe('requestBooking', () => {
  it('books nothing yet: it stores the request with a hashed code to email', async () => {
    const p = await newPage();
    const asked = await request(p);
    expect(asked).toMatchObject({
      expiresAt: '2026-11-02T12:10:00.000Z',
      email: {
        businessName: 'Juniper Hair Studio',
        serviceName: 'Haircut',
        staffName: 'Jess',
        startsAt: tue('10:00'),
        email: 'ana@example.test',
      },
    });
    expect(asked.code).toMatch(/^\d{6}$/);
    expect(await bookingsOf(p)).toEqual([]);
    const stored = await withTenant(db, p.tenantId, (tx) =>
      tx.execute<{ code_hash: string }>(`SELECT code_hash FROM booking_verifications`),
    );
    expect(stored.rows).toEqual([{ code_hash: codeHash(KEY, 'ana@example.test', asked.code) }]);
  });

  it('refuses a time that is not free, with the nearest free times', async () => {
    const p = await newPage();
    const error = await request(p, { startsAt: tue('08:00') }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SlotUnavailableError);
    expect((error as SlotUnavailableError).alternatives.map((s) => s.startsAt)).toEqual([
      tue('09:00'),
      tue('09:15'),
      tue('09:30'),
    ]);
  });

  it(`allows ${String(MAX_REQUESTS_PER_EMAIL_PER_HOUR)} requests per email address an hour`, async () => {
    const p = await newPage();
    for (let i = 0; i < MAX_REQUESTS_PER_EMAIL_PER_HOUR; i++) await request(p);
    await expect(request(p, { email: 'ANA@example.test' })).rejects.toBeInstanceOf(
      TooManyBookingRequestsError,
    );
    await expect(request(p, { email: 'bo@example.test' })).resolves.toBeDefined();
    p.clock.advanceBy(61 * 60_000);
    await expect(request(p, { startsAt: tue('11:00') })).resolves.toBeDefined();
  });
});

describe('confirmBookingRequest', () => {
  it('books the time with the right code: new client, system audit, link token', async () => {
    const p = await newPage();
    const asked = await request(p, { phone: '+15551234567' });
    const confirmed = await confirm(p, asked.requestId, asked.code);
    expect(ManageTokenSchema.safeParse(confirmed.manageToken).success).toBe(true);
    expect(confirmed.booking).toEqual({
      status: 'confirmed',
      startsAt: tue('10:00'),
      endsAt: tue('11:00'),
      service: { id: p.service.id, name: 'Haircut' },
      staff: { id: p.jess.id, displayName: 'Jess' },
      changeable: true,
    });
    const [booking] = await bookingsOf(p);
    expect(booking).toMatchObject({ source: 'booking_page', staffMemberId: p.jess.id });
    const [client] = await listClients(db, p.owner, {});
    expect(client).toMatchObject({
      name: 'Ana Ruiz',
      email: 'ana@example.test',
      phone: '+15551234567',
      source: 'booking_page',
    });
    const audit = await auditOf(p.tenantId);
    expect(audit.slice(0, 2).map((e) => [e.action, e.actor])).toEqual([
      ['booking.created', { kind: 'system', userId: null }],
      ['client.created', { kind: 'system', userId: null }],
    ]);
  });

  it('books a returning client by their email, keeping the details the business has', async () => {
    const p = await newPage();
    const existing = await createClient(db, p.owner, {
      name: 'Ana Ruiz-Lopez',
      email: 'ana@example.test',
    });
    await book(p, { name: 'Someone Else' });
    const [booking] = await bookingsOf(p);
    expect(booking?.clientId).toBe(existing.id);
    expect((await listClients(db, p.owner, {})).map((c) => c.name)).toEqual(['Ana Ruiz-Lopez']);
  });

  it(`counts wrong codes and stops after ${String(MAX_VERIFICATION_ATTEMPTS)}`, async () => {
    const p = await newPage();
    const asked = await request(p);
    for (let left = MAX_VERIFICATION_ATTEMPTS - 1; left > 0; left--) {
      const error = await confirm(p, asked.requestId, wrong(asked.code)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WrongVerificationCodeError);
      expect((error as WrongVerificationCodeError).attemptsLeft).toBe(left);
    }
    await expect(confirm(p, asked.requestId, wrong(asked.code))).rejects.toBeInstanceOf(
      BookingRequestExpiredError,
    );
    // Even the right code no longer works.
    await expect(confirm(p, asked.requestId, asked.code)).rejects.toBeInstanceOf(
      BookingRequestExpiredError,
    );
    expect(await bookingsOf(p)).toEqual([]);
  });

  it('refuses an expired code, a used one and an unknown request', async () => {
    const p = await newPage();
    const late = await request(p);
    p.clock.advanceBy(10 * 60_000);
    await expect(confirm(p, late.requestId, late.code)).rejects.toBeInstanceOf(
      BookingRequestExpiredError,
    );
    const asked = await request(p);
    await confirm(p, asked.requestId, asked.code);
    await expect(confirm(p, asked.requestId, asked.code)).rejects.toBeInstanceOf(
      BookingRequestUsedError,
    );
    await expect(
      confirm(p, '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708196', asked.code),
    ).rejects.toBeInstanceOf(BookingRequestNotFoundError);
  });

  it("a request is found only through its own business's page", async () => {
    const p = await newPage();
    const other = await newPage();
    const asked = await request(p);
    await expect(confirm(other, asked.requestId, asked.code)).rejects.toBeInstanceOf(
      BookingRequestNotFoundError,
    );
  });

  it('offers the nearest times when the time was taken meanwhile', async () => {
    const p = await newPage();
    const asked = await request(p);
    const client = await createClient(db, p.owner, { name: 'Maria' });
    await createBooking(
      db,
      p.owner,
      {
        clientId: client.id,
        serviceId: p.service.id,
        staffMemberId: p.jess.id,
        startsAt: tue('10:00'),
      },
      { clock: p.clock },
    );
    const error = await confirm(p, asked.requestId, asked.code).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SlotUnavailableError);
    // Equally near 09:00 and 11:00 (earlier first), then 11:15.
    expect((error as SlotUnavailableError).alternatives.map((s) => s.startsAt)).toEqual([
      tue('09:00'),
      tue('11:00'),
      tue('11:15'),
    ]);
  });

  it('the same code confirms an alternative instead, without another email', async () => {
    const p = await newPage();
    const asked = await request(p);
    await book(p, { email: 'first@example.test' });
    const refused = await confirm(p, asked.requestId, asked.code).catch((e: unknown) => e);
    const [alternative] = (refused as SlotUnavailableError).alternatives;
    if (alternative === undefined) throw new Error('no alternative');
    const booked = await confirm(p, asked.requestId, asked.code, alternative.startsAt);
    expect(booked.booking.startsAt).toBe(alternative.startsAt);
    await expect(confirm(p, asked.requestId, asked.code)).rejects.toBeInstanceOf(
      BookingRequestUsedError,
    );
  });

  it('with anyone, books whoever is free', async () => {
    const p = await newPage();
    await book(p, { email: 'first@example.test' });
    const second = await book(p, { staffMemberId: null, email: 'second@example.test' });
    expect(second.booking.staff.id).toBe(p.marco.id);
    await expect(book(p, { staffMemberId: null })).rejects.toBeInstanceOf(SlotUnavailableError);
  });

  it('AC-W8-1: two clients confirming the last slot at once, exactly one books it', async () => {
    const p = await newPage();
    const [a, b] = [
      await request(p, { email: 'a@example.test' }),
      await request(p, { email: 'b@example.test' }),
    ];
    const results = await Promise.allSettled([
      confirm(p, a.requestId, a.code),
      confirm(p, b.requestId, b.code),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [refused] = results.filter((r) => r.status === 'rejected');
    expect(refused?.reason).toBeInstanceOf(SlotUnavailableError);
    expect((refused?.reason as SlotUnavailableError).alternatives).toHaveLength(3);
    expect(await bookingsOf(p)).toHaveLength(1);
  });
});

describe('the reschedule/cancel link', () => {
  async function linked(p: Page): Promise<ManageToken> {
    return (await book(p)).manageToken;
  }

  it('shows the booking behind the link, and nothing for another token or business', async () => {
    const p = await newPage();
    const token = await linked(p);
    expect(await getManagedBooking(db, p.slug, token, { clock: p.clock })).toMatchObject({
      startsAt: tue('10:00'),
      changeable: true,
    });
    const other = ManageTokenSchema.parse(randomBytes(32).toString('base64url'));
    await expect(getManagedBooking(db, p.slug, other)).rejects.toBeInstanceOf(BookingNotFoundError);
    const elsewhere = await newPage();
    await expect(getManagedBooking(db, elsewhere.slug, token)).rejects.toBeInstanceOf(
      BookingNotFoundError,
    );
  });

  it('reschedules to a free time with the same staff member, audited as the system', async () => {
    const p = await newPage();
    const token = await linked(p);
    const moved = await rescheduleManagedBooking(db, p.slug, token, tue('14:00'), {
      clock: p.clock,
    });
    expect(moved.booking).toMatchObject({ startsAt: tue('14:00'), staff: { id: p.jess.id } });
    expect(moved.email).toMatchObject({ email: 'ana@example.test', clientName: 'Ana Ruiz' });
    const [entry] = await auditOf(p.tenantId);
    expect(entry).toMatchObject({ action: 'booking.updated', actor: { kind: 'system' } });
    // Its old time is free again; overlapping its own old time is fine.
    await expect(
      rescheduleManagedBooking(db, p.slug, token, tue('14:30'), { clock: p.clock }),
    ).resolves.toBeDefined();
  });

  it('refuses a time that is not free, with alternatives', async () => {
    const p = await newPage();
    const token = await linked(p);
    await book(p, { startsAt: tue('15:00'), email: 'bo@example.test' });
    await expect(
      rescheduleManagedBooking(db, p.slug, token, tue('15:00'), { clock: p.clock }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);
  });

  it('cancels once, frees the time, and then the booking cannot change', async () => {
    const p = await newPage();
    const token = await linked(p);
    const cancelled = await cancelManagedBooking(db, p.slug, token, { clock: p.clock });
    expect(cancelled.booking).toMatchObject({ status: 'cancelled', changeable: false });
    await expect(
      cancelManagedBooking(db, p.slug, token, { clock: p.clock }),
    ).rejects.toBeInstanceOf(BookingNotChangeableError);
    await expect(
      rescheduleManagedBooking(db, p.slug, token, tue('14:00'), { clock: p.clock }),
    ).rejects.toBeInstanceOf(BookingNotChangeableError);
    await expect(book(p, { email: 'bo@example.test' })).resolves.toBeDefined();
  });

  it('cannot change a booking once it has started', async () => {
    const p = await newPage();
    const token = await linked(p);
    p.clock.set(tue('10:00'));
    expect((await getManagedBooking(db, p.slug, token, { clock: p.clock })).changeable).toBe(false);
    await expect(
      cancelManagedBooking(db, p.slug, token, { clock: p.clock }),
    ).rejects.toBeInstanceOf(BookingNotChangeableError);
  });
});

describe('notices (ADR-0024: emails queued with the change)', () => {
  it('tells notify about each change, inside its transaction', async () => {
    const p = await newPage();
    const notices: BookingNotice[] = [];
    const inTenant: (string | null)[] = [];
    const notify: BookingNotify = async (tx, notice) => {
      notices.push(notice);
      inTenant.push((await findCurrentTenant(tx))?.id ?? null);
    };
    const asked = await request(p);
    const confirmed = await confirmBookingRequest(
      db,
      p.slug,
      asked.requestId,
      { code: asked.code },
      { codeKey: KEY, clock: p.clock, notify },
    );
    await rescheduleManagedBooking(db, p.slug, confirmed.manageToken, tue('14:00'), {
      clock: p.clock,
      notify,
    });
    await cancelManagedBooking(db, p.slug, confirmed.manageToken, { clock: p.clock, notify });
    expect(notices.map((n) => n.kind)).toEqual(['confirmed', 'rescheduled', 'cancelled']);
    expect(notices.map((n) => 'manageToken' in n && n.manageToken)).toEqual([
      confirmed.manageToken,
      confirmed.manageToken,
      false,
    ]);
    const [booking] = await bookingsOf(p);
    expect(new Set(notices.map((n) => n.change.bookingId))).toEqual(new Set([booking?.id]));
    expect(new Set(notices.map((n) => n.change.at.getTime())).size).toBe(3);
    expect(notices[0]?.email).toMatchObject({ email: 'ana@example.test', clientName: 'Ana Ruiz' });
    expect(inTenant).toEqual([p.tenantId, p.tenantId, p.tenantId]);
  });

  it('rolls the change back when notify fails, so no email is sent for it', async () => {
    const p = await newPage();
    const asked = await request(p);
    const failing: BookingNotify = () => Promise.reject(new Error('could not queue'));
    await expect(
      confirmBookingRequest(
        db,
        p.slug,
        asked.requestId,
        { code: asked.code },
        { codeKey: KEY, clock: p.clock, notify: failing },
      ),
    ).rejects.toThrow('could not queue');
    expect(await bookingsOf(p)).toEqual([]);
    // The request is still open: the same code books it.
    const confirmed = await confirm(p, asked.requestId, asked.code);
    await expect(
      cancelManagedBooking(db, p.slug, confirmed.manageToken, {
        clock: p.clock,
        notify: failing,
      }),
    ).rejects.toThrow('could not queue');
    expect((await bookingsOf(p))[0]?.status).toBe('confirmed');
  });
});

describe('"Join the waitlist" on the booking page (S38a)', () => {
  const join = (
    p: Page,
    extra: { staffMemberId?: string | null; date?: string; email?: string } = {},
  ) =>
    requestWaitlistJoin(
      db,
      p.slug,
      {
        serviceId: p.service.id,
        staffMemberId: extra.staffMemberId ?? p.jess.id,
        date: extra.date ?? '2026-11-03',
        name: 'Ana Ruiz',
        email: extra.email ?? 'ana@example.test',
      },
      { codeKey: KEY, clock: p.clock },
    );
  const confirmJoin = (p: Page, requestId: string, code: VerificationCode) =>
    confirmWaitlistJoin(db, p.slug, requestId as never, { code }, { codeKey: KEY, clock: p.clock });

  it('refuses an expired code and a used one, adding no second entry (S38b)', async () => {
    const p = await newPage();
    const late = await join(p);
    p.clock.advanceBy(10 * 60_000);
    await expect(confirmJoin(p, late.requestId, late.code)).rejects.toBeInstanceOf(
      BookingRequestExpiredError,
    );
    const asked = await join(p);
    await confirmJoin(p, asked.requestId, asked.code);
    await expect(confirmJoin(p, asked.requestId, asked.code)).rejects.toBeInstanceOf(
      BookingRequestUsedError,
    );
    expect(await listWaitlist(db, p.owner, {}, { clock: p.clock })).toHaveLength(1);
  });

  it('adds nothing until the code is typed, then the client waits all that day, audited as the system', async () => {
    const p = await newPage();
    const asked = await join(p);
    expect(asked.email).toMatchObject({
      serviceName: 'Haircut',
      staffName: 'Jess',
      startsAt: tue('00:00'),
    });
    expect(await listWaitlist(db, p.owner, {}, { clock: p.clock })).toEqual([]);

    const { entry } = await confirmJoin(p, asked.requestId, asked.code);
    expect(entry).toEqual({
      service: { id: p.service.id, name: 'Haircut' },
      staff: { id: p.jess.id, displayName: 'Jess' },
      date: '2026-11-03',
      // The end of that day in New York.
      expiresAt: '2026-11-04T05:00:00.000Z',
    });
    const [waiting] = await listWaitlist(db, p.owner, {}, { clock: p.clock });
    expect(waiting).toMatchObject({
      serviceId: p.service.id,
      staffMemberId: p.jess.id,
      windows: [{ date: '2026-11-03', start: '00:00', end: '24:00' }],
      status: 'waiting',
    });
    const [client] = await listClients(db, p.owner, {});
    expect(client).toMatchObject({ email: 'ana@example.test', source: 'booking_page' });
    const audit = await auditOf(p.tenantId);
    expect(audit.slice(0, 2).map((e) => [e.action, e.actor])).toEqual([
      ['waitlist_entry.created', { kind: 'system', userId: null }],
      ['client.created', { kind: 'system', userId: null }],
    ]);
    // Used once.
    await expect(confirmJoin(p, asked.requestId, asked.code)).rejects.toBeInstanceOf(
      BookingRequestUsedError,
    );
  });

  it('keeps one entry when the client asks again for the same day and service', async () => {
    const p = await newPage();
    for (let i = 0; i < 2; i += 1) {
      const asked = await join(p);
      await confirmJoin(p, asked.requestId, asked.code);
    }
    expect(await listWaitlist(db, p.owner, {}, { clock: p.clock })).toHaveLength(1);
    // Anyone, or another day: entries of their own.
    const anyone = await join(p, { staffMemberId: null, date: '2026-11-04' });
    await confirmJoin(p, anyone.requestId, anyone.code);
    expect(await listWaitlist(db, p.owner, {}, { clock: p.clock })).toHaveLength(2);
  });

  it('adds a whole-day entry beside a narrower one the team made (code review)', async () => {
    const p = await newPage();
    const first = await join(p);
    await confirmJoin(p, first.requestId, first.code);
    const [client] = await listClients(db, p.owner, {});
    if (client === undefined) throw new Error('no client');
    await addToWaitlist(
      db,
      p.owner,
      {
        clientId: client.id,
        serviceId: p.service.id,
        staffMemberId: p.marco.id,
        windows: [{ date: '2026-11-05', start: '15:00', end: '18:00' }],
      },
      { clock: p.clock },
    );
    const asked = await join(p, { staffMemberId: p.marco.id, date: '2026-11-05' });
    await confirmJoin(p, asked.requestId, asked.code);
    expect(await listWaitlist(db, p.owner, {}, { clock: p.clock })).toHaveLength(3);
  });

  it('refuses a day further ahead than the page shows waitlist days for', async () => {
    const p = await newPage();
    // Today is 2 November: day 62 is 2 January 2027.
    await expect(join(p, { date: '2027-01-02' })).resolves.toMatchObject({});
    await expect(join(p, { date: '2027-01-03' })).rejects.toBeInstanceOf(WaitlistDayTooFarError);
  });

  it("never lets a booking's code add an entry, nor a waitlist code book a time", async () => {
    const p = await newPage();
    const joining = await join(p);
    await expect(confirm(p, joining.requestId, joining.code)).rejects.toBeInstanceOf(
      BookingRequestNotFoundError,
    );
    const booking = await request(p);
    await expect(confirmJoin(p, booking.requestId, booking.code)).rejects.toBeInstanceOf(
      BookingRequestNotFoundError,
    );
    expect(await bookingsOf(p)).toEqual([]);
    expect(await listWaitlist(db, p.owner, {}, { clock: p.clock })).toEqual([]);
  });

  it('counts wrong codes, shares the hourly limit with bookings, and refuses a day that is over', async () => {
    const p = await newPage();
    const asked = await join(p);
    await expect(confirmJoin(p, asked.requestId, wrong(asked.code))).rejects.toBeInstanceOf(
      WrongVerificationCodeError,
    );
    await expect(join(p, { date: '2026-11-01' })).rejects.toBeInstanceOf(WaitlistExpiredError);
    for (let i = 1; i < MAX_REQUESTS_PER_EMAIL_PER_HOUR; i += 1) await request(p);
    await expect(join(p)).rejects.toBeInstanceOf(TooManyBookingRequestsError);
    // Another business's page knows nothing of the request.
    const other = await newPage();
    await expect(confirmJoin(other, asked.requestId, asked.code)).rejects.toBeInstanceOf(
      BookingRequestNotFoundError,
    );
  });

  it('refuses a service nobody offers online', async () => {
    const p = await newPage();
    await expect(
      requestWaitlistJoin(
        db,
        p.slug,
        { serviceId: p.hidden.id, date: '2026-11-03', name: 'Ana', email: 'ana@example.test' },
        { codeKey: KEY, clock: p.clock },
      ),
    ).rejects.toBeInstanceOf(ServiceNotFoundError);
  });
});

describe('codeHash', () => {
  it('needs a key of at least 32 bytes and binds the code to the email', () => {
    const code = VerificationCodeSchema.parse('123456');
    expect(() => codeHash(randomBytes(16), 'ana@example.test', code)).toThrow(RangeError);
    expect(codeHash(KEY, 'ana@example.test', code)).not.toBe(
      codeHash(KEY, 'bo@example.test', code),
    );
    expect(codeHash(KEY, 'ana@example.test', code)).toMatch(/^[0-9a-f]{64}$/);
  });
});

import type { BookingEmailDetails, BookingNotify } from '@pepper/appointments';
import type * as Core from '@pepper/core';
import { ManualClock } from '@pepper/core';
import { type HttpException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailer } from '@pepper/core';
import { PublicBookingService } from './public-booking.service.js';

const appointments = vi.hoisted(() => ({
  requestBooking: vi.fn(),
  confirmBookingRequest: vi.fn(),
  rescheduleManagedBooking: vi.fn(),
  cancelManagedBooking: vi.fn(),
}));
vi.mock('@pepper/appointments', () => appointments);
const core = vi.hoisted(() => ({ queueEmail: vi.fn() }));
vi.mock('@pepper/core', async (original) => ({
  ...(await original<typeof Core>()),
  queueEmail: core.queueEmail,
}));

const DETAILS: BookingEmailDetails = {
  businessName: 'Juniper Hair Studio',
  timeZone: 'America/New_York',
  serviceName: 'Haircut',
  staffName: 'Jess',
  startsAt: '2026-11-03T15:00:00.000Z',
  email: 'ana@example.test',
  clientName: 'Ana Ruiz',
};
const TOKEN = 'q1W2e3R4t5Y6u7I8o9P0a_S-d1F2g3H4j5K6l7Z8x9C';
const OPTIONS = {
  baseUrl: 'http://localhost:3000',
  codeKey: Buffer.alloc(32, 1),
  outboxKey: Buffer.alloc(32, 2),
  clock: new ManualClock('2026-11-02T12:00:00Z'),
};
const CHANGE = {
  bookingId: '0199f4b2-7c1e-7a00-8000-0000000000b1',
  at: new Date('2026-11-02T12:00:01.234Z'),
};
const TX = { tx: true };

/** The `notify` option the service passed to the last call of `fn`. */
function notifyOf(fn: { mock: { calls: unknown[][] } }): BookingNotify {
  const options = fn.mock.calls.at(-1)?.at(-1) as { notify?: BookingNotify } | undefined;
  if (options?.notify === undefined) throw new Error('no notify option');
  return options.notify;
}

function serviceWith(mailer: Mailer | null) {
  return new PublicBookingService({ db: {} as never }, mailer, OPTIONS);
}

function status(error: unknown): number {
  return (error as HttpException).getStatus();
}

beforeEach(() => {
  vi.clearAllMocks();
  appointments.requestBooking.mockResolvedValue({
    requestId: 'r-1',
    expiresAt: '2026-11-02T12:10:00.000Z',
    code: '042917',
    email: DETAILS,
  });
  appointments.confirmBookingRequest.mockResolvedValue({
    booking: { status: 'confirmed' },
    manageToken: TOKEN,
    email: DETAILS,
  });
  appointments.cancelManagedBooking.mockResolvedValue({
    booking: { status: 'cancelled' },
    email: DETAILS,
  });
});

describe('PublicBookingService', () => {
  it('emails the code and answers without it', async () => {
    const send = vi.fn(() => Promise.resolve());
    const answer = await serviceWith({ send }).request('juniper', {} as never);
    expect(answer).toEqual({ requestId: 'r-1', expiresAt: '2026-11-02T12:10:00.000Z' });
    expect(JSON.stringify(answer)).not.toContain('042917');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ana@example.test',
        subject: expect.stringContaining('042917') as string,
      }),
    );
    expect(appointments.requestBooking).toHaveBeenCalledWith(
      {},
      'juniper',
      {},
      expect.objectContaining({ codeKey: OPTIONS.codeKey }),
    );
  });

  it('503 email_unavailable without a mailer, before storing anything', async () => {
    const error = await serviceWith(null)
      .request('juniper', {} as never)
      .catch((e: unknown) => e);
    expect(status(error)).toBe(503);
    expect(appointments.requestBooking).not.toHaveBeenCalled();
  });

  it('503 email_unavailable when the code cannot be sent', async () => {
    const send = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const error = await serviceWith({ send })
      .request('juniper', {} as never)
      .catch((e: unknown) => e);
    expect(status(error)).toBe(503);
  });

  it('queues the confirmation in the booking transaction, with the link, once per change', async () => {
    const send = vi.fn(() => Promise.resolve());
    const answer = await serviceWith({ send }).confirm('juniper', 'r-1' as never, {
      code: '042917',
    });
    expect(answer).toEqual({ booking: { status: 'confirmed' }, manageToken: TOKEN });
    await notifyOf(appointments.confirmBookingRequest)(TX as never, {
      kind: 'confirmed',
      email: DETAILS,
      manageToken: TOKEN as never,
      change: CHANGE as never,
    });
    expect(send).not.toHaveBeenCalled();
    expect(core.queueEmail).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({
        to: 'ana@example.test',
        text: expect.stringContaining(
          `http://localhost:3000/book/juniper/manage#${TOKEN}`,
        ) as string,
      }),
      {
        key: OPTIONS.outboxKey,
        dedupeKey: `booking.confirmed:${CHANGE.bookingId}:${String(CHANGE.at.getTime())}`,
        now: OPTIONS.clock.now(),
      },
    );
  });

  it('queues the moved booking with its link', async () => {
    appointments.rescheduleManagedBooking.mockResolvedValue({
      booking: { status: 'confirmed' },
      email: DETAILS,
    });
    await serviceWith(null).reschedule('juniper', TOKEN as never, '2026-11-04T15:00:00.000Z');
    await notifyOf(appointments.rescheduleManagedBooking)(TX as never, {
      kind: 'rescheduled',
      email: DETAILS,
      manageToken: TOKEN as never,
      change: CHANGE as never,
    });
    expect(core.queueEmail).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({
        subject: expect.stringContaining('has moved') as string,
        text: expect.stringContaining(`/book/juniper/manage#${TOKEN}`) as string,
      }),
      expect.objectContaining({
        dedupeKey: expect.stringMatching(/^booking\.rescheduled:/) as string,
      }),
    );
  });

  it('queues the cancellation, and nothing for a client without an email address', async () => {
    await serviceWith(null).cancel('juniper', TOKEN as never);
    const notify = notifyOf(appointments.cancelManagedBooking);
    await notify(TX as never, { kind: 'cancelled', email: DETAILS, change: CHANGE as never });
    expect(core.queueEmail).toHaveBeenCalledTimes(1);
    expect(core.queueEmail).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ subject: expect.stringContaining('is cancelled') as string }),
      expect.objectContaining({
        dedupeKey: expect.stringMatching(/^booking\.cancelled:/) as string,
      }),
    );
    await notify(TX as never, {
      kind: 'cancelled',
      email: { ...DETAILS, email: '' },
      change: CHANGE as never,
    });
    expect(core.queueEmail).toHaveBeenCalledTimes(1);
  });
});

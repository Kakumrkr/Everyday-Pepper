import type * as Appointments from '@pepper/appointments';
import type { BookingEmailDetails } from '@pepper/appointments';
import type { Mailer } from '@pepper/core';
import { type HttpException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookingEmails } from '../booking-emails/booking-emails.js';
import type { TeamPushes } from '../push/team-pushes.js';
import { PublicBookingService } from './public-booking.service.js';

const appointments = vi.hoisted(() => ({
  requestBooking: vi.fn(),
  confirmBookingRequest: vi.fn(),
  rescheduleManagedBooking: vi.fn(),
  cancelManagedBooking: vi.fn(),
  requestWaitlistJoin: vi.fn(),
}));
vi.mock('@pepper/appointments', async (original) => ({
  ...(await original<typeof Appointments>()),
  ...appointments,
}));

const DETAILS: BookingEmailDetails = {
  businessName: 'Juniper Hair Studio',
  slug: 'juniper',
  timeZone: 'America/New_York',
  serviceName: 'Haircut',
  staffName: 'Jess',
  startsAt: '2026-11-03T15:00:00.000Z',
  email: 'ana@example.test',
  clientName: 'Ana Ruiz',
  policy: { sentence: null, note: null },
};
const TOKEN = 'q1W2e3R4t5Y6u7I8o9P0a_S-d1F2g3H4j5K6l7Z8x9C';
const OPTIONS = { codeKey: Buffer.alloc(32, 1) };
const emailNotify = vi.fn(() => Promise.resolve());
const pushBookingPage = vi.fn(() => Promise.resolve());
const EMAILS = { notify: emailNotify } as unknown as BookingEmails;
const PUSHES = { bookingPage: pushBookingPage } as unknown as TeamPushes;

/** The `notify` option the service passed to the last call of `fn`. */
function notifyOf(fn: { mock: { calls: unknown[][] } }): unknown {
  const options = fn.mock.calls.at(-1)?.at(-1) as { notify?: unknown } | undefined;
  return options?.notify;
}

function serviceWith(mailer: Mailer | null) {
  return new PublicBookingService({ db: {} as never }, mailer, OPTIONS, EMAILS, PUSHES);
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
  appointments.rescheduleManagedBooking.mockResolvedValue({
    booking: { status: 'confirmed' },
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
    expect(answer).toEqual({
      response: { requestId: 'r-1', expiresAt: '2026-11-02T12:10:00.000Z' },
    });
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

  it('emails the waitlist code (its own words) and answers without it (S38a)', async () => {
    appointments.requestWaitlistJoin.mockResolvedValue({
      requestId: 'r-2',
      expiresAt: '2026-11-02T12:10:00.000Z',
      code: '042917',
      email: { ...DETAILS, startsAt: '2026-11-03T05:00:00.000Z' },
    });
    const send = vi.fn((message: { text: string }) => {
      expect(message.text).toContain('join the waitlist');
      return Promise.resolve();
    });
    const answer = await serviceWith({ send }).waitlistRequest('juniper', {} as never);
    expect(answer).toEqual({ requestId: 'r-2', expiresAt: '2026-11-02T12:10:00.000Z' });
    expect(JSON.stringify(answer)).not.toContain('042917');
    expect(send).toHaveBeenCalledTimes(1);
    const failing = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const error = await serviceWith({ send: failing })
      .waitlistRequest('juniper', {} as never)
      .catch((e: unknown) => e);
    expect(status(error)).toBe(503);
    expect(
      status(
        await serviceWith(null)
          .waitlistRequest('juniper', {} as never)
          .catch((e: unknown) => e),
      ),
    ).toBe(503);
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

  it('books at once from a remembered device, with no code email (S47, AC-W8-8)', async () => {
    appointments.requestBooking.mockResolvedValueOnce({
      requestId: 'r-1',
      expiresAt: '2026-11-02T12:10:00.000Z',
      code: '042917',
      email: DETAILS,
      remembered: true,
    });
    const device = 'd'.repeat(43) as never;
    // No mailer is needed: nothing is emailed but the queued confirmation.
    const answer = await serviceWith(null).request('juniper', {} as never, device);
    expect(appointments.requestBooking.mock.calls.at(-1)?.at(-1)).toMatchObject({
      deviceToken: device,
    });
    expect(appointments.confirmBookingRequest).toHaveBeenCalledWith(
      {},
      'juniper',
      'r-1',
      { code: '042917' },
      expect.anything(),
    );
    expect(answer).toEqual({
      response: {
        requestId: 'r-1',
        expiresAt: '2026-11-02T12:10:00.000Z',
        confirmed: { booking: { status: 'confirmed' }, manageToken: TOKEN },
      },
      refreshDevice: device,
    });
  });

  it('passes a new device secret out apart from the answer (S47)', async () => {
    appointments.confirmBookingRequest.mockResolvedValueOnce({
      booking: { status: 'confirmed' },
      manageToken: TOKEN,
      email: DETAILS,
      device: { token: 'd'.repeat(43), expiresAt: new Date() },
    });
    const answer = await serviceWith(null).confirm('juniper', 'r-1' as never, {
      code: '042917',
      remember: true,
    });
    expect(answer.device).toBe('d'.repeat(43));
    expect(JSON.stringify(answer.response)).not.toContain('d'.repeat(43));
  });

  it('queues the client email and the team push inside each change (ADR-0026)', async () => {
    const send = vi.fn(() => Promise.resolve());
    const answer = await serviceWith({ send }).confirm('juniper', 'r-1' as never, {
      code: '042917',
    });
    expect(answer).toEqual({ response: { booking: { status: 'confirmed' }, manageToken: TOKEN } });
    await serviceWith(null).reschedule('juniper', TOKEN as never, '2026-11-04T15:00:00.000Z');
    await serviceWith(null).cancel('juniper', TOKEN as never);
    for (const fn of [
      appointments.confirmBookingRequest,
      appointments.rescheduleManagedBooking,
      appointments.cancelManagedBooking,
    ]) {
      const notify = notifyOf(fn) as Appointments.BookingNotify;
      const tx = {} as never;
      const notice = { kind: 'cancelled', email: DETAILS, change: {} } as never;
      await notify(tx, notice);
      expect(emailNotify).toHaveBeenLastCalledWith(tx, notice);
      expect(pushBookingPage).toHaveBeenLastCalledWith(tx, notice);
    }
    // Only the code is sent at once; the rest goes through the outbox.
    expect(send).not.toHaveBeenCalled();
  });
});

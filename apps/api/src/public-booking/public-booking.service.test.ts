import type { BookingEmailDetails } from '@pepper/appointments';
import { type HttpException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailer } from '../mail/mailer.js';
import { PublicBookingService } from './public-booking.service.js';

const appointments = vi.hoisted(() => ({
  requestBooking: vi.fn(),
  confirmBookingRequest: vi.fn(),
  rescheduleManagedBooking: vi.fn(),
  cancelManagedBooking: vi.fn(),
}));
vi.mock('@pepper/appointments', () => appointments);

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
const OPTIONS = { baseUrl: 'http://localhost:3000', codeKey: Buffer.alloc(32, 1) };

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

  it('confirms even when the confirmation email fails: the page shows the link too', async () => {
    const send = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const answer = await serviceWith({ send }).confirm('juniper', 'r-1' as never, '042917');
    expect(answer).toEqual({ booking: { status: 'confirmed' }, manageToken: TOKEN });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          `http://localhost:3000/book/juniper/manage#${TOKEN}`,
        ) as string,
      }),
    );
  });

  it('tells the client about a cancellation, and skips email for a client without one', async () => {
    const send = vi.fn(() => Promise.resolve());
    await serviceWith({ send }).cancel('juniper', TOKEN as never);
    expect(send).toHaveBeenCalledTimes(1);
    appointments.cancelManagedBooking.mockResolvedValueOnce({
      booking: { status: 'cancelled' },
      email: { ...DETAILS, email: '' },
    });
    await serviceWith({ send }).cancel('juniper', TOKEN as never);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

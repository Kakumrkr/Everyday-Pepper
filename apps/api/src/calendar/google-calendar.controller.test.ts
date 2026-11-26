import 'reflect-metadata';
import type { TenantContext } from '@pepper/core';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RateLimiter } from '../http/rate-limit.js';
import { GoogleCalendarController } from './google-calendar.controller.js';
import type { GoogleCalendarService } from './google-calendar.service.js';

// The controller without Nest or a database (S70–S71): each Google call counts against the
// member's limit, inputs are parsed on the way in and answers on the way out, and a booking the
// member can't see is 404. calendar-sync.int.test.ts proves the whole path.

const tenant = {
  tenantId: '0b9b2f9e-8d6d-4e7c-9d7f-3c1f0c9a1a11',
  userId: '0b9b2f9e-8d6d-4e7c-9d7f-3c1f0c9a1a12',
  role: 'staff',
} as unknown as TenantContext;
const BOOKING = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const STAFF = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const CONNECTION = {
  staffMemberId: STAFF,
  provider: 'sandbox',
  accountEmail: 'jo@example.test',
  status: 'connected',
  syncedAt: null,
  connectedAt: '2026-11-26T12:00:00.000Z',
  writesBookings: true,
};

function fakes(state: unknown = { state: 'written' }) {
  const calendar = {
    own: vi.fn(() => Promise.resolve({ canConnect: true, connection: CONNECTION })),
    team: vi.fn(() => Promise.resolve({ connections: [], truncated: false })),
    connect: vi.fn(() => Promise.resolve({ url: 'https://accounts.google.com/o/oauth2/v2/auth' })),
    complete: vi.fn(() => Promise.resolve({ canConnect: true, connection: CONNECTION })),
    disconnect: vi.fn(() => Promise.resolve()),
    bookingState: vi.fn(() => Promise.resolve(state)),
    outsideBusy: vi.fn(() => Promise.resolve([])),
  };
  const limits = { hit: vi.fn(() => Promise.resolve()) };
  return {
    calendar,
    limits,
    controller: new GoogleCalendarController(
      calendar as unknown as GoogleCalendarService,
      limits as unknown as RateLimiter,
    ),
  };
}

describe('GoogleCalendarController', () => {
  it('counts the connect and its return against the member, not the reads', async () => {
    const { controller, limits, calendar } = fakes();
    expect((await controller.own(tenant)).connection?.writesBookings).toBe(true);
    expect(await controller.team(tenant)).toEqual({ connections: [], truncated: false });
    expect(limits.hit).not.toHaveBeenCalled();
    await controller.connect(tenant);
    await controller.complete(tenant, { code: 'sandbox-ok', state: 'A'.repeat(43) });
    expect(limits.hit).toHaveBeenCalledTimes(2);
    expect(calendar.complete).toHaveBeenCalledWith(tenant, {
      code: 'sandbox-ok',
      state: 'A'.repeat(43),
    });
    await controller.disconnect(tenant);
    expect(calendar.disconnect).toHaveBeenCalledWith(tenant);
  });

  it("answers a booking's place in Google Calendar (S71, AC-X-173)", async () => {
    const { controller, calendar } = fakes({ state: 'pending' });
    expect(await controller.bookingState(tenant, { bookingId: BOOKING.toUpperCase() })).toEqual({
      state: 'pending',
    });
    // The id is parsed (lowercased) before the service sees it.
    expect(calendar.bookingState).toHaveBeenCalledWith(tenant, BOOKING);
  });

  it('is 404 for a booking the member can’t see, and refuses a malformed id', async () => {
    const hidden = fakes();
    hidden.calendar.bookingState.mockResolvedValueOnce(undefined);
    await expect(hidden.controller.bookingState(tenant, { bookingId: BOOKING })).rejects.toThrow(
      NotFoundException,
    );
    await expect(
      hidden.controller.bookingState(tenant, { bookingId: 'not-an-id' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(hidden.calendar.bookingState).toHaveBeenCalledTimes(1);
  });

  it('caps outside busy times and says when it cut', async () => {
    const { controller, calendar } = fakes();
    const many = Array.from({ length: 501 }, (_, i) => ({
      staffMemberId: STAFF,
      startsAt: new Date(Date.UTC(2026, 11, 1, 0, i)).toISOString(),
      endsAt: new Date(Date.UTC(2026, 11, 1, 0, i + 1)).toISOString(),
      source: 'google' as const,
    }));
    calendar.outsideBusy.mockResolvedValueOnce(many as never);
    const answer = await controller.outsideBusy(tenant, {
      from: '2026-12-01T00:00:00.000Z',
      to: '2026-12-02T00:00:00.000Z',
    });
    expect(answer.truncated).toBe(true);
    expect(answer.busy).toHaveLength(500);
  });
});

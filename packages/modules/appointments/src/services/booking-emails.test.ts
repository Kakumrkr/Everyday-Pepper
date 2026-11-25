import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Core from '@pepper/core';
import { ManualClock } from '@pepper/core';
import type { BookingEmailDetails } from './notices.js';
import { queueBookingEmail } from './booking-emails.js';

const core = vi.hoisted(() => ({ queueEmail: vi.fn() }));
vi.mock('@pepper/core', async (original) => ({
  ...(await original<typeof Core>()),
  queueEmail: core.queueEmail,
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
const CHANGE = {
  bookingId: '0199f4b2-7c1e-7a00-8000-0000000000b1',
  at: new Date('2026-11-02T12:00:01.234Z'),
};
const OPTIONS = {
  baseUrl: 'http://localhost:3000',
  outboxKey: Buffer.alloc(32, 2),
  clock: new ManualClock('2026-11-02T12:00:00Z'),
};
const TX = { tx: true };
const notice = { kind: 'cancelled' as const, email: DETAILS, change: CHANGE as never };

beforeEach(() => {
  vi.clearAllMocks();
  core.queueEmail.mockResolvedValue('0199f4b2-7c1e-7a00-8000-0000000000e1');
});

describe('queueBookingEmail', () => {
  it('queues at once for the team and returns the outbox id', async () => {
    const id = await queueBookingEmail(TX as never, notice, OPTIONS);
    expect(id).toBe('0199f4b2-7c1e-7a00-8000-0000000000e1');
    expect(core.queueEmail).toHaveBeenCalledWith(TX, expect.anything(), {
      key: OPTIONS.outboxKey,
      dedupeKey: `booking.cancelled:${CHANGE.bookingId}:${String(CHANGE.at.getTime())}`,
      now: OPTIONS.clock.now(),
    });
  });

  it("holds the AI's email for the undo-send grace", async () => {
    await queueBookingEmail(TX as never, notice, { ...OPTIONS, holdSeconds: 120 });
    expect(core.queueEmail).toHaveBeenCalledWith(
      TX,
      expect.anything(),
      expect.objectContaining({ now: new Date('2026-11-02T12:02:00Z') }),
    );
  });

  it('queues nothing for a client without an email address', async () => {
    const none = { ...notice, email: { ...DETAILS, email: '' } };
    expect(await queueBookingEmail(TX as never, none, OPTIONS)).toBeUndefined();
    expect(core.queueEmail).not.toHaveBeenCalled();
  });
});

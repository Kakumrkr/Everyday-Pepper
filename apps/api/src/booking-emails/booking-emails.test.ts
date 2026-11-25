import type { BookingEmailDetails } from '@pepper/appointments';
import type * as Core from '@pepper/core';
import { ManualClock } from '@pepper/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BookingEmails } from './booking-emails.js';

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
const TOKEN = 'q1W2e3R4t5Y6u7I8o9P0a_S-d1F2g3H4j5K6l7Z8x9C';
const OPTIONS = {
  baseUrl: 'http://localhost:3000',
  outboxKey: Buffer.alloc(32, 2),
  clock: new ManualClock('2026-11-02T12:00:00Z'),
};
const CHANGE = {
  bookingId: '0199f4b2-7c1e-7a00-8000-0000000000b1',
  at: new Date('2026-11-02T12:00:01.234Z'),
};
const TX = { tx: true };

const { notify } = new BookingEmails(OPTIONS);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BookingEmails', () => {
  it("queues the confirmation in the change's transaction, with the link, once per change", async () => {
    await notify(TX as never, {
      kind: 'confirmed',
      email: DETAILS,
      manageToken: TOKEN as never,
      change: CHANGE as never,
    });
    expect(core.queueEmail).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({
        to: 'ana@example.test',
        subject: "You're booked at Juniper Hair Studio",
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

  it("links to the business's own booking page", async () => {
    await notify(TX as never, {
      kind: 'confirmed',
      email: { ...DETAILS, slug: 'fig-and-plum' },
      manageToken: TOKEN as never,
      change: CHANGE as never,
    });
    expect(core.queueEmail).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({
        text: expect.stringContaining(`/book/fig-and-plum/manage#${TOKEN}`) as string,
      }),
      expect.anything(),
    );
  });

  it('queues the moved booking with its link', async () => {
    await notify(TX as never, {
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

  it('uses the system clock by default', async () => {
    const { notify: systemNotify } = new BookingEmails({
      baseUrl: OPTIONS.baseUrl,
      outboxKey: OPTIONS.outboxKey,
    });
    const before = Date.now();
    await systemNotify(TX as never, { kind: 'cancelled', email: DETAILS, change: CHANGE as never });
    const options = core.queueEmail.mock.calls.at(-1)?.at(2) as { now: Date };
    expect(options.now.getTime()).toBeGreaterThanOrEqual(before);
  });
});

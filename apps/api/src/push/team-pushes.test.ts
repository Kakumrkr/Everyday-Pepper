import type * as Appointments from '@pepper/appointments';
import { describe, expect, it, vi } from 'vitest';
import { TeamPushes } from './team-pushes.js';

const appointments = vi.hoisted(() => ({ queueBookingPagePush: vi.fn(() => Promise.resolve([])) }));
vi.mock('@pepper/appointments', async (original) => ({
  ...(await original<typeof Appointments>()),
  ...appointments,
}));

const KEY = Buffer.alloc(32, 7);
const NOW = new Date('2026-11-02T15:00:00Z');
const clock = { now: () => NOW };
const notice = { kind: 'confirmed' } as never;
const tx = {} as never;

describe('TeamPushes (ADR-0026)', () => {
  it('queues the booking page push with the outbox key when pushes are on', async () => {
    const pushes = new TeamPushes({ publicKey: 'B'.repeat(87), outboxKey: KEY, clock });
    expect(pushes.enabled).toBe(true);
    await pushes.bookingPage(tx, notice);
    expect(appointments.queueBookingPagePush).toHaveBeenCalledWith(tx, notice, {
      key: KEY,
      now: NOW,
    });
  });

  it('queues nothing when pushes are off', async () => {
    appointments.queueBookingPagePush.mockClear();
    const pushes = new TeamPushes({ publicKey: null, outboxKey: KEY });
    expect(pushes.enabled).toBe(false);
    await pushes.bookingPage(tx, notice);
    expect(appointments.queueBookingPagePush).not.toHaveBeenCalled();
  });
});

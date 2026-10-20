import { describe, expect, it, vi } from 'vitest';
import { handleDeliveryJob, relayDue, RELAY_BATCH, type JobQueue } from './relay.js';

const db = vi.hoisted(() => ({ listDueOutboxMessages: vi.fn() }));
vi.mock('@pepper/db', () => db);
const core = vi.hoisted(() => ({ deliverOutboxMessage: vi.fn() }));
vi.mock('@pepper/core', () => core);

const DUE = {
  messageId: '0199f4b2-7c1e-7a00-8000-000000000001',
  tenantId: '0199f4b2-7c1e-7a00-8000-0000000000aa',
};
const NOW = new Date('2026-10-20T15:00:00Z');

function fakeQueue() {
  const addBulk = vi.fn(() => Promise.resolve([]));
  const queue: JobQueue = { addBulk };
  return { queue, addBulk };
}

describe('relayDue', () => {
  it('queues one job per due message, keyed by the message id', async () => {
    db.listDueOutboxMessages.mockResolvedValueOnce([DUE]);
    const { queue, addBulk } = fakeQueue();
    expect(await relayDue({} as never, queue, NOW)).toBe(1);
    expect(db.listDueOutboxMessages).toHaveBeenCalledWith({}, NOW, RELAY_BATCH);
    expect(addBulk).toHaveBeenCalledWith([
      {
        name: 'deliver',
        data: DUE,
        opts: { jobId: DUE.messageId, removeOnComplete: true, removeOnFail: true },
      },
    ]);
  });

  it('queues nothing when nothing is due', async () => {
    db.listDueOutboxMessages.mockResolvedValueOnce([]);
    const { queue, addBulk } = fakeQueue();
    expect(await relayDue({} as never, queue, NOW)).toBe(0);
    expect(addBulk).not.toHaveBeenCalled();
  });
});

describe('handleDeliveryJob', () => {
  const options = { key: Buffer.alloc(32), mailer: { send: vi.fn() }, clock: { now: () => NOW } };

  it('delivers the message the job names', async () => {
    core.deliverOutboxMessage.mockResolvedValueOnce('sent');
    expect(await handleDeliveryJob({} as never, DUE, options)).toBe('sent');
    expect(core.deliverOutboxMessage).toHaveBeenCalledWith({}, DUE, options);
  });

  it('refuses malformed job data', () => {
    expect(() => handleDeliveryJob({} as never, { messageId: 'x' }, options)).toThrow();
  });
});

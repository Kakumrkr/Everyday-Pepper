import { describe, expect, it, vi } from 'vitest';
import { MatchJobSchema, relayDueMatches, WAITLIST_RELAY_BATCH, type MatchQueue } from './relay.js';

const db = vi.hoisted(() => ({ listDueWaitlistMatches: vi.fn() }));
vi.mock('@pepper/db', () => db);

const DUE = {
  matchId: '0199f4b2-7c1e-7a00-8000-000000000001',
  tenantId: '0199f4b2-7c1e-7a00-8000-0000000000aa',
};
const NOW = new Date('2026-11-02T12:00:00Z');

function fakeQueue() {
  const addBulk = vi.fn(() => Promise.resolve([]));
  const queue: MatchQueue = { addBulk };
  return { queue, addBulk };
}

describe('relayDueMatches (S37)', () => {
  it('queues one job per freed time, keyed by the match id', async () => {
    db.listDueWaitlistMatches.mockResolvedValueOnce([DUE]);
    const { queue, addBulk } = fakeQueue();
    expect(await relayDueMatches({} as never, queue, NOW)).toBe(1);
    expect(db.listDueWaitlistMatches).toHaveBeenCalledWith({}, NOW, WAITLIST_RELAY_BATCH);
    expect(addBulk).toHaveBeenCalledWith([
      {
        name: 'match',
        data: DUE,
        opts: { jobId: DUE.matchId, removeOnComplete: true, removeOnFail: true },
      },
    ]);
  });

  it('queues nothing when nothing is due', async () => {
    db.listDueWaitlistMatches.mockResolvedValueOnce([]);
    const { queue, addBulk } = fakeQueue();
    expect(await relayDueMatches({} as never, queue, NOW)).toBe(0);
    expect(addBulk).not.toHaveBeenCalled();
  });

  it('refuses malformed job data', () => {
    expect(MatchJobSchema.safeParse({ matchId: 'x', tenantId: DUE.tenantId }).success).toBe(false);
  });
});

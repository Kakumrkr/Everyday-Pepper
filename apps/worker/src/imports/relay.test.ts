import { describe, expect, it, vi } from 'vitest';
import {
  IMPORTS_RELAY_BATCH,
  ImportJobSchema,
  relayDueImports,
  type ImportQueue,
} from './relay.js';

const db = vi.hoisted(() => ({ listDueImportBatches: vi.fn() }));
vi.mock('@pepper/db', () => db);

const DUE = {
  batchId: '0199f4b2-7c1e-7a00-8000-000000000001',
  tenantId: '0199f4b2-7c1e-7a00-8000-0000000000aa',
};
const NOW = new Date('2026-11-03T12:00:00Z');

function fakeQueue() {
  const addBulk = vi.fn(() => Promise.resolve([]));
  const queue: ImportQueue = { addBulk };
  return { queue, addBulk };
}

describe('relayDueImports (S48)', () => {
  it('queues one job per committed import, keyed by the batch id', async () => {
    db.listDueImportBatches.mockResolvedValueOnce([DUE]);
    const { queue, addBulk } = fakeQueue();
    expect(await relayDueImports({} as never, queue, NOW)).toBe(1);
    expect(db.listDueImportBatches).toHaveBeenCalledWith({}, NOW, IMPORTS_RELAY_BATCH);
    expect(addBulk).toHaveBeenCalledWith([
      {
        name: 'import',
        data: DUE,
        opts: { jobId: DUE.batchId, removeOnComplete: true, removeOnFail: true },
      },
    ]);
  });

  it('queues nothing when nothing is due', async () => {
    db.listDueImportBatches.mockResolvedValueOnce([]);
    const { queue, addBulk } = fakeQueue();
    expect(await relayDueImports({} as never, queue, NOW)).toBe(0);
    expect(addBulk).not.toHaveBeenCalled();
  });

  it('refuses malformed job data', () => {
    expect(ImportJobSchema.safeParse({ batchId: 'x', tenantId: DUE.tenantId }).success).toBe(false);
  });
});

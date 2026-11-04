import { DELETION_GRACE_DAYS, TenantIdSchema, UserIdSchema } from '@pepper/contracts';
import type { Database } from '@pepper/db';
import { describe, expect, it } from 'vitest';
import type { Actor } from '../actor.js';
import { ForbiddenError } from '../errors.js';
import { cancelBusinessDeletion, deletionDueFrom, scheduleBusinessDeletion } from './deletion.js';

// The parts of deleting a business that need no database (S51.2, ADR-0054, AC-W1-40); the rest
// is in `apps/api/src/deletion.int.test.ts` and `packages/db/src/deletion.int.test.ts`.

const tenantId = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const userId = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const as = (role: 'manager' | 'staff'): Actor => ({ context: { tenantId, userId, role } });
// Never reached: the permission is checked before any query.
const db = {} as Database;
const clock = { now: () => new Date('2099-03-01T12:00:00Z') };

describe('business deletion', () => {
  it('is due 30 days after it is asked for', () => {
    expect(DELETION_GRACE_DAYS).toBe(30);
    expect(deletionDueFrom(new Date('2099-03-01T12:00:00Z')).toISOString()).toBe(
      '2099-03-31T12:00:00.000Z',
    );
  });

  it('is the owner’s alone: managers and staff are refused before anything is read', async () => {
    for (const role of ['manager', 'staff'] as const) {
      await expect(
        scheduleBusinessDeletion(db, as(role), { confirmName: 'Fade Lab' }, { clock }),
      ).rejects.toThrow(new ForbiddenError('business.delete'));
      await expect(cancelBusinessDeletion(db, as(role))).rejects.toThrow(ForbiddenError);
    }
  });
});

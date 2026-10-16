import { TenantIdSchema, type TenantId } from '@floty/contracts';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from './client.js';
import { withTenant } from './tenant.js';

const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');

function fakeDb() {
  const executed: SQL[] = [];
  const tx = { execute: vi.fn((query: SQL) => (executed.push(query), Promise.resolve())) };
  const db = { transaction: vi.fn((work: (t: typeof tx) => Promise<unknown>) => work(tx)) };
  return { db: db as unknown as Database, tx, executed, transaction: db.transaction };
}

describe('withTenant', () => {
  it('sets the tenant transaction-locally, as a bound parameter, before the work', async () => {
    const { db, tx, executed } = fakeDb();
    const result = await withTenant(db, TENANT, (given) => {
      expect(given).toBe(tx);
      expect(executed).toHaveLength(1);
      return Promise.resolve('done');
    });
    expect(result).toBe('done');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- asserted length 1 above
    const query = new PgDialect().sqlToQuery(executed[0]!);
    expect(query).toMatchObject({
      sql: "SELECT set_config('app.tenant_id', $1, true)",
      params: [TENANT],
    });
  });

  it.each(['', 'not-a-uuid', "x', true); SELECT 1; --"])(
    'rejects tenant id %j before touching the database',
    async (value) => {
      const { db, transaction } = fakeDb();
      await expect(withTenant(db, value as TenantId, () => Promise.resolve())).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it('propagates errors from the work (the transaction rolls back)', async () => {
    const { db } = fakeDb();
    await expect(withTenant(db, TENANT, () => Promise.reject(new Error('nope')))).rejects.toThrow(
      'nope',
    );
  });
});

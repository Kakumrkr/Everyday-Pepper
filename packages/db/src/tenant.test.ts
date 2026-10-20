import { TenantIdSchema, UserIdSchema, type TenantId, type UserId } from '@pepper/contracts';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from './client.js';
import {
  setTransactionTenant,
  setTransactionUser,
  withMember,
  withTenant,
  withJobScan,
  withUser,
} from './tenant.js';

const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');

function fakeDb() {
  const executed: SQL[] = [];
  const tx = { execute: vi.fn((query: SQL) => (executed.push(query), Promise.resolve())) };
  const db = {
    // The second argument (transaction config) is asserted by the tests that pass one.
    transaction: vi.fn((...args: [work: (t: typeof tx) => Promise<unknown>, config?: object]) =>
      args[0](tx),
    ),
  };
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

describe('withUser', () => {
  it('sets the user transaction-locally, as a bound parameter, in a read-only transaction', async () => {
    const { db, tx, executed, transaction } = fakeDb();
    const result = await withUser(db, USER, (given) => {
      expect(given).toBe(tx);
      return Promise.resolve('done');
    });
    expect(result).toBe('done');
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { accessMode: 'read only' });
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the setting is the first statement
    const query = new PgDialect().sqlToQuery(executed[0]!);
    expect(query).toMatchObject({
      sql: "SELECT set_config('app.user_id', $1, true)",
      params: [USER],
    });
  });

  it.each(['', 'not-a-uuid'])('rejects user id %j before touching the database', async (value) => {
    const { db, transaction } = fakeDb();
    await expect(withUser(db, value as UserId, () => Promise.resolve())).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('withJobScan', () => {
  it.each(['reminders', 'cleanup'] as const)(
    'names the %s job transaction-locally, as a bound parameter, in a read-only transaction',
    async (job) => {
      const { db, tx, executed, transaction } = fakeDb();
      const result = await withJobScan(db, job, (given) => {
        expect(given).toBe(tx);
        return Promise.resolve('done');
      });
      expect(result).toBe('done');
      expect(transaction).toHaveBeenCalledWith(expect.any(Function), { accessMode: 'read only' });
      expect(executed).toHaveLength(1);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- asserted length 1 above
      const query = new PgDialect().sqlToQuery(executed[0]!);
      expect(query).toMatchObject({
        sql: "SELECT set_config('app.job_scan', $1, true)",
        params: [job],
      });
    },
  );

  it('rejects an unknown job before touching the database', async () => {
    const { db, transaction } = fakeDb();
    await expect(withJobScan(db, 'outbox' as never, () => Promise.resolve())).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('withMember', () => {
  it('binds the tenant and then the user, as bound parameters, before the work', async () => {
    const { db, tx, executed, transaction } = fakeDb();
    const result = await withMember(db, { tenantId: TENANT, userId: USER }, (given) => {
      expect(given).toBe(tx);
      expect(executed).toHaveLength(2);
      return Promise.resolve('done');
    });
    expect(result).toBe('done');
    // A read-write transaction: members change bookings through it.
    expect(transaction).toHaveBeenCalledWith(expect.any(Function));
    expect(executed.map((query) => new PgDialect().sqlToQuery(query))).toMatchObject([
      { sql: "SELECT set_config('app.tenant_id', $1, true)", params: [TENANT] },
      { sql: "SELECT set_config('app.user_id', $1, true)", params: [USER] },
    ]);
  });

  it.each([
    ['tenant', { tenantId: 'nope' as TenantId, userId: USER }],
    ['user', { tenantId: TENANT, userId: 'nope' as UserId }],
  ])('rejects a malformed %s id before touching the database', async (_label, member) => {
    const { db, transaction } = fakeDb();
    await expect(withMember(db, member, () => Promise.resolve())).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('setTransactionTenant / setTransactionUser', () => {
  it('bind the open transaction with bound parameters; a null user unbinds', async () => {
    const { tx, executed } = fakeDb();
    const open = tx as unknown as Parameters<typeof setTransactionTenant>[0];
    await setTransactionTenant(open, TENANT);
    await setTransactionUser(open, USER);
    await setTransactionUser(open, null);
    expect(executed.map((query) => new PgDialect().sqlToQuery(query))).toMatchObject([
      { sql: "SELECT set_config('app.tenant_id', $1, true)", params: [TENANT] },
      { sql: "SELECT set_config('app.user_id', $1, true)", params: [USER] },
      { sql: "SELECT set_config('app.user_id', $1, true)", params: [''] },
    ]);
  });

  it('reject malformed ids', async () => {
    const { tx, executed } = fakeDb();
    const open = tx as unknown as Parameters<typeof setTransactionTenant>[0];
    await expect(setTransactionTenant(open, 'nope' as TenantId)).rejects.toThrow();
    await expect(setTransactionUser(open, 'nope' as UserId)).rejects.toThrow();
    expect(executed).toEqual([]);
  });
});

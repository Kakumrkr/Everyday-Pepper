import { TenantIdSchema, UserIdSchema, type TenantId, type UserId } from '@pepper/contracts';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from './client.js';
import {
  isPlatformOperator,
  withOperator,
  setTransactionTenant,
  setTransactionUser,
  withMember,
  withTenant,
  withJobScan,
  withUser,
  withInboundMail,
  withSmsInbound,
  setTransactionInboundMail,
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

describe('withInboundMail / withSmsInbound / setTransactionInboundMail', () => {
  it.each([
    ['withInboundMail', withInboundMail, "SELECT set_config('app.inbound_mail', 'on', true)"],
    ['withSmsInbound', withSmsInbound, "SELECT set_config('app.sms_inbound', 'on', true)"],
  ] as const)(
    '%s opens its platform table transaction-locally before the work, and nothing else',
    async (_name, open, expected) => {
      const { db, tx, executed, transaction } = fakeDb();
      const result = await open(db, (given) => {
        expect(given).toBe(tx);
        expect(executed).toHaveLength(1);
        return Promise.resolve('done');
      });
      expect(result).toBe('done');
      // Read-write: the webhook records there.
      expect(transaction).toHaveBeenCalledWith(expect.any(Function));
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- asserted length 1 above
      expect(new PgDialect().sqlToQuery(executed[0]!)).toMatchObject({ sql: expected, params: [] });
    },
  );

  it('setTransactionInboundMail opens inbound mail in the open transaction', async () => {
    const { tx, executed } = fakeDb();
    await setTransactionInboundMail(
      tx as unknown as Parameters<typeof setTransactionInboundMail>[0],
    );
    expect(executed.map((query) => new PgDialect().sqlToQuery(query).sql)).toEqual([
      "SELECT set_config('app.inbound_mail', 'on', true)",
    ]);
  });
});

describe('withOperator (S59.2, ADR-0062)', () => {
  it('opens the access with its log row before the work, as bound parameters', async () => {
    const { db, tx, executed } = fakeDb();
    const target = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708194';
    const result = await withOperator(
      db,
      { operatorUserId: USER, action: 'thread.read', targetId: target },
      (given) => {
        expect(given).toBe(tx);
        expect(executed).toHaveLength(1);
        return Promise.resolve('seen');
      },
    );
    expect(result).toBe('seen');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- asserted length 1 above
    const query = new PgDialect().sqlToQuery(executed[0]!);
    expect(query.sql).toBe('SELECT begin_operator_access($1::uuid, $2::uuid, $3, $4::uuid)');
    expect(query.params.slice(1)).toEqual([USER, 'thread.read', target]);
  });

  it('logs an inbox read without a target', async () => {
    const { db, executed } = fakeDb();
    await withOperator(db, { operatorUserId: USER, action: 'inbox.read', targetId: null }, () =>
      Promise.resolve(),
    );
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- one statement ran
    expect(new PgDialect().sqlToQuery(executed[0]!).params.slice(1)).toEqual([
      USER,
      'inbox.read',
      null,
    ]);
  });

  it.each([
    [{ operatorUserId: 'nope', action: 'inbox.read', targetId: null }],
    [{ operatorUserId: USER, action: 'clients.read', targetId: null }],
    [{ operatorUserId: USER, action: 'thread.read', targetId: "x'; --" }],
  ])('rejects %j before touching the database', async (access) => {
    const { db, transaction } = fakeDb();
    await expect(
      withOperator(db, access as Parameters<typeof withOperator>[1], () => Promise.resolve()),
    ).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('isPlatformOperator', () => {
  it('asks the database function, and only says yes to true', async () => {
    for (const [rows, expected] of [
      [[{ operator: true }], true],
      [[{ operator: false }], false],
      [[], false],
    ] as const) {
      const execute = vi.fn(() => Promise.resolve({ rows }));
      const db = { execute } as unknown as Database;
      expect(await isPlatformOperator(db, USER)).toBe(expected);
    }
  });

  it('rejects a malformed id before asking', async () => {
    const execute = vi.fn();
    await expect(
      isPlatformOperator({ execute } as unknown as Database, 'x' as UserId),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});

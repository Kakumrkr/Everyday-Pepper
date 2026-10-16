import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { checkDatabaseRole, createDatabase } from './client.js';

function fakeClient(rows: { bypasses_rls: boolean }[]) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

describe('checkDatabaseRole', () => {
  it('passes for a role that RLS applies to', async () => {
    const client = fakeClient([{ bypasses_rls: false }]);
    await expect(checkDatabaseRole(client)).resolves.toBeUndefined();
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('rolbypassrls'));
  });

  it('fails for a superuser or BYPASSRLS role', async () => {
    await expect(checkDatabaseRole(fakeClient([{ bypasses_rls: true }]))).rejects.toThrow(
      /bypasses row-level security/,
    );
  });

  it('fails when the role cannot be found', async () => {
    await expect(checkDatabaseRole(fakeClient([]))).rejects.toThrow(/bypasses row-level security/);
  });

  it('propagates connection errors', async () => {
    const client = { query: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    await expect(checkDatabaseRole(client)).rejects.toThrow('ECONNREFUSED');
  });
});

describe('createDatabase', () => {
  it('creates a lazy pool and closes it', async () => {
    // No connection is made until the first query.
    const database = createDatabase({ url: 'postgres://app:secret@127.0.0.1:1/none' });
    expect(database.db).toBeDefined();
    await expect(database.close()).resolves.toBeUndefined();
  });

  it('reports idle client errors instead of crashing', async () => {
    const onIdleError = vi.fn();
    const database = createDatabase({ url: 'postgres://app:secret@127.0.0.1:1/none', onIdleError });
    const pool = (database.db as unknown as { $client: pg.Pool }).$client;
    pool.emit('error', new Error('connection terminated'));
    expect(onIdleError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'connection terminated' }),
    );
    await database.close();
  });

  it('fails the probe when Postgres is unreachable', async () => {
    const database = createDatabase({ url: 'postgres://app:secret@127.0.0.1:1/none' });
    await expect(database.ping()).rejects.toThrow();
    await database.close();
  });
});

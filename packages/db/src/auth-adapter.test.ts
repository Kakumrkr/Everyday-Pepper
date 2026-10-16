import { describe, expect, it } from 'vitest';
import { authDatabaseAdapter } from './auth-adapter.js';
import type { Database } from './client.js';

describe('authDatabaseAdapter', () => {
  it('builds a Better Auth adapter factory without touching the database', () => {
    // The factory only reads the schema; queries happen when Better Auth calls it later.
    const adapter = authDatabaseAdapter({} as Database);
    expect(adapter).toBeTypeOf('function');
  });
});

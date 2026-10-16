import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { Database } from './client.js';
import { accounts, sessions, twoFactors, users, verifications } from './schema.js';

/**
 * The storage Better Auth uses (ADR-0012): its five global tables, under their plural model
 * names. Keeps Better Auth's database access inside this package; it never sees tenant tables.
 */
export function authDatabaseAdapter(db: Database): ReturnType<typeof drizzleAdapter> {
  return drizzleAdapter(db, {
    provider: 'pg',
    usePlural: true,
    schema: { users, sessions, accounts, verifications, twoFactors },
  });
}

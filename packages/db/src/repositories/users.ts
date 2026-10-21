import { UserIdSchema, type UserId } from '@pepper/contracts';
import type { Database } from '../client.js';
import { newId } from '../ids.js';
import { users } from '../schema.js';

// People in the app sign up through Better Auth (`authDatabaseAdapter`). This is only for
// seeding worlds that have no sign-up: the eval runner's fixture businesses (ADR-0030).

/** Adds a person who can't sign in (no account), with an address on the reserved test domain. */
export async function insertSeedUser(db: Database, name: string): Promise<UserId> {
  const id = newId();
  await db.insert(users).values({ id, name: name.slice(0, 100), email: `seed-${id}@example.test` });
  return UserIdSchema.parse(id);
}

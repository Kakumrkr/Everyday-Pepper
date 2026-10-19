import { TenantIdSchema, UserIdSchema, type TenantId, type UserId } from '@pepper/contracts';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import { sessions } from '../schema.js';

// Sessions are global (Better Auth owns them, ADR-0012). The active tenant is the only column
// written outside Better Auth, and only after the caller checked the user's membership.

/**
 * Sets the business a session works in (`null` clears it). Matches on the session's user too,
 * so a session id from elsewhere cannot be pointed at another user's session.
 * Returns whether the session was found.
 */
export async function setSessionActiveTenant(
  db: Database,
  session: { id: string; userId: UserId },
  tenantId: TenantId | null,
): Promise<boolean> {
  const activeTenantId = tenantId === null ? null : TenantIdSchema.parse(tenantId);
  const updated = await db
    .update(sessions)
    .set({ activeTenantId })
    .where(
      and(
        eq(sessions.id, z.uuid().parse(session.id)),
        eq(sessions.userId, UserIdSchema.parse(session.userId)),
      ),
    )
    .returning({ id: sessions.id });
  return updated.length === 1;
}

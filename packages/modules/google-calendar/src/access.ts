import type { CalendarSyncError, TenantId } from '@pepper/contracts';
import {
  appendAuditEntry,
  recordCalendarFailure,
  storeAccessToken,
  withTenant,
  type CalendarConnectionRow,
} from '@pepper/db';
import { CalendarProviderError } from './provider.js';
import type { CalendarDeps } from './services.js';
import { openToken, sealToken } from './tokens.js';

// A connection's access token for one piece of work (S70 reads, S71 writes): the stored one while
// it lasts, else a refresh, and one refresh more when Google answers 401. A fresh token is kept
// (sealed) unless the member reconnected meanwhile. No transaction is open across Google's call.

/** An access token this close to its expiry is refreshed before use. */
const EXPIRY_MARGIN_MS = 60_000;

export async function withAccessToken<T>(
  deps: CalendarDeps,
  tenantId: TenantId,
  connection: Pick<
    CalendarConnectionRow,
    'id' | 'generation' | 'refreshTokenSealed' | 'accessTokenSealed' | 'accessTokenExpiresAt'
  >,
  work: (accessToken: string) => Promise<T>,
): Promise<T> {
  const now = deps.clock.now();
  const refreshToken = openToken(
    deps.tokenKey,
    connection.id,
    'refresh',
    connection.refreshTokenSealed,
  );
  let fresh: { accessToken: string; expiresAt: Date } | null = null;
  let access =
    connection.accessTokenSealed !== null &&
    connection.accessTokenExpiresAt !== null &&
    connection.accessTokenExpiresAt.getTime() - EXPIRY_MARGIN_MS > now.getTime()
      ? openToken(deps.tokenKey, connection.id, 'access', connection.accessTokenSealed)
      : null;
  if (access === null) {
    fresh = await deps.provider.refresh(refreshToken);
    access = fresh.accessToken;
  }
  let result: T;
  try {
    result = await work(access);
  } catch (error) {
    // A stored token Google no longer takes: refresh once and try again.
    if (
      !(error instanceof CalendarProviderError) ||
      error.code !== 'unauthorized' ||
      fresh !== null
    ) {
      throw error;
    }
    fresh = await deps.provider.refresh(refreshToken);
    result = await work(fresh.accessToken);
  }
  if (fresh !== null) {
    const kept = fresh;
    await withTenant(deps.db, tenantId, (tx) =>
      storeAccessToken(
        tx,
        connection,
        sealToken(deps.tokenKey, connection.id, 'access', kept.accessToken),
        kept.expiresAt,
      ),
    );
  }
  return result;
}

/**
 * Records a failed call on the connection (AC-X-155, AC-X-170): the error code, and for a refused
 * or unreadable grant the move to "needs reconnecting", audited once. Answers the status after
 * (`undefined`: reconnected or removed meanwhile, so the failure was the old grant's).
 */
export async function recordConnectionFailure(
  deps: Pick<CalendarDeps, 'db'>,
  tenantId: TenantId,
  connection: { id: string; generation: number },
  code: CalendarSyncError,
): Promise<'connected' | 'needs_reconnect' | undefined> {
  return withTenant(deps.db, tenantId, async (tx) => {
    const moved = await recordCalendarFailure(tx, connection, code);
    if (moved !== undefined && moved.before !== moved.after) {
      await appendAuditEntry(tx, {
        actor: { kind: 'system' },
        change: {
          action: 'calendar.connection_changed',
          entity: { type: 'calendar_connection', id: connection.id },
          before: { status: moved.before === 'needs_reconnect' ? 'needs_reconnect' : 'connected' },
          after: { status: moved.after === 'needs_reconnect' ? 'needs_reconnect' : 'connected' },
        },
      });
    }
    if (moved === undefined) return undefined;
    return moved.after === 'needs_reconnect' ? 'needs_reconnect' : 'connected';
  });
}

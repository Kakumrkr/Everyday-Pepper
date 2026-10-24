import type { UnsubscribeResponse } from '@pepper/contracts';
import {
  appendAuditEntry,
  findClient,
  findCurrentTenant,
  optOutClientEmail,
  withTenant,
  type Database,
} from '@pepper/db';
import { systemClock, type Clock } from '../clock.js';
import { UnsubscribeLinkInvalidError } from '../errors.js';
import { readUnsubscribeToken } from '../unsubscribe-token.js';

// One-click unsubscribe (S36, ADR-0040, RFC 8058; playbook D-10): no sign-in. The link is
// checked before anything is read, then the business is worked on without a user. Opting out
// stops rebooking nudges at once (the morning pass skips the client, and a waiting nudge's
// approval re-checks it); booking emails still go. Looking at the page changes nothing (mail
// scanners open links); only the POST unsubscribes.

/** What the page shows for a link: the business, and whether the client is already out. */
export async function describeUnsubscribe(
  db: Database,
  key: Buffer,
  token: string,
): Promise<UnsubscribeResponse> {
  const subject = readUnsubscribeToken(key, token);
  if (subject === null) throw new UnsubscribeLinkInvalidError();
  return withTenant(db, subject.tenantId, async (tx) => {
    const tenant = await findCurrentTenant(tx);
    if (tenant === undefined) throw new UnsubscribeLinkInvalidError();
    const client = await findClient(tx, subject.clientId);
    // A client deleted since gets no email at all.
    return {
      businessName: tenant.name,
      unsubscribed: client?.emailOptOutAt !== null,
    };
  });
}

/** Unsubscribes the client the link names from marketing email (idempotent). */
export async function unsubscribe(
  db: Database,
  key: Buffer,
  token: string,
  options: { clock?: Clock } = {},
): Promise<UnsubscribeResponse> {
  const subject = readUnsubscribeToken(key, token);
  if (subject === null) throw new UnsubscribeLinkInvalidError();
  const now = (options.clock ?? systemClock).now();
  return withTenant(db, subject.tenantId, async (tx) => {
    const tenant = await findCurrentTenant(tx);
    if (tenant === undefined) throw new UnsubscribeLinkInvalidError();
    // The guarded write says whether this click changed anything: two at once audit once.
    const optedOut = await optOutClientEmail(tx, subject.clientId, now);
    if (optedOut?.changed === true) {
      await appendAuditEntry(tx, {
        actor: { kind: 'system' },
        change: {
          action: 'client.email_opted_out',
          entity: { type: 'client', id: subject.clientId },
          before: { emailOptedOut: false },
          after: { emailOptedOut: true },
        },
      });
    }
    return { businessName: tenant.name, unsubscribed: true };
  });
}

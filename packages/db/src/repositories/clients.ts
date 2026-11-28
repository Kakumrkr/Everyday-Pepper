import {
  ClientBirthdaySchema,
  ClientContactSchema,
  ClientIdSchema,
  ClientInputSchema,
  MAX_CLIENT_TAGS,
  RecordSourceSchema,
  type ClientBirthday,
  type ClientContact,
  type ClientFields,
  type ClientId,
  type ClientRecords,
  type RecordSource,
} from '@pepper/contracts';
import { and, asc, desc, eq, ilike, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ClientEmailTakenError, isUniqueViolation } from '../errors.js';
import { newId } from '../ids.js';
import { clients, importRows, type ClientRow } from '../schema.js';
import type { TenantTx } from '../tenant.js';
import { requestInsightRun } from './feed.js';

// The clients of the transaction's tenant (ADR-0017). Run inside `withMember` for a member's
// request: the `member_scope` policies then show staff only the clients they have a booking or
// waitlist entry with, and refuse their writes. A deleted client (S50, ADR-0051) keeps a row
// without their details for their past visits; only `findClientsByIds` (the names on those
// visits) still returns it.

const Id = z.uuid();
const notDeleted = isNull(clients.deletedAt);

/** The name a deleted client's past visits show (ADR-0051). */
export const DELETED_CLIENT_NAME = 'Deleted client';

/** A birthday as the clients table holds it (all NULL for none). */
export function birthdayColumns(birthday: ClientBirthday | null) {
  const value = birthday === null ? null : ClientBirthdaySchema.parse(birthday);
  return {
    birthdayMonth: value?.month ?? null,
    birthdayDay: value?.day ?? null,
    birthdayYear: value?.year ?? null,
  };
}

/** The columns of a client's details; tags and birthday only when given. */
function detailColumns(fields: ClientFields) {
  const parsed = ClientInputSchema.parse(fields);
  return {
    name: parsed.name,
    email: parsed.email,
    phone: parsed.phone,
    ...(parsed.tags === undefined ? {} : { tags: parsed.tags }),
    ...(parsed.birthday === undefined ? {} : birthdayColumns(parsed.birthday)),
  };
}

/** Throws `ClientEmailTakenError` when the business has a client with this email. */
export async function insertClient(
  tx: TenantTx,
  fields: ClientFields & { source: RecordSource },
): Promise<ClientRow> {
  const { source, ...details } = fields;
  const values = { ...detailColumns(details), source: RecordSourceSchema.parse(source) };
  try {
    const [row] = await tx.insert(clients).values(values).returning();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- INSERT ... RETURNING of one row returns one row
    return row!;
  } catch (error) {
    if (isUniqueViolation(error, 'clients_tenant_email_unique')) {
      throw new ClientEmailTakenError({ cause: error });
    }
    throw error;
  }
}

/**
 * Adds a walk-in client for a staff member (S50.2, ADR-0052) through `create_walk_in_client`:
 * staff may not write clients themselves, so the database adds this one only for a staff
 * member of the business, and the commit fails unless the same transaction books them. Returns
 * the new client's id: the staff member sees the client only once the booking is written.
 * Throws `ClientEmailTakenError` when the business has a client with this email.
 */
export async function insertWalkInClient(
  tx: TenantTx,
  fields: Pick<ClientFields, 'name' | 'email' | 'phone'>,
): Promise<ClientId> {
  const { name, email, phone } = ClientInputSchema.parse(fields);
  try {
    const result = await tx.execute<{ id: string }>(
      sql`SELECT create_walk_in_client(${newId()}::uuid, ${name}, ${email}, ${phone}) AS id`,
    );
    return ClientIdSchema.parse(result.rows[0]?.id);
  } catch (error) {
    if (isUniqueViolation(error, 'clients_tenant_email_unique')) {
      throw new ClientEmailTakenError({ cause: error });
    }
    throw error;
  }
}

/**
 * Replaces a client's name, email and phone, and their tags and birthday when given;
 * `undefined` when the transaction may not see the client (or they were deleted). Throws
 * `ClientEmailTakenError` when another client of the business has the email.
 */
export async function updateClient(
  tx: TenantTx,
  id: ClientId,
  fields: ClientFields,
): Promise<ClientRow | undefined> {
  const values = detailColumns(fields);
  try {
    const [row] = await tx
      .update(clients)
      .set(values)
      .where(and(eq(clients.id, Id.parse(id)), notDeleted))
      .returning();
    return row;
  } catch (error) {
    if (isUniqueViolation(error, 'clients_tenant_email_unique')) {
      throw new ClientEmailTakenError({ cause: error });
    }
    throw error;
  }
}

/**
 * Records that the client unsubscribed from marketing email (S36, one-click): the first time
 * stays. Returns the time it holds and whether this call set it (so two clicks at once audit
 * once), or `undefined` for no such client.
 */
export async function optOutClientEmail(
  tx: TenantTx,
  id: ClientId,
  at: Date,
): Promise<{ at: Date; changed: boolean } | undefined> {
  const clientId = Id.parse(id);
  const changed = await tx
    .update(clients)
    .set({ emailOptOutAt: at })
    .where(and(eq(clients.id, clientId), isNull(clients.emailOptOutAt)))
    .returning({ id: clients.id });
  const [row] = await tx
    .select({ at: clients.emailOptOutAt })
    .from(clients)
    .where(eq(clients.id, clientId));
  if (row === undefined || row.at === null) return undefined;
  return { at: row.at, changed: changed.length > 0 };
}

/** The client with this id, if the transaction may see them and they weren't deleted. */
export async function findClient(tx: TenantTx, id: ClientId): Promise<ClientRow | undefined> {
  const [row] = await tx
    .select()
    .from(clients)
    .where(and(eq(clients.id, Id.parse(id)), notDeleted));
  return row;
}

/**
 * The clients with these ids that the transaction may see (at most 200 ids), deleted ones too:
 * the names on visits, where a deleted client is `DELETED_CLIENT_NAME`.
 */
export async function findClientsByIds(
  tx: TenantTx,
  ids: readonly ClientId[],
): Promise<ClientRow[]> {
  if (ids.length === 0) return [];
  const wanted = z.array(Id).max(200).parse(ids);
  return tx.select().from(clients).where(inArray(clients.id, wanted));
}

/** The most clients one exact contact finds (people sharing a phone, e.g. a family). */
export const MAX_CONTACT_MATCHES = 10;

/**
 * Clients whose email or phone is exactly `contact`, by name. Staff see them only when the
 * transaction names the same contact (`setTransactionClientContact`, ADR-0020).
 */
export async function findClientsByContact(
  tx: TenantTx,
  contact: ClientContact,
): Promise<ClientRow[]> {
  const value = ClientContactSchema.parse(contact);
  return tx
    .select()
    .from(clients)
    .where(and(or(eq(clients.email, value), eq(clients.phone, value)), notDeleted))
    .orderBy(asc(sql`lower(${clients.name})`), asc(clients.id))
    .limit(MAX_CONTACT_MATCHES);
}

/** The fewest digits a search needs before it also matches phone numbers (S50.2). */
export const MIN_PHONE_SEARCH_DIGITS = 3;

/**
 * Clients by name, at most `limit`; with `search`, only those whose name or email contains it
 * (case-insensitive; `%` and `_` in it match themselves) or, when it looks like a phone
 * number with at least `MIN_PHONE_SEARCH_DIGITS` digits, whose phone contains those digits; with
 * `after`, those after that client in the same order (S50.2: the order is `lower(name), id`,
 * so equal names neither repeat nor go missing between pages).
 */
export async function listClients(
  tx: TenantTx,
  options: {
    search?: string | undefined;
    limit: number;
    /** Match names only, never email addresses (the AI's lookup, ADR-0029). */
    namesOnly?: boolean;
    /**
     * Only the clients this import created (S49): the import's rows are owners' and managers'
     * only, so for staff the list is empty.
     */
    importBatchId?: string | undefined;
    /** Continue after this client (the last one of the page before). */
    after?: ClientId | undefined;
  },
): Promise<ClientRow[]> {
  const pattern =
    options.search === undefined ? undefined : `%${options.search.replace(/[\\%_]/g, '\\$&')}%`;
  // Only a search that looks like a phone number (digits, spaces, + ( ) - .), so an email
  // search such as "ana2024@" doesn't also list every phone with 2024 in it.
  const phoneLike = options.search !== undefined && /^[+\d\s().-]+$/.test(options.search);
  const digits = phoneLike ? (options.search?.replace(/\D/g, '') ?? '') : '';
  const byPhone =
    digits.length >= MIN_PHONE_SEARCH_DIGITS ? like(clients.phone, `%${digits}%`) : undefined;
  const bySearch =
    pattern === undefined
      ? undefined
      : options.namesOnly === true
        ? ilike(clients.name, pattern)
        : or(ilike(clients.name, pattern), ilike(clients.email, pattern), byPhone);
  const byCursor =
    options.after === undefined
      ? undefined
      : sql`(lower(${clients.name}), ${clients.id}) > (SELECT lower(c.name), c.id FROM ${clients} c WHERE c.id = ${Id.parse(options.after)})`;
  const byImport =
    options.importBatchId === undefined
      ? undefined
      : inArray(
          clients.id,
          tx
            .select({ id: sql<string>`${importRows.clientId}` })
            .from(importRows)
            .where(
              and(
                eq(importRows.batchId, z.uuid().parse(options.importBatchId)),
                eq(importRows.createdClient, true),
              ),
            ),
        );
  return tx
    .select()
    .from(clients)
    .where(and(bySearch, byImport, byCursor, notDeleted))
    .orderBy(asc(sql`lower(${clients.name})`), asc(clients.id))
    .limit(z.number().int().min(1).max(201).parse(options.limit));
}

/**
 * The names of the clients the member may see (the database's member scope: staff, their own),
 * the most recently changed first, at most `limit`: what a misspelt name is compared with
 * (S56a, ADR-0060). Ids and names only.
 */
export async function listClientNames(
  tx: TenantTx,
  limit: number,
): Promise<{ id: string; name: string }[]> {
  return tx
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(notDeleted)
    .orderBy(desc(clients.updatedAt), asc(clients.id))
    .limit(z.number().int().min(1).max(10_000).parse(limit));
}

// Merging and deleting (S50, ADR-0051) ---------------------------------------------------------
// Owners and managers only (the member scope refuses staff's writes; the two database
// functions refuse them too). Each runs in the caller's transaction, which it leaves whole.

/** What a merge would move or a deletion would keep and forget, as of `now`. */
export async function countClientRecords(
  tx: TenantTx,
  id: ClientId,
  now: Date,
): Promise<ClientRecords> {
  const clientId = Id.parse(id);
  const result = await tx.execute<ClientRecords>(sql`
    SELECT
      (SELECT count(*) FROM bookings WHERE client_id = ${clientId}
         AND status = 'confirmed' AND ends_at > ${now.toISOString()}::timestamptz)::int
        AS "upcomingVisits",
      (SELECT count(*) FROM bookings WHERE client_id = ${clientId} AND status <> 'cancelled'
         AND NOT (status = 'confirmed' AND ends_at > ${now.toISOString()}::timestamptz))::int
        AS "pastVisits",
      (SELECT count(*) FROM waitlist_entries WHERE client_id = ${clientId}
         AND status IN ('waiting', 'offered'))::int AS "waitlistEntries",
      (SELECT count(*) FROM memory_facts WHERE client_id = ${clientId})::int AS "notes"`);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- a SELECT without FROM returns one row
  return result.rows[0]!;
}

/** Pending AI proposals about this client (their target names them) expire. */
async function expireProposalsAbout(tx: TenantTx, clientId: string, now: Date): Promise<void> {
  await tx.execute(sql`
    UPDATE ai_action_proposals SET status = 'expired', decided_at = ${now.toISOString()}::timestamptz
    WHERE status = 'pending' AND position(${clientId} IN target_key) > 0`);
}

/** Two clients' active visits that overlap in time (one person can't be in two chairs). */
export async function clientVisitsOverlap(
  tx: TenantTx,
  a: ClientId,
  b: ClientId,
): Promise<boolean> {
  const result = await tx.execute<{ overlap: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM bookings x JOIN bookings y
        ON x.starts_at < y.ends_at AND y.starts_at < x.ends_at
      WHERE x.client_id = ${Id.parse(a)} AND y.client_id = ${Id.parse(b)}
        AND x.status = 'confirmed' AND y.status = 'confirmed') AS overlap`);
  return result.rows[0]?.overlap === true;
}

/** What a merge moved onto the client kept. */
export interface ClientMergeMoved {
  visits: number;
  waitlistEntries: number;
  notes: number;
}

/**
 * Merges `otherId` into `keepId` (ADR-0051): the other's visits, waitlist entries and offers,
 * notes (facts; where both have one under the same key, the kept client's stays and the
 * other's is forgotten as a deleted fact is), episodes, external ids and import rows move to
 * the kept client; their open suggestions go and pending proposals about them expire. Empty
 * email, phone and birthday are filled from the other, tags are combined (at most 20) and an
 * email opt-out from either stays. The other client is then deleted. `undefined` when either
 * isn't there (or was deleted). Check `clientVisitsOverlap` first.
 */
export async function mergeClientRows(
  tx: TenantTx,
  keepId: ClientId,
  otherId: ClientId,
  now: Date,
): Promise<{ row: ClientRow; moved: ClientMergeMoved } | undefined> {
  const keep = Id.parse(keepId);
  const other = Id.parse(otherId);
  if (keep === other) return undefined;
  // Both rows locked, in id order (two merges of the same pair can't deadlock).
  const locked = await tx
    .select()
    .from(clients)
    .where(and(inArray(clients.id, [keep, other]), notDeleted))
    .orderBy(asc(clients.id))
    .for('update');
  const kept = locked.find((row) => row.id === keep);
  const merged = locked.find((row) => row.id === other);
  if (kept === undefined || merged === undefined) return undefined;

  // Notes: the kept client's fact wins a shared key; the rest move (the one move a fact's
  // subject may make, named for the guard trigger in migration 0060).
  // A dropped fact with the kept one's value forgets nothing (the trigger reads the setting).
  await tx.execute(sql`SELECT set_config('pepper.client_merge', ${`${other}>${keep}`}, true)`);
  await tx.execute(sql`
    DELETE FROM memory_facts f
    WHERE f.client_id = ${other} AND f.status = 'active' AND EXISTS (
      SELECT 1 FROM memory_facts k WHERE k.client_id = ${keep} AND k.status = 'active'
        AND k.subject_type = f.subject_type AND k.key = f.key)`);
  const notes = await tx.execute(
    sql`UPDATE memory_facts SET client_id = ${keep} WHERE client_id = ${other}`,
  );
  await tx.execute(sql`SELECT set_config('pepper.client_merge', '', true)`);
  await tx.execute(sql`SELECT client_merge_episodes(${other}::uuid, ${keep}::uuid)`);

  const visits = await tx.execute(
    sql`UPDATE bookings SET client_id = ${keep} WHERE client_id = ${other}`,
  );
  const entries = await tx.execute(
    sql`UPDATE waitlist_entries SET client_id = ${keep} WHERE client_id = ${other}`,
  );
  // A regular is offered a time once (S54, migration 0064): when both were offered the same
  // time as regulars, the unclaimed one goes (the claimed one, if any, holds its booking).
  await tx.execute(sql`
    DELETE FROM waitlist_offers o
    WHERE o.source = 'regular' AND o.status <> 'claimed' AND o.client_id IN (${keep}, ${other})
      AND EXISTS (
        SELECT 1 FROM waitlist_offers k
        WHERE k.source = 'regular' AND k.match_id = o.match_id AND k.id <> o.id
          AND k.client_id IN (${keep}, ${other})
          AND (k.status = 'claimed' OR (o.status <> 'claimed' AND o.client_id = ${other})))`);
  await tx.execute(sql`UPDATE waitlist_offers SET client_id = ${keep} WHERE client_id = ${other}`);
  await tx.execute(sql`DELETE FROM feed_items WHERE client_id = ${other}`);
  await expireProposalsAbout(tx, other, now);
  // The kept client's suggestions are worked out again with both histories (ADR-0039).
  await requestInsightRun(tx);
  await tx.execute(
    sql`UPDATE client_import_refs SET client_id = ${keep} WHERE client_id = ${other}`,
  );
  // Their consent to texts stays the business's record (S61, ADR-0065 §7): it follows them.
  await tx.execute(sql`UPDATE sms_consents SET client_id = ${keep} WHERE client_id = ${other}`);
  // Their own texts and the replies follow them too (S80, ADR-0072).
  await tx.execute(sql`UPDATE client_texts SET client_id = ${keep} WHERE client_id = ${other}`);
  // An import's Undo no longer removes either: the client kept now holds both's history.
  await tx.execute(sql`
    UPDATE import_rows SET client_id = ${keep}, created_client = false
    WHERE client_id IN (${keep}, ${other})`);

  const have = new Set(kept.tags.map((tag) => tag.toLowerCase()));
  const tags = [...kept.tags, ...merged.tags.filter((tag) => !have.has(tag.toLowerCase()))].slice(
    0,
    MAX_CLIENT_TAGS,
  );
  const birthday =
    kept.birthdayMonth === null
      ? {
          birthdayMonth: merged.birthdayMonth,
          birthdayDay: merged.birthdayDay,
          birthdayYear: merged.birthdayYear,
        }
      : {};
  const optOuts = [kept.emailOptOutAt, merged.emailOptOutAt].filter(
    (at): at is Date => at !== null,
  );
  // The other goes first: their email may be the one the kept client takes.
  await tx.delete(clients).where(eq(clients.id, other));
  const [row] = await tx
    .update(clients)
    .set({
      email: kept.email ?? merged.email,
      phone: kept.phone ?? merged.phone,
      tags,
      ...birthday,
      emailOptOutAt:
        optOuts.length === 0 ? null : new Date(Math.min(...optOuts.map((at) => at.getTime()))),
    })
    .where(eq(clients.id, keep))
    .returning();
  if (row === undefined) return undefined;
  return {
    row,
    moved: {
      visits: visits.rowCount ?? 0,
      waitlistEntries: entries.rowCount ?? 0,
      notes: notes.rowCount ?? 0,
    },
  };
}

/**
 * Deletes a client (ADR-0051): `{ upcoming }` while they have upcoming visits (cancel those
 * first), `undefined` when they aren't there. Otherwise every episode naming them, their
 * notes (facts, and those about their visits), suggestions, waitlist entries and offers,
 * external ids, consents to texts, the booking page's remembered browsers and their import rows' details go;
 * their name, email and phone are scrubbed from stored chats; pending proposals about them
 * expire; and the row keeps only `DELETED_CLIENT_NAME`, for their past visits.
 */
export async function deleteClientRow(
  tx: TenantTx,
  id: ClientId,
  now: Date,
): Promise<
  | { deleted: true; pastVisitsKept: number; notesForgotten: number }
  | { deleted: false; upcoming: number }
  | undefined
> {
  const clientId = Id.parse(id);
  const [row] = await tx
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), notDeleted))
    .for('update');
  if (row === undefined) return undefined;
  const records = await countClientRecords(tx, id, now);
  if (records.upcomingVisits > 0) return { deleted: false, upcoming: records.upcomingVisits };

  // Episodes, chats and remembered browsers first: they are found by the details still held.
  await tx.execute(sql`SELECT client_forget(${clientId}::uuid)`);
  await expireProposalsAbout(tx, clientId, now);
  // Each fact's own trigger scrubs its value from the chats (migration 0039).
  const facts = await tx.execute(sql`
    DELETE FROM memory_facts
    WHERE client_id = ${clientId}
       OR booking_id IN (SELECT id FROM bookings WHERE client_id = ${clientId})`);
  await tx.execute(sql`DELETE FROM feed_items WHERE client_id = ${clientId}`);
  await tx.execute(sql`DELETE FROM waitlist_offers WHERE client_id = ${clientId}`);
  await tx.execute(sql`DELETE FROM waitlist_entries WHERE client_id = ${clientId}`);
  await tx.execute(sql`DELETE FROM client_import_refs WHERE client_id = ${clientId}`);
  // Their consent to texts goes with their number (S61, ADR-0065 §7): nothing is texted to them.
  await tx.execute(sql`DELETE FROM sms_consents WHERE client_id = ${clientId}`);
  // Their own texts and the replies go too (S80, ADR-0072, AC-X-235).
  await tx.execute(sql`DELETE FROM client_texts WHERE client_id = ${clientId}`);
  // Their old emails' reschedule/cancel links stop working (ADR-0022).
  await tx.execute(
    sql`UPDATE bookings SET manage_token_hash = NULL WHERE client_id = ${clientId} AND manage_token_hash IS NOT NULL`,
  );
  // Their visits' events in staff members' Google Calendars are written again, without their
  // name (S71, ADR-0069 §10): the trigger on bookings doesn't see a change to the client.
  await tx.execute(sql`
    UPDATE calendar_event_syncs SET version = version + 1, due_at = NULL, attempts = 0
    WHERE booking_id IN (SELECT id FROM bookings WHERE client_id = ${clientId})`);
  // The import keeps its row count, not the person: no details, no link, no matching hash.
  await tx.execute(sql`
    UPDATE import_rows SET cells = NULL, name = NULL, email = NULL, phone = NULL,
      external_id = NULL, reasons = '[]'::jsonb, details = NULL, visit = NULL,
      fills = '{}'::jsonb, row_hash = 'deleted', client_id = NULL, created_client = false
    WHERE client_id = ${clientId}`);
  await tx
    .update(clients)
    .set({
      name: DELETED_CLIENT_NAME,
      email: null,
      phone: null,
      tags: [],
      ...birthdayColumns(null),
      emailOptOutAt: null,
      deletedAt: now,
    })
    .where(eq(clients.id, clientId));
  return {
    deleted: true,
    pastVisitsKept: records.pastVisits,
    notesForgotten: facts.rowCount ?? 0,
  };
}

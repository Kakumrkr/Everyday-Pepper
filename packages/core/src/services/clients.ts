import {
  ClientIdSchema,
  ClientInputSchema,
  ClientLookupSchema,
  ClientMergeSchema,
  ClientSchema,
  ClientsQuerySchema,
  type Client,
  type ClientId,
  type ClientInput,
  type ClientLookup,
  type ClientMerge,
  type ClientRecords,
  type ClientsQuery,
  type RecordSource,
} from '@pepper/contracts';
import {
  appendAuditEntry,
  clientVisitsOverlap,
  countClientRecords,
  deleteClientRow,
  findClient,
  findClientsByContact,
  findClientsByIds,
  insertClient,
  listClients as listClientRows,
  mergeClientRows,
  setTransactionClientContact,
  updateClient as updateClientRow,
  withMember,
  type ClientRow,
  type Database,
  type TenantTx,
} from '@pepper/db';
import { auditActorOf, requirePermission, type Actor } from '../actor.js';
import { systemClock, type Clock } from '../clock.js';
import {
  ClientHasUpcomingVisitsError,
  ClientMergeOverlapError,
  ClientNotFoundError,
} from '../errors.js';

// The business's clients (ADR-0017). `clients.read` reaches every client for owners and
// managers and, for staff, the clients they have a booking or waitlist entry with: the
// database's member scope applies that (AC-W9-1), so staff never see the others at all.
// Anyone with `clients.read` may also find any client by an exact email or phone (ADR-0020),
// so staff can book a returning client of a colleague. `clients.manage` (owners and managers)
// adds, edits, merges and deletes clients (S50, ADR-0051). A client's details are personal
// data: the audit entries record only where the client came from, which details an edit
// changed, and what a merge or deletion moved or kept, as counts.

/**
 * Clients by name; with `search`, those whose name or email contains it; with `import`, those
 * that import created (S49).
 */
export async function listClients(
  db: Database,
  actor: Actor,
  query: ClientsQuery = {},
): Promise<Client[]> {
  requirePermission(actor, 'clients.read');
  const { search, limit, import: importBatchId } = ClientsQuerySchema.parse(query);
  const rows = await withMember(db, actor.context, (tx) =>
    listClientRows(tx, { search, limit, importBatchId }),
  );
  return rows.map(toClient);
}

/**
 * The names of these clients that the member may see, by id, in the caller's transaction (the
 * AI's booking views; a client the member can't see is missing).
 */
export async function clientNamesIn(
  tx: TenantTx,
  actor: Actor,
  ids: readonly ClientId[],
): Promise<Map<ClientId, string>> {
  requirePermission(actor, 'clients.read');
  const rows = await findClientsByIds(tx, [...new Set(ids)]);
  return new Map(rows.map((row) => [ClientIdSchema.parse(row.id), row.name]));
}

/**
 * Clients whose name contains `search`, by name, in the caller's transaction: the AI's lookup
 * matches names only, so it can't be used to test whether an email address is a client's.
 */
export async function findClientsByNameIn(
  tx: TenantTx,
  actor: Actor,
  query: { search: string; limit: number },
): Promise<Client[]> {
  requirePermission(actor, 'clients.read');
  const { search, limit } = ClientsQuerySchema.parse(query);
  const rows = await listClientRows(tx, { search, limit, namesOnly: true });
  return rows.map(toClient);
}

/**
 * The clients with exactly this email or phone, by name (at most `MAX_CONTACT_MATCHES`). Staff
 * find them too, though they have no booking with them yet; never a list of the others.
 */
export async function lookUpClients(
  db: Database,
  actor: Actor,
  lookup: ClientLookup,
): Promise<Client[]> {
  requirePermission(actor, 'clients.read');
  const { contact } = ClientLookupSchema.parse(lookup);
  const rows = await withMember(db, actor.context, async (tx) => {
    await setTransactionClientContact(tx, contact);
    return findClientsByContact(tx, contact);
  });
  return rows.map(toClient);
}

/** One client; `ClientNotFoundError` for an unknown id or another staff member's client. */
export async function getClient(db: Database, actor: Actor, clientId: ClientId): Promise<Client> {
  requirePermission(actor, 'clients.read');
  const id = ClientIdSchema.parse(clientId);
  const row = await withMember(db, actor.context, (tx) => findClient(tx, id));
  if (row === undefined) throw new ClientNotFoundError();
  return toClient(row);
}

/** Adds a client. `ClientEmailTakenError` (from the database) when the email is taken. */
export async function createClient(
  db: Database,
  actor: Actor,
  input: ClientInput,
  options: { source?: RecordSource } = {},
): Promise<Client> {
  requirePermission(actor, 'clients.manage');
  const fields = ClientInputSchema.parse(input);
  const source = options.source ?? 'team';
  return withMember(db, actor.context, async (tx) => {
    const row = await insertClient(tx, { ...fields, source });
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'client.created',
        entity: { type: 'client', id: row.id },
        before: null,
        after: { source },
      },
      requestId: actor.requestId,
    });
    return toClient(row);
  });
}

/**
 * Replaces a client's name, email and phone, and their tags and birthday when given (S50).
 * `ClientNotFoundError` for an unknown id,
 * `ClientEmailTakenError` (from the database) when another client has the email. An edit that
 * changes nothing writes nothing.
 */
export async function updateClient(
  db: Database,
  actor: Actor,
  clientId: ClientId,
  input: ClientInput,
): Promise<Client> {
  requirePermission(actor, 'clients.manage');
  const id = ClientIdSchema.parse(clientId);
  const fields = ClientInputSchema.parse(input);
  return withMember(db, actor.context, async (tx) => {
    const before = await findClient(tx, id);
    if (before === undefined) throw new ClientNotFoundError();
    const changed = changedDetails(before, fields);
    if (changed.length === 0) return toClient(before);
    const row = await updateClientRow(tx, id, fields);
    // The row was just found in this transaction, and only owners and managers write clients.
    if (row === undefined) throw new ClientNotFoundError();
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'client.updated',
        entity: { type: 'client', id },
        before: null,
        after: { changed },
      },
      requestId: actor.requestId,
    });
    return toClient(row);
  });
}

const CLIENT_DETAILS = ['name', 'email', 'phone'] as const;

/** Which details an edit changes; tags and birthday only when given. */
function changedDetails(
  before: ClientRow,
  fields: ReturnType<typeof ClientInputSchema.parse>,
): ('name' | 'email' | 'phone' | 'tags' | 'birthday')[] {
  const changed: ('name' | 'email' | 'phone' | 'tags' | 'birthday')[] = CLIENT_DETAILS.filter(
    (key) => before[key] !== fields[key],
  );
  if (fields.tags !== undefined && fields.tags.join('\n') !== before.tags.join('\n'))
    changed.push('tags');
  if (fields.birthday !== undefined) {
    const was = toClient(before).birthday;
    const now = fields.birthday;
    const same =
      was === null || now === null
        ? was === now
        : was.month === now.month && was.day === now.day && was.year === now.year;
    if (!same) changed.push('birthday');
  }
  return changed;
}

/**
 * What a merge would move or a deletion would keep and forget (S50): the confirm sheets' counts.
 * Owners and managers only.
 */
export async function getClientRecords(
  db: Database,
  actor: Actor,
  clientId: ClientId,
  options: { clock?: Clock } = {},
): Promise<ClientRecords> {
  requirePermission(actor, 'clients.manage');
  const id = ClientIdSchema.parse(clientId);
  const now = (options.clock ?? systemClock).now();
  return withMember(db, actor.context, async (tx) => {
    if ((await findClient(tx, id)) === undefined) throw new ClientNotFoundError();
    return countClientRecords(tx, id, now);
  });
}

/**
 * Merges `otherClientId` into `clientId`, who is kept (ADR-0051): see `mergeClientRows`.
 * `ClientNotFoundError` when either isn't there or they are the same client,
 * `ClientMergeOverlapError` when the two have visits at the same time. Audited on the client
 * kept as `client.merged`, with counts only.
 */
export async function mergeClients(
  db: Database,
  actor: Actor,
  clientId: ClientId,
  merge: ClientMerge,
  options: { clock?: Clock } = {},
): Promise<Client> {
  requirePermission(actor, 'clients.manage');
  const keep = ClientIdSchema.parse(clientId);
  const { otherClientId: other } = ClientMergeSchema.parse(merge);
  if (keep === other) throw new ClientNotFoundError();
  const now = (options.clock ?? systemClock).now();
  return withMember(db, actor.context, async (tx) => {
    // Clients the member can't see have no visits to overlap; the merge then finds no one.
    if (await clientVisitsOverlap(tx, keep, other)) throw new ClientMergeOverlapError();
    const result = await mergeClientRows(tx, keep, other, now);
    if (result === undefined) throw new ClientNotFoundError();
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'client.merged',
        entity: { type: 'client', id: keep },
        before: null,
        after: { mergedClientId: other, moved: result.moved },
      },
      requestId: actor.requestId,
    });
    return toClient(result.row);
  });
}

/**
 * Deletes a client (ADR-0051): see `deleteClientRow`. `ClientNotFoundError` for an unknown id,
 * `ClientHasUpcomingVisitsError` while they have upcoming visits. Audited as `client.deleted`,
 * with counts only.
 */
export async function deleteClient(
  db: Database,
  actor: Actor,
  clientId: ClientId,
  options: { clock?: Clock } = {},
): Promise<void> {
  requirePermission(actor, 'clients.manage');
  const id = ClientIdSchema.parse(clientId);
  const now = (options.clock ?? systemClock).now();
  await withMember(db, actor.context, async (tx) => {
    const result = await deleteClientRow(tx, id, now);
    if (result === undefined) throw new ClientNotFoundError();
    if (!result.deleted) throw new ClientHasUpcomingVisitsError(result.upcoming);
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'client.deleted',
        entity: { type: 'client', id },
        before: null,
        after: { pastVisitsKept: result.pastVisitsKept, notesForgotten: result.notesForgotten },
      },
      requestId: actor.requestId,
    });
  });
}

export function toClient(row: ClientRow): Client {
  return ClientSchema.parse({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    source: row.source,
    tags: row.tags,
    birthday:
      row.birthdayMonth === null || row.birthdayDay === null
        ? null
        : { month: row.birthdayMonth, day: row.birthdayDay, year: row.birthdayYear },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

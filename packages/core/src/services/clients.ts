import {
  ClientIdSchema,
  ClientInputSchema,
  ClientLookupSchema,
  ClientSchema,
  ClientsQuerySchema,
  type Client,
  type ClientId,
  type ClientInput,
  type ClientLookup,
  type ClientsQuery,
  type RecordSource,
} from '@pepper/contracts';
import {
  appendAuditEntry,
  findClient,
  findClientsByContact,
  insertClient,
  listClients as listClientRows,
  setTransactionClientContact,
  updateClient as updateClientRow,
  withMember,
  type ClientRow,
  type Database,
} from '@pepper/db';
import { requirePermission, type Actor } from '../actor.js';
import { ClientNotFoundError } from '../errors.js';

// The business's clients (ADR-0017). `clients.read` reaches every client for owners and
// managers and, for staff, the clients they have a booking or waitlist entry with: the
// database's member scope applies that (AC-W9-1), so staff never see the others at all.
// Anyone with `clients.read` may also find any client by an exact email or phone (ADR-0020),
// so staff can book a returning client of a colleague. `clients.manage` (owners and managers)
// adds and edits clients. A client's details are personal data: the audit entries record only
// where the client came from and which details an edit changed.

/** Clients by name; with `search`, those whose name or email contains it. */
export async function listClients(
  db: Database,
  actor: Actor,
  query: ClientsQuery = {},
): Promise<Client[]> {
  requirePermission(actor, 'clients.read');
  const { search, limit } = ClientsQuerySchema.parse(query);
  const rows = await withMember(db, actor.context, (tx) => listClientRows(tx, { search, limit }));
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
      actor: { kind: 'user', userId: actor.context.userId },
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
 * Replaces a client's name, email and phone. `ClientNotFoundError` for an unknown id,
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
    const changed = CLIENT_DETAILS.filter((key) => before[key] !== fields[key]);
    if (changed.length === 0) return toClient(before);
    const row = await updateClientRow(tx, id, fields);
    // The row was just found in this transaction, and only owners and managers write clients.
    if (row === undefined) throw new ClientNotFoundError();
    await appendAuditEntry(tx, {
      actor: { kind: 'user', userId: actor.context.userId },
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

export function toClient(row: ClientRow): Client {
  return ClientSchema.parse({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

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
// adds clients. A client's details are personal data: the audit entry records only where the
// client came from.

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

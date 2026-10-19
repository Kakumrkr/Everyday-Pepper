import {
  ClientContactSchema,
  ClientInputSchema,
  RecordSourceSchema,
  type ClientContact,
  type ClientFields,
  type ClientId,
  type RecordSource,
} from '@pepper/contracts';
import { asc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ClientEmailTakenError, isUniqueViolation } from '../errors.js';
import { clients, type ClientRow } from '../schema.js';
import type { TenantTx } from '../tenant.js';

// The clients of the transaction's tenant (ADR-0017). Run inside `withMember` for a member's
// request: the `member_scope` policies then show staff only the clients they have a booking or
// waitlist entry with, and refuse their writes.

const Id = z.uuid();

/** Throws `ClientEmailTakenError` when the business has a client with this email. */
export async function insertClient(
  tx: TenantTx,
  fields: ClientFields & { source: RecordSource },
): Promise<ClientRow> {
  const values = {
    ...ClientInputSchema.parse({ name: fields.name, email: fields.email, phone: fields.phone }),
    source: RecordSourceSchema.parse(fields.source),
  };
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
 * Replaces a client's name, email and phone; `undefined` when the transaction may not see the
 * client. Throws `ClientEmailTakenError` when another client of the business has the email.
 */
export async function updateClient(
  tx: TenantTx,
  id: ClientId,
  fields: ClientFields,
): Promise<ClientRow | undefined> {
  const values = ClientInputSchema.parse({
    name: fields.name,
    email: fields.email,
    phone: fields.phone,
  });
  try {
    const [row] = await tx
      .update(clients)
      .set(values)
      .where(eq(clients.id, Id.parse(id)))
      .returning();
    return row;
  } catch (error) {
    if (isUniqueViolation(error, 'clients_tenant_email_unique')) {
      throw new ClientEmailTakenError({ cause: error });
    }
    throw error;
  }
}

/** The client with this id, if the transaction may see them. */
export async function findClient(tx: TenantTx, id: ClientId): Promise<ClientRow | undefined> {
  const [row] = await tx
    .select()
    .from(clients)
    .where(eq(clients.id, Id.parse(id)));
  return row;
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
    .where(or(eq(clients.email, value), eq(clients.phone, value)))
    .orderBy(asc(sql`lower(${clients.name})`), asc(clients.id))
    .limit(MAX_CONTACT_MATCHES);
}

/**
 * Clients by name, at most `limit`; with `search`, only those whose name or email contains it
 * (case-insensitive; `%` and `_` in it match themselves).
 */
export async function listClients(
  tx: TenantTx,
  options: { search?: string | undefined; limit: number },
): Promise<ClientRow[]> {
  const pattern =
    options.search === undefined ? undefined : `%${options.search.replace(/[\\%_]/g, '\\$&')}%`;
  return tx
    .select()
    .from(clients)
    .where(
      pattern === undefined
        ? undefined
        : or(ilike(clients.name, pattern), ilike(clients.email, pattern)),
    )
    .orderBy(asc(sql`lower(${clients.name})`), asc(clients.id))
    .limit(z.number().int().min(1).max(200).parse(options.limit));
}

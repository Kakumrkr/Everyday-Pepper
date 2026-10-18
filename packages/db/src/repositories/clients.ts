import {
  ClientInputSchema,
  RecordSourceSchema,
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

/** The client with this id, if the transaction may see them. */
export async function findClient(tx: TenantTx, id: ClientId): Promise<ClientRow | undefined> {
  const [row] = await tx
    .select()
    .from(clients)
    .where(eq(clients.id, Id.parse(id)));
  return row;
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

import type { ClientContact, ClientId } from '@pepper/contracts';
import { ClientNotFoundError } from '@pepper/core';
import { findClient, setTransactionClientContact, type ClientRow, type TenantTx } from '@pepper/db';

/**
 * The client a booking or waitlist entry is for, as the member may see them. With `contact`
 * (the exact email or phone staff found the client by, ADR-0020) staff reach that client too,
 * though they have no booking with them yet. `ClientNotFoundError` otherwise.
 */
export async function findClientToBook(
  tx: TenantTx,
  clientId: ClientId,
  contact: ClientContact | undefined,
): Promise<ClientRow> {
  if (contact !== undefined) await setTransactionClientContact(tx, contact);
  const client = await findClient(tx, clientId);
  if (client === undefined) throw new ClientNotFoundError();
  return client;
}

import { hasActivation, isBusinessBookable, recordActivation, type TenantTx } from '@pepper/db';

// Activation events of the appointments module (S45, ADR-0046, AC-W1-10), written in the
// transaction of the change that caused them, so an event exists if and only if it committed.

/**
 * Records `bookable` the first time the business has an active service offered by an active
 * staff member with hours. After a change to services, staff or hours; once recorded, one
 * indexed lookup.
 */
export async function noteBookableIn(tx: TenantTx): Promise<void> {
  if (await hasActivation(tx, 'bookable')) return;
  if (await isBusinessBookable(tx)) await recordActivation(tx, 'bookable');
}

/** Records `first_booking` with the business's first booking (by staff, the AI or a client). */
export async function noteFirstBookingIn(tx: TenantTx): Promise<void> {
  await recordActivation(tx, 'first_booking');
}

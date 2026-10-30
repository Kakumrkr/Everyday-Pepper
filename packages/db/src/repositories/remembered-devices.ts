import { ClientEmailSchema } from '@pepper/contracts';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { rememberedDevices, type RememberedDevice } from '../schema.js';
import type { TenantTx } from '../tenant.js';

// Remembered devices (S47, ADR-0047, AC-W8-8): the booking page's, in the business of the
// transaction (`withPublicTenant`). Only the token's hash is passed in or kept.

const HASH = /^[0-9a-f]{64}$/;

function tokenHashOf(hash: string): string {
  if (!HASH.test(hash)) throw new RangeError('A device token hash is 64 hex characters');
  return hash;
}

/** Remembers a device for `email` until `expiresAt`; clears the business's expired ones. */
export async function insertRememberedDevice(
  tx: TenantTx,
  device: { email: string; tokenHash: string; expiresAt: Date; now: Date },
): Promise<RememberedDevice> {
  await tx
    .delete(rememberedDevices)
    .where(
      and(
        eq(rememberedDevices.tenantId, sql`current_tenant_id()`),
        lte(rememberedDevices.expiresAt, device.now),
      ),
    );
  const [row] = await tx
    .insert(rememberedDevices)
    .values({
      email: ClientEmailSchema.parse(device.email),
      tokenHash: tokenHashOf(device.tokenHash),
      expiresAt: device.expiresAt,
      lastUsedAt: device.now,
    })
    .returning();
  if (row === undefined) throw new Error('The remembered device was not stored');
  return row;
}

/**
 * Uses the device with this token hash for `email`, if the business remembers it for that
 * address and it has not expired: moves its expiry to `expiresAt` and returns it.
 */
export async function useRememberedDevice(
  tx: TenantTx,
  device: { email: string; tokenHash: string; expiresAt: Date; now: Date },
): Promise<RememberedDevice | undefined> {
  const [row] = await tx
    .update(rememberedDevices)
    .set({ expiresAt: device.expiresAt, lastUsedAt: device.now })
    .where(
      and(
        eq(rememberedDevices.tenantId, sql`current_tenant_id()`),
        eq(rememberedDevices.tokenHash, tokenHashOf(device.tokenHash)),
        eq(rememberedDevices.email, ClientEmailSchema.parse(device.email)),
        gt(rememberedDevices.expiresAt, device.now),
      ),
    )
    .returning();
  return row;
}

/** Forgets the device with this token hash in the business; whether there was one. */
export async function deleteRememberedDevice(tx: TenantTx, tokenHash: string): Promise<boolean> {
  const rows = await tx
    .delete(rememberedDevices)
    .where(
      and(
        eq(rememberedDevices.tenantId, sql`current_tenant_id()`),
        eq(rememberedDevices.tokenHash, tokenHashOf(tokenHash)),
      ),
    )
    .returning({ id: rememberedDevices.id });
  return rows.length > 0;
}

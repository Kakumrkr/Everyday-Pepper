import { createHash, randomBytes } from 'node:crypto';
import {
  BookingFunnelEventInputSchema,
  DeviceTokenSchema,
  REMEMBERED_DEVICE_DAYS,
  TenantSlugSchema,
  type BookingFunnelCounts,
  type BookingFunnelEventInput,
  type DeviceToken,
  type TenantSlug,
} from '@pepper/contracts';
import { requirePermission, type Actor } from '@pepper/core';
import {
  countFunnelSteps,
  deleteRememberedDevice,
  insertRememberedDevice,
  recordFunnelStep,
  useRememberedDevice,
  withPublicTenant,
  withTenant,
  type Database,
  type TenantTx,
} from '@pepper/db';

// Remembered devices and the booking funnel (S47, ADR-0047). A device the client asked the
// page to remember skips the code for the same email at the same business (AC-W8-8): the
// emailed code proved the address once, and the token (256 random bits in an httpOnly
// cookie, only its hash stored) proves the same browser since. Every use moves the 90 days
// on. The funnel counts which steps visits entered (AC-W8-9), with nothing about the client.

const DAY_MS = 86_400_000;

/** SHA-256 (hex) of a device token: 256 random bits need no key or slow hash (as links). */
export function deviceTokenHash(token: DeviceToken): string {
  return createHash('sha256').update(DeviceTokenSchema.parse(token)).digest('hex');
}

function expiryFrom(now: Date): Date {
  return new Date(now.getTime() + REMEMBERED_DEVICE_DAYS * DAY_MS);
}

/** Remembers this browser for `email` in the transaction's business; the new secret. */
export async function rememberDeviceIn(
  tx: TenantTx,
  email: string,
  now: Date,
): Promise<{ token: DeviceToken; expiresAt: Date }> {
  const token = DeviceTokenSchema.parse(randomBytes(32).toString('base64url'));
  const expiresAt = expiryFrom(now);
  await insertRememberedDevice(tx, { email, tokenHash: deviceTokenHash(token), expiresAt, now });
  return { token, expiresAt };
}

/**
 * Whether `token` is a device the transaction's business remembers for `email` and that has
 * not expired; if so, its 90 days start again. A malformed token is simply not remembered.
 */
export async function recognizeDeviceIn(
  tx: TenantTx,
  token: string | undefined,
  email: string,
  now: Date,
): Promise<boolean> {
  const parsed = DeviceTokenSchema.safeParse(token);
  if (!parsed.success) return false;
  const used = await useRememberedDevice(tx, {
    email,
    tokenHash: deviceTokenHash(parsed.data),
    expiresAt: expiryFrom(now),
    now,
  });
  return used !== undefined;
}

/** "Forget this device": the business at `slug` stops remembering it (nothing when unknown). */
export async function forgetDevice(
  db: Database,
  slug: TenantSlug,
  token: string | undefined,
): Promise<void> {
  const parsedSlug = TenantSlugSchema.safeParse(slug);
  const parsed = DeviceTokenSchema.safeParse(token);
  if (!parsedSlug.success || !parsed.success) return;
  await withPublicTenant(db, parsedSlug.data, (tx) =>
    deleteRememberedDevice(tx, deviceTokenHash(parsed.data)),
  );
}

/**
 * Records that a visit to the page at `slug` entered a step, once per visit and step. An
 * unknown page records nothing; the caller never lets a failure here stop a booking.
 */
export async function recordBookingStep(
  db: Database,
  slug: TenantSlug,
  event: BookingFunnelEventInput,
): Promise<void> {
  const parsedSlug = TenantSlugSchema.safeParse(slug);
  const parsed = BookingFunnelEventInputSchema.parse(event);
  if (!parsedSlug.success) return;
  await withPublicTenant(db, parsedSlug.data, (tx) => recordFunnelStep(tx, parsed));
}

/** How many visits to the actor's booking page entered each step in [from, to). */
export async function getBookingFunnel(
  db: Database,
  actor: Actor,
  range: { from: Date; to: Date },
): Promise<BookingFunnelCounts> {
  requirePermission(actor, 'settings.manage');
  return withTenant(db, actor.context.tenantId, (tx) => countFunnelSteps(tx, range));
}

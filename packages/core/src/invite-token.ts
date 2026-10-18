import { createHash, randomBytes } from 'node:crypto';
import { InviteTokenSchema, type InviteToken } from '@pepper/contracts';

/** A new invite token: 32 random bytes, base64url (ADR-0014). */
export function newInviteToken(): InviteToken {
  return InviteTokenSchema.parse(randomBytes(32).toString('base64url'));
}

/**
 * The stored form of a token: SHA-256, hex. The token is 256 random bits, so a fast hash is
 * enough: there is nothing to guess, and a leaked table reveals no working link.
 */
export function hashInviteToken(token: InviteToken): string {
  return createHash('sha256').update(InviteTokenSchema.parse(token)).digest('hex');
}

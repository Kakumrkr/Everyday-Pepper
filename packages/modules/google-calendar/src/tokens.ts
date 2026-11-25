import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

// Sealed tokens (S70, ADR-0069 §4): AES-256-GCM under a key derived from the outbox key for this
// purpose only, bound to the connection (or connect state) id, so a sealed token copied to
// another row does not open. Layout: version (1 byte), IV (12), tag (16), ciphertext.

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

/** The 32-byte key for Google tokens, from the 32-byte outbox key (`outboxKeyFrom`). */
export function calendarTokenKeyFrom(outboxKey: Buffer): Buffer {
  if (outboxKey.length !== 32) throw new RangeError('The outbox key must be 32 bytes');
  return Buffer.from(hkdfSync('sha256', outboxKey, '', 'pepper/google-calendar-tokens', 32));
}

/** Thrown when a sealed token cannot be opened: wrong key, another row, or tampering. */
export class SealedTokenError extends Error {
  override readonly name = 'SealedTokenError';

  constructor() {
    super('The sealed token cannot be opened');
  }
}

function aad(rowId: string, purpose: string): Buffer {
  return Buffer.from(`pepper/google-calendar/${purpose}/${rowId}`, 'utf8');
}

export function sealToken(key: Buffer, rowId: string, purpose: string, token: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(rowId, purpose));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function openToken(key: Buffer, rowId: string, purpose: string, sealed: Buffer): string {
  if (sealed.length < HEADER_BYTES || sealed[0] !== VERSION) throw new SealedTokenError();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(1, 1 + IV_BYTES));
    decipher.setAAD(aad(rowId, purpose));
    decipher.setAuthTag(sealed.subarray(1 + IV_BYTES, HEADER_BYTES));
    return Buffer.concat([
      decipher.update(sealed.subarray(HEADER_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SealedTokenError();
  }
}

/** 32 random bytes as base64url (43 characters): a connect's state, or a PKCE verifier. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What is stored for a state: its SHA-256, never the state. */
export function stateHashOf(state: string): Buffer {
  return createHash('sha256').update(state, 'utf8').digest();
}

/** PKCE's S256 challenge for a verifier (RFC 7636). */
export function codeChallengeOf(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

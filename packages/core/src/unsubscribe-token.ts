import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import {
  ClientIdSchema,
  TenantIdSchema,
  UnsubscribeTokenSchema,
  type ClientId,
  type TenantId,
  type UnsubscribeToken,
} from '@pepper/contracts';

// One-click unsubscribe links (S36, ADR-0040, RFC 8058): the link names the business and the
// client and is signed, so it needs no sign-in, no stored token and no lookup before it is
// checked. It never expires (a client may unsubscribe from an old email), and it does nothing
// but stop marketing email to that client.

const VERSION = 1;
const MAC_BYTES = 16;
const uuidBytes = (id: string) => Buffer.from(id.replaceAll('-', ''), 'hex');
const uuidOf = (bytes: Buffer) => {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** The unsubscribe links' signing key, from the outbox key (`outboxKeyFrom(OUTBOX_SECRET)`). */
export function unsubscribeKeyFrom(outboxKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', outboxKey, '', 'pepper/unsubscribe-links', 32));
}

function mac(key: Buffer, body: Buffer): Buffer {
  return createHmac('sha256', key).update(body).digest().subarray(0, MAC_BYTES);
}

/** The link's secret for this client of this business. */
export function unsubscribeToken(
  key: Buffer,
  subject: { tenantId: TenantId; clientId: ClientId },
): UnsubscribeToken {
  const body = Buffer.concat([
    Buffer.from([VERSION]),
    uuidBytes(TenantIdSchema.parse(subject.tenantId)),
    uuidBytes(ClientIdSchema.parse(subject.clientId)),
  ]);
  return UnsubscribeTokenSchema.parse(Buffer.concat([body, mac(key, body)]).toString('base64url'));
}

/** The business and client a link names, or `null` for one this key did not sign. */
export function readUnsubscribeToken(
  key: Buffer,
  token: string,
): { tenantId: TenantId; clientId: ClientId } | null {
  if (!UnsubscribeTokenSchema.safeParse(token).success) return null;
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length !== 33 + MAC_BYTES || bytes[0] !== VERSION) return null;
  const body = bytes.subarray(0, 33);
  if (!timingSafeEqual(mac(key, body), bytes.subarray(33))) return null;
  return {
    tenantId: TenantIdSchema.parse(uuidOf(body.subarray(1, 17))),
    clientId: ClientIdSchema.parse(uuidOf(body.subarray(17, 33))),
  };
}

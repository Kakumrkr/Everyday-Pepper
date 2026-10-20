import { z } from 'zod';

// Web Push for the installed app (ADR-0026). A member turns notifications on for a device:
// the browser subscribes with the deployment's public VAPID key and the app saves the
// subscription for the active business. The worker sends each push encrypted to the device's
// keys and signed with the private VAPID key.

/**
 * The browsers' push services (Chrome and Android, Firefox, Safari, Edge): a device endpoint
 * must be on one of them, so a member cannot make the worker send requests anywhere else
 * (S21 security review: the worker POSTs to the endpoint a member saved).
 */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
  '.notify.windows.com',
];

/** Whether `endpoint` is an https URL on a known push service (no port, no credentials). */
export function isPushServiceEndpoint(endpoint: string): boolean {
  if (!URL.canParse(endpoint)) return false;
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    return false;
  }
  return PUSH_SERVICE_HOSTS.some((host) =>
    host.startsWith('.') ? url.hostname.endsWith(host) : url.hostname === host,
  );
}

/** A base64url string, as the browser's `PushSubscription.toJSON()` gives the keys. */
const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, 'Expected base64url');

/**
 * `PUT /v1/push/subscription`: the browser's subscription (`PushSubscription.toJSON()`); the
 * expiration time it may carry is ignored.
 */
export const PushSubscriptionInputSchema = z.object({
  endpoint: z
    .url({ protocol: /^https$/ })
    .max(1000)
    .refine(isPushServiceEndpoint, 'Not a known push service'),
  expirationTime: z.number().nullable().optional(),
  keys: z
    .object({
      // An uncompressed P-256 public key (65 bytes) and a 16-byte secret.
      p256dh: Base64UrlSchema.min(80).max(100),
      auth: Base64UrlSchema.min(16).max(32),
    })
    .strict(),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInputSchema>;

/** `DELETE /v1/push/subscription` and `POST /v1/push/subscription/status`: which device. */
export const PushEndpointSchema = z
  .object({ endpoint: z.url({ protocol: /^https$/ }).max(1000) })
  .strict();
export type PushEndpoint = z.infer<typeof PushEndpointSchema>;

/** `POST /v1/push/subscription/status`: whether this device gets this business's pushes. */
export const PushStatusResponseSchema = z.object({ subscribed: z.boolean() });
export type PushStatusResponse = z.infer<typeof PushStatusResponseSchema>;

/** `GET /v1/push/key`: the public VAPID key, or `null` when this deployment sends no pushes. */
export const PushKeyResponseSchema = z.object({ publicKey: Base64UrlSchema.nullable() });
export type PushKeyResponse = z.infer<typeof PushKeyResponseSchema>;

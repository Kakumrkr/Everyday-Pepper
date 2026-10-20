import { z } from 'zod';

// Web Push for the installed app (ADR-0026). A member turns notifications on for a device:
// the browser subscribes with the deployment's public VAPID key and the app saves the
// subscription for the active business. The worker sends each push encrypted to the device's
// keys and signed with the private VAPID key.

/** A base64url string, as the browser's `PushSubscription.toJSON()` gives the keys. */
const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, 'Expected base64url');

/**
 * `PUT /v1/push/subscription`: the browser's subscription (`PushSubscription.toJSON()`); the
 * expiration time it may carry is ignored.
 */
export const PushSubscriptionInputSchema = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(1000),
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

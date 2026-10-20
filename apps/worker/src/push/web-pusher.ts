import { isPushServiceEndpoint } from '@pepper/contracts';
import { PushRejectedError, type PushMessage, type Pusher } from '@pepper/core';
import type { PushConfig } from '@pepper/runtime';
import webpush from 'web-push';

/** How long one request to a push service may take. */
const TIMEOUT_MS = 10_000;

/**
 * Sends Web Push messages (ADR-0026): `web-push` builds each request (payload encrypted to
 * the device per RFC 8291, `aes128gcm`; a VAPID JWT signed with our private key), and the
 * request goes out with `fetch`, so it takes the process's proxy and timeout like any other
 * call. A push service's refusal is a `PushRejectedError` with its status (404/410: the
 * device is gone). Never logs the endpoint or the content.
 */
export class WebPusher implements Pusher {
  constructor(
    private readonly config: PushConfig,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async send(message: PushMessage): Promise<void> {
    // Checked when the device was saved; checked again, as nothing else may be called.
    if (!isPushServiceEndpoint(message.endpoint)) throw new PushEndpointNotAllowedError();
    const details = webpush.generateRequestDetails(
      { endpoint: message.endpoint, keys: message.keys },
      message.payload,
      {
        vapidDetails: {
          subject: this.config.subject,
          publicKey: this.config.publicKey,
          privateKey: this.config.privateKey,
        },
        TTL: message.ttlSeconds,
        contentEncoding: 'aes128gcm',
        urgency: 'normal',
        ...(message.topic !== undefined && { topic: message.topic }),
      },
    );
    const response = await this.fetch(details.endpoint, {
      method: details.method,
      headers: details.headers,
      body: details.body,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Drain the body so the connection can be reused; push services answer briefly.
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) throw new PushRejectedError(response.status);
  }
}

/**
 * A device endpoint that is not a known push service: never called. A refusal for good
 * (like a push service's 400), so the outbox gives up on it and alerts.
 */
export class PushEndpointNotAllowedError extends PushRejectedError {
  constructor() {
    super(400);
    this.name = 'PushEndpointNotAllowedError';
    this.message = 'The device endpoint is not a known push service';
  }
}

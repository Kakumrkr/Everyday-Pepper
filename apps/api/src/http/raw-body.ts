import type { IncomingMessage } from 'node:http';
import { apiError } from '../auth/guards.js';
import { PayloadTooLargeError, UnsupportedMediaTypeError } from './domain-errors.js';

/** Content types an upload may be sent as; what the bytes really are is decided later. */
const UPLOAD_TYPE = /^(image\/[a-z0-9.+-]+|application\/octet-stream)(;|$)/i;

/**
 * Reads a raw upload body (ADR-0048) of at most `maxBytes`: refused before reading when its
 * `Content-Length` says more (413 `photo_too_large`), and stopped as soon as it grows past it
 * (a missing or false length can't get by). A body the JSON parser took, or one sent as
 * another type, is 415 `photo_rejected`.
 */
export async function readUpload(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const type = request.headers['content-type'] ?? '';
  if (!UPLOAD_TYPE.test(type) || request.readableEnded) {
    throw new UnsupportedMediaTypeError({
      ...apiError('photo_rejected'),
      message: 'Send the photo itself (JPEG, PNG or WebP).',
      reason: 'unsupported_type',
    });
  }
  const tooLarge = () => new PayloadTooLargeError(apiError('photo_too_large'));
  if (Number(request.headers['content-length'] ?? 0) > maxBytes) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += part.byteLength;
    if (size > maxBytes) {
      // Stop reading: the rest is not wanted, and the answer goes out at once.
      request.unpipe();
      request.resume();
      throw tooLarge();
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks, size);
}

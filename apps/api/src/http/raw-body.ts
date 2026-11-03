import type { IncomingMessage } from 'node:http';
import { apiError } from '../auth/guards.js';
import { PayloadTooLargeError, UnsupportedMediaTypeError } from './domain-errors.js';

/** What an upload endpoint takes, and how it refuses the rest. */
export interface UploadKind {
  /** Content types the body may be sent as; what the bytes really are is decided later. */
  types: RegExp;
  /** 415 for a body sent as another type (or taken by the JSON parser). */
  rejected: () => Error;
  /** 413 for a body over the limit. */
  tooLarge: () => Error;
}

/** A booking page photo (ADR-0048). */
export const PHOTO_UPLOAD: UploadKind = {
  types: /^(image\/[a-z0-9.+-]+|application\/octet-stream)(;|$)/i,
  rejected: () =>
    new UnsupportedMediaTypeError({
      ...apiError('photo_rejected'),
      message: 'Send the photo itself (JPEG, PNG or WebP).',
      reason: 'unsupported_type',
    }),
  tooLarge: () => new PayloadTooLargeError(apiError('photo_too_large')),
};

/**
 * A client export (S48, ADR-0049): CSV or JSONL as text, or any file as bytes. JSON is sent as
 * `application/octet-stream` or `text/plain` (an `application/json` body is the JSON parser's).
 */
export const IMPORT_UPLOAD: UploadKind = {
  types:
    /^(text\/(csv|plain|tab-separated-values)|application\/(octet-stream|x-ndjson|jsonl|x-jsonlines|vnd\.ms-excel))(;|$)/i,
  rejected: () =>
    new UnsupportedMediaTypeError({
      ...apiError('import_rejected'),
      message:
        'Send the file itself (CSV, JSON or JSONL), as text/csv or application/octet-stream.',
      reason: 'unsupported_type',
    }),
  tooLarge: () => new PayloadTooLargeError(apiError('import_too_large')),
};

/**
 * Reads a raw upload body of at most `maxBytes`: refused before reading when its
 * `Content-Length` says more (413), and stopped as soon as it grows past it (a missing or
 * false length can't get by). A body the JSON parser took, or one sent as another type, is 415.
 */
export async function readUpload(
  request: IncomingMessage,
  maxBytes: number,
  kind: UploadKind = PHOTO_UPLOAD,
): Promise<Buffer> {
  const type = request.headers['content-type'] ?? '';
  if (!kind.types.test(type) || request.readableEnded) throw kind.rejected();
  if (Number(request.headers['content-length'] ?? 0) > maxBytes) throw kind.tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  // Not destroyed on the early exit below, so the 413 still reaches the client.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += part.byteLength;
    if (size > maxBytes) {
      // The rest is drained unread, and the answer goes out at once.
      request.resume();
      throw kind.tooLarge();
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks, size);
}
